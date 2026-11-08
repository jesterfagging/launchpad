// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchTypes, ILaunchFeeEscrow, ILaunchFactory, ILaunchLocker} from "./interfaces/ILaunch.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IPoolManager, IUnlockCallback, PoolKey, ModifyLiquidityParams, SwapParams} from "./interfaces/IUniswapV4.sol";
import {SafeTransfer} from "./lib/SafeTransfer.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";
import {CurveMath} from "./lib/CurveMath.sol";
import {V4Math} from "./lib/V4Math.sol";

/// @title LaunchLocker
/// @notice Holds every Launchpad coin's Uniswap v4 liquidity. A launch (v71.41, pool-native) puts its whole supply into
/// the coin's *curve pool* as two one-sided positions: the *curve* position — the sell supply between the tier's
/// start price and its graduation price, which is exactly the bonding curve as a concentrated range (the same raise,
/// the same price path) — and the *upper* position, the rest of the supply from the graduation price upwards, so the
/// market never pauses. When the price crosses the graduation tick, `graduate` collects the curve pool's last fees
/// and moves everything the positions hold (the raise and the remaining supply) into the *graduation pool* — the
/// same pair at the post-graduation fee, opened by the factory at launch — as one full-range position (plus a
/// one-sided sliver for whatever the price's rounding leaves over), at the price the curve pool had. That is the
/// shape a Raydium launch takes at migration, with the fee of the stage.
///
/// Nothing here hands liquidity or assets to anyone: there is no function that sends either to an address, no
/// transfer, no owner and no upgrade path. Before graduation the liquidity can only travel into the graduation pool
/// (`graduate`, which anyone may call once the price is past the tick); after it, nothing moves it at all. The only
/// other thing anyone can do is `collect`: take the LP fees the positions earned (a liquidity change of zero), turn
/// the coin-side fees into the pair asset through the pool itself, and credit the platform and the coin's creator
/// fee recipient in the escrow with the split of the stage the fees were earned in. The Launchpad host calls both on its
/// passes; anyone may.
contract LaunchLocker is ILaunchLocker, IUnlockCallback, ReentrancyGuard {
    using SafeTransfer for address;
    using CurveMath for uint256;

    error NotFactory();
    error NotPoolManager();
    error AlreadyLocked(address token);
    error UnknownToken(address token);
    error NothingToLock();
    error UnknownAction(uint8 action);
    error NotCrossed(int24 tick, int24 graduationTick);
    error AlreadyGraduated(address token);

    event Locked(address indexed token, bytes32 indexed poolId, int24 startTick, int24 graduationTick, uint128 curveLiquidity, uint128 upperLiquidity, uint256 tokensLocked, uint256 dustBurned);
    event FeesCollected(address indexed token, uint256 quote, uint256 coinsSold, uint256 creator, uint256 platform);
    event Graduated(address indexed token, bytes32 indexed curvePoolId, bytes32 indexed poolId, int24 tick, uint160 sqrtPriceX96, uint128 liquidity, uint256 quoteMoved, uint256 coinsMoved);

    struct Position {
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
    }

    struct Launch {
        PoolKey key; // the pool the coin trades in now
        bytes32 poolId;
        bytes32 curvePoolId; // the pool it started in
        uint24 graduationFee; // the graduation pool's fee
        bool tokenIs0; // the coin is currency0 (its price in the pair asset rises with the tick) or currency1 (it falls)
        int24 startTick; // the curve pool's tick at launch
        int24 graduationTick; // crossed = graduated
        Position[] positions; // locked now: [curve, upper] before graduation; [full range, a leftover sliver] after
        uint64 lockedAt;
        uint64 graduatedAt;
    }

    uint8 internal constant ACTION_LOCK = 1;
    uint8 internal constant ACTION_COLLECT = 2;
    uint8 internal constant ACTION_GRADUATE = 3;

    ILaunchFactory public immutable factory;
    IPoolManager public immutable poolManager;
    ILaunchFeeEscrow public immutable escrow;
    mapping(address token => Launch) internal _launches;

    constructor(address factory_) {
        factory = ILaunchFactory(factory_);
        poolManager = IPoolManager(factory.poolManager());
        escrow = ILaunchFeeEscrow(factory.escrow());
    }

    /// @dev Native ETH arrives from the pool manager (`take`); nothing else sends here.
    receive() external payable {}

    function launchOf(address token) external view returns (Launch memory) { return _launches[token]; }
    function graduated(address token) external view returns (bool) { return _launches[token].graduatedAt != 0; }

    /// @inheritdoc ILaunchLocker
    function poolKeyOf(address token) external view override returns (PoolKey memory key, bool tokenIs0) {
        Launch storage l = _launches[token];
        if (l.lockedAt == 0) revert UnknownToken(token);
        return (l.key, l.tokenIs0);
    }

    /// @notice The current pool's tick and sqrt price (slot0 through extsload).
    function poolState(address token) public view returns (uint160 sqrtPriceX96, int24 tick) {
        Launch storage l = _launches[token];
        if (l.lockedAt == 0) revert UnknownToken(token);
        return V4Math.slot0(poolManager, l.poolId);
    }

    /// @inheritdoc ILaunchLocker
    function progressBps(address token) external view override returns (uint256) {
        Launch storage l = _launches[token];
        if (l.lockedAt == 0) return 0;
        if (l.graduatedAt != 0) return 10_000;
        (uint160 sqrtP,) = V4Math.slot0(poolManager, l.poolId);
        uint160 sqrtStart = V4Math.getSqrtPriceAtTick(l.startTick);
        uint160 sqrtGrad = V4Math.getSqrtPriceAtTick(l.graduationTick);
        // The quote in the curve position grows linearly in sqrt(price): L (sqrtP - sqrtStart) of L (sqrtGrad - sqrtStart).
        if (l.tokenIs0) {
            if (sqrtP <= sqrtStart) return 0;
            if (sqrtP >= sqrtGrad) return 10_000;
            return CurveMath.mulDiv(uint256(sqrtP) - sqrtStart, 10_000, uint256(sqrtGrad) - sqrtStart);
        }
        // Coins per pair asset: the price falls as the curve fills; the quote held is L (1/sqrtP - 1/sqrtStart), linear in 1/sqrt(price).
        if (sqrtP >= sqrtStart) return 0;
        if (sqrtP <= sqrtGrad) return 10_000;
        uint256 invP = CurveMath.mulDiv(V4Math.Q96, V4Math.Q96, sqrtP);
        uint256 invStart = CurveMath.mulDiv(V4Math.Q96, V4Math.Q96, sqrtStart);
        uint256 invGrad = CurveMath.mulDiv(V4Math.Q96, V4Math.Q96, sqrtGrad);
        return CurveMath.mulDiv(invP - invStart, 10_000, invGrad - invStart);
    }

    /// @notice Whether the price sits at or past the graduation tick right now (always, once graduated).
    function crossed(address token) public view returns (bool) {
        Launch storage l = _launches[token];
        if (l.graduatedAt != 0) return true;
        (, int24 tick) = V4Math.slot0(poolManager, l.poolId);
        return l.tokenIs0 ? tick >= l.graduationTick : tick < l.graduationTick;
    }

    /// @inheritdoc ILaunchLocker
    function lockLaunch(address token, PoolKey calldata key, uint24 graduationFee, bool tokenIs0, int24 startTick, int24 graduationTick, int24[2] calldata curveTicks, uint128 curveLiquidity, int24[2] calldata upperTicks, uint128 upperLiquidity) external override nonReentrant returns (uint256 tokensLocked) {
        if (msg.sender != address(factory)) revert NotFactory();
        if (_launches[token].lockedAt != 0) revert AlreadyLocked(token);
        if (curveLiquidity == 0) revert NothingToLock();
        bytes32 id = V4Math.poolId(key);
        Launch storage l = _launches[token];
        l.key = key;
        l.poolId = id;
        l.curvePoolId = id;
        l.graduationFee = graduationFee;
        l.tokenIs0 = tokenIs0;
        l.startTick = startTick;
        l.graduationTick = graduationTick;
        l.positions.push(Position({tickLower: curveTicks[0], tickUpper: curveTicks[1], liquidity: curveLiquidity}));
        if (upperLiquidity > 0) l.positions.push(Position({tickLower: upperTicks[0], tickUpper: upperTicks[1], liquidity: upperLiquidity}));
        l.lockedAt = uint64(block.timestamp);
        bytes memory result = poolManager.unlock(abi.encode(ACTION_LOCK, token));
        tokensLocked = abi.decode(result, (uint256));
        // Whatever rounding left behind is burned: the locker holds no coins of its own.
        uint256 dust = IERC20(token).balanceOf(address(this));
        if (dust > 0) ILaunchTokenBurn(token).burn(dust);
        emit Locked(token, id, startTick, graduationTick, curveLiquidity, upperLiquidity, tokensLocked, dust);
    }

    /// @inheritdoc ILaunchLocker
    function collect(address token) external override nonReentrant returns (uint256 quote, uint256 coinsSold) {
        Launch storage l = _launches[token];
        if (l.lockedAt == 0) revert UnknownToken(token);
        bytes memory result = poolManager.unlock(abi.encode(ACTION_COLLECT, token));
        (quote, coinsSold) = abi.decode(result, (uint256, uint256));
        _creditCollected(token, l, quote, coinsSold);
    }

    /// @inheritdoc ILaunchLocker
    function graduate(address token) external override nonReentrant {
        Launch storage l = _launches[token];
        if (l.lockedAt == 0) revert UnknownToken(token);
        if (l.graduatedAt != 0) revert AlreadyGraduated(token);
        (, int24 tick) = V4Math.slot0(poolManager, l.poolId);
        bool past = l.tokenIs0 ? tick >= l.graduationTick : tick < l.graduationTick;
        if (!past) revert NotCrossed(tick, l.graduationTick);
        bytes memory result = poolManager.unlock(abi.encode(ACTION_GRADUATE, token));
        (uint256 feesQuote, uint256 feesCoins, uint160 sqrtP, int24 tickAfter, uint128 liquidity, uint256 quoteMoved, uint256 coinsMoved) = abi.decode(result, (uint256, uint256, uint160, int24, uint128, uint256, uint256));
        // The curve pool's last fees, with the curve stage's split (the factory still reports it: the graduation is told below).
        _creditCollected(token, l, feesQuote, feesCoins);
        bytes32 curvePoolId = l.curvePoolId;
        l.graduatedAt = uint64(block.timestamp);
        factory.graduationReached(token, l.poolId);
        emit Graduated(token, curvePoolId, l.poolId, tickAfter, sqrtP, liquidity, quoteMoved, coinsMoved);
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint8 action, address token) = abi.decode(data, (uint8, address));
        Launch storage l = _launches[token];
        if (action == ACTION_LOCK) {
            int256 d0;
            int256 d1;
            for (uint256 i = 0; i < l.positions.length; i++) {
                (int256 a0, int256 a1) = _modify(l.key, l.positions[i], int256(uint256(l.positions[i].liquidity)));
                d0 += a0;
                d1 += a1;
            }
            // Both positions are one-sided: only the coin is owed. The pair side must be zero.
            if (l.tokenIs0) { if (d1 != 0) revert NothingToLock(); return abi.encode(_pay(l.key.currency0, d0)); }
            if (d0 != 0) revert NothingToLock();
            return abi.encode(_pay(l.key.currency1, d1));
        }
        if (action == ACTION_COLLECT) {
            (uint256 quote, uint256 coins) = _collectFees(l);
            return abi.encode(quote, coins);
        }
        if (action == ACTION_GRADUATE) return _graduate(l);
        revert UnknownAction(action);
    }

    // ------------------------------------------------------------------ the pieces

    /// @dev Realizes the positions' fees (a zero liquidity change), sells the coin side into the current pool and takes the
    /// pair asset here. Returns the pair asset taken and the coins sold.
    function _collectFees(Launch storage l) internal returns (uint256 quote, uint256 coinsSold) {
        int256 f0;
        int256 f1;
        for (uint256 i = 0; i < l.positions.length; i++) {
            (int256 a0, int256 a1) = _modify(l.key, l.positions[i], 0);
            f0 += a0;
            f1 += a1;
        }
        uint256 coins = uint256(l.tokenIs0 ? f0 : f1);
        quote = uint256(l.tokenIs0 ? f1 : f0);
        if (coins > 0) {
            // The coin-side fees are sold into the pool for the pair asset, inside this same unlock: the coins the
            // positions earned pay for the swap, so nothing moves on the token and no transfer rule sees it.
            int256 swapDelta = poolManager.swap(l.key, SwapParams({zeroForOne: l.tokenIs0, amountSpecified: -int256(coins), sqrtPriceLimitX96: l.tokenIs0 ? V4Math.MIN_SQRT_PRICE + 1 : V4Math.MAX_SQRT_PRICE - 1}), "");
            int128 out = l.tokenIs0 ? V4Math.amount1(swapDelta) : V4Math.amount0(swapDelta);
            int128 used = l.tokenIs0 ? V4Math.amount0(swapDelta) : V4Math.amount1(swapDelta);
            quote += uint256(uint128(out));
            coinsSold = uint256(uint128(-used));
            if (coinsSold < coins) {
                // The pool ran out of the pair asset before the coins were sold (a price limit): the rest is taken and burned.
                address coin = l.tokenIs0 ? l.key.currency0 : l.key.currency1;
                poolManager.take(coin, address(this), coins - coinsSold);
                ILaunchTokenBurn(coin).burn(coins - coinsSold);
            }
        }
        address asset = l.tokenIs0 ? l.key.currency1 : l.key.currency0;
        if (quote > 0) poolManager.take(asset, address(this), quote);
    }

    /// @dev Credits what a collection took to the platform and the creator fee recipient (the factory names the share of
    /// the stage) and emits the event.
    function _creditCollected(address token, Launch storage l, uint256 quote, uint256 coinsSold) internal {
        if (quote == 0) { emit FeesCollected(token, 0, coinsSold, 0, 0); return; }
        LaunchTypes.FeeRecipients memory r = factory.feeRecipients(token);
        address asset = l.tokenIs0 ? l.key.currency1 : l.key.currency0;
        uint256 platform = quote.share(r.platformShareBps);
        _credit(asset, r.platform, platform);
        _credit(asset, r.creator, quote - platform);
        emit FeesCollected(token, quote, coinsSold, quote - platform, platform);
    }

    /// @dev The graduation, inside one unlock: the curve pool's fees, then its liquidity out, the graduation pool brought
    /// to the same price, and the liquidity in as one full-range position with any leftover as a one-sided sliver next
    /// to the price. The deltas of the two pools net against each other: nothing but dust leaves the pool manager.
    function _graduate(Launch storage l) internal returns (bytes memory) {
        // 1. The curve pool's last fees (the curve stage's split is applied by the caller).
        (uint256 feesQuote, uint256 feesCoins) = _collectFees(l);
        // 2. Everything the positions hold comes out.
        uint256 amount0;
        uint256 amount1;
        for (uint256 i = 0; i < l.positions.length; i++) {
            (int256 a0, int256 a1) = _modify(l.key, l.positions[i], -int256(uint256(l.positions[i].liquidity)));
            amount0 += uint256(a0);
            amount1 += uint256(a1);
        }
        delete l.positions;
        uint256 moved0 = amount0;
        uint256 moved1 = amount1;
        // 3. The graduation pool at the curve pool's price. The factory opened it at launch; if anyone has traded it since,
        //    its price is moved back to the curve pool's with a swap against that liquidity (a fair trade either way).
        (uint160 sqrtTarget,) = V4Math.slot0(poolManager, l.poolId);
        PoolKey memory key = PoolKey({currency0: l.key.currency0, currency1: l.key.currency1, fee: l.graduationFee, tickSpacing: l.key.tickSpacing, hooks: address(0)});
        bytes32 id = V4Math.poolId(key);
        uint160 sqrtThere = V4Math.sqrtPriceX96(poolManager, id);
        if (sqrtThere == 0) {
            poolManager.initialize(key, sqrtTarget);
        } else if (sqrtThere != sqrtTarget) {
            bool zeroForOne = sqrtThere > sqrtTarget;
            uint256 have = zeroForOne ? amount0 : amount1;
            if (have > uint256(uint128(type(int128).max))) have = uint256(uint128(type(int128).max));
            int256 d = poolManager.swap(key, SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(have), sqrtPriceLimitX96: sqrtTarget}), "");
            amount0 = _apply(amount0, V4Math.amount0(d));
            amount1 = _apply(amount1, V4Math.amount1(d));
        }
        (uint160 sqrtP, int24 tick) = V4Math.slot0(poolManager, id);
        // 4. One full-range position from both amounts, then the leftover of either side as a one-sided position next to
        //    the price: everything that came out of the curve pool stays liquidity.
        (int24 lo, int24 hi) = V4Math.fullRange(key.tickSpacing);
        uint128 liquidity = _fitBoth(sqrtP, V4Math.getSqrtPriceAtTick(lo), V4Math.getSqrtPriceAtTick(hi), amount0, amount1);
        if (liquidity > 0) {
            (int256 a0, int256 a1) = _modify(key, Position({tickLower: lo, tickUpper: hi, liquidity: liquidity}), int256(uint256(liquidity)));
            amount0 = _apply(amount0, int128(a0));
            amount1 = _apply(amount1, int128(a1));
            l.positions.push(Position({tickLower: lo, tickUpper: hi, liquidity: liquidity}));
        }
        if (amount0 > 0) {
            // Token0 sits above the price: from the first aligned tick above it to the top.
            int24 lower = V4Math.alignDown(tick, key.tickSpacing) + key.tickSpacing;
            if (lower < hi) {
                uint128 extra = _fit0(V4Math.getSqrtPriceAtTick(lower), V4Math.getSqrtPriceAtTick(hi), amount0);
                if (extra > 0) {
                    (int256 a0, int256 a1) = _modify(key, Position({tickLower: lower, tickUpper: hi, liquidity: extra}), int256(uint256(extra)));
                    amount0 = _apply(amount0, int128(a0));
                    amount1 = _apply(amount1, int128(a1));
                    l.positions.push(Position({tickLower: lower, tickUpper: hi, liquidity: extra}));
                }
            }
        }
        if (amount1 > 0) {
            // Token1 sits below the price: from the bottom to the aligned tick at or below it.
            int24 upper = V4Math.alignDown(tick, key.tickSpacing);
            if (upper > lo) {
                uint128 extra = _fit1(V4Math.getSqrtPriceAtTick(lo), V4Math.getSqrtPriceAtTick(upper), amount1);
                if (extra > 0) {
                    (int256 a0, int256 a1) = _modify(key, Position({tickLower: lo, tickUpper: upper, liquidity: extra}), int256(uint256(extra)));
                    amount0 = _apply(amount0, int128(a0));
                    amount1 = _apply(amount1, int128(a1));
                    l.positions.push(Position({tickLower: lo, tickUpper: upper, liquidity: extra}));
                }
            }
        }
        // 5. Dust: a few wei of rounding at most. Coins are burned, the pair asset goes to the fees of this collection.
        uint256 quoteMoved = l.tokenIs0 ? amount1 : amount0;
        uint256 coinsMoved = l.tokenIs0 ? amount0 : amount1;
        if (coinsMoved > 0) {
            address coin = l.tokenIs0 ? l.key.currency0 : l.key.currency1;
            poolManager.take(coin, address(this), coinsMoved);
            ILaunchTokenBurn(coin).burn(coinsMoved);
        }
        if (quoteMoved > 0) {
            poolManager.take(l.tokenIs0 ? l.key.currency1 : l.key.currency0, address(this), quoteMoved);
            feesQuote += quoteMoved;
        }
        l.key = key;
        l.poolId = id;
        return abi.encode(feesQuote, feesCoins, sqrtP, tick, liquidity, l.tokenIs0 ? moved1 : moved0, l.tokenIs0 ? moved0 : moved1);
    }

    /// @dev One liquidity change on a position; the caller's delta as two signed amounts (fees come back positive).
    function _modify(PoolKey memory key, Position memory p, int256 liquidityDelta) internal returns (int256 d0, int256 d1) {
        (int256 delta,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams({tickLower: p.tickLower, tickUpper: p.tickUpper, liquidityDelta: liquidityDelta, salt: bytes32(0)}), "");
        d0 = int256(V4Math.amount0(delta));
        d1 = int256(V4Math.amount1(delta));
    }

    /// @dev What the locker still holds of a currency inside the unlock after a delta: a negative delta spends, a positive
    /// one adds. Spending more than held cannot happen (the positions are sized to what is held) but is clamped anyway.
    function _apply(uint256 held, int128 delta) internal pure returns (uint256) {
        if (delta >= 0) return held + uint256(uint128(delta));
        uint256 spent = uint256(uint128(-delta));
        return spent >= held ? 0 : held - spent;
    }

    /// @dev The largest liquidity `amount0` and `amount1` fund together at `sqrtP` over [sqrtA, sqrtB] whose mint
    /// (rounded up) fits both.
    function _fitBoth(uint160 sqrtP, uint160 sqrtA, uint160 sqrtB, uint256 amount0, uint256 amount1) internal pure returns (uint128) {
        uint128 liquidity = V4Math.liquidityForAmounts(sqrtP, sqrtA, sqrtB, amount0, amount1);
        uint256 l = liquidity;
        while (l > 0) {
            (uint256 need0, uint256 need1) = _amountsFor(sqrtP, sqrtA, sqrtB, l);
            if (need0 <= amount0 && need1 <= amount1) break;
            l -= l / 1_000_000_000 + 1;
        }
        return uint128(l);
    }

    /// @dev The amounts a position of `liquidity` over [sqrtA, sqrtB] needs at `sqrtP` (rounded up, as the pool charges).
    function _amountsFor(uint160 sqrtP, uint160 sqrtA, uint160 sqrtB, uint256 liquidity) internal pure returns (uint256 a0, uint256 a1) {
        if (sqrtP <= sqrtA) return (V4Math.amount0Delta(sqrtA, sqrtB, liquidity), 0);
        if (sqrtP >= sqrtB) return (0, V4Math.amount1Delta(sqrtA, sqrtB, liquidity));
        return (V4Math.amount0Delta(sqrtP, sqrtB, liquidity), V4Math.amount1Delta(sqrtA, sqrtP, liquidity));
    }

    function _fit0(uint160 sqrtA, uint160 sqrtB, uint256 amount) internal pure returns (uint128) {
        uint256 l = V4Math.liquidityForAmount0(sqrtA, sqrtB, amount);
        if (l > type(uint128).max) l = type(uint128).max;
        while (l > 0 && V4Math.amount0Delta(sqrtA, sqrtB, l) > amount) l -= l / 1_000_000_000 + 1;
        return uint128(l);
    }

    function _fit1(uint160 sqrtA, uint160 sqrtB, uint256 amount) internal pure returns (uint128) {
        uint256 l = V4Math.liquidityForAmount1(sqrtA, sqrtB, amount);
        if (l > type(uint128).max) l = type(uint128).max;
        while (l > 0 && V4Math.amount1Delta(sqrtA, sqrtB, l) > amount) l -= l / 1_000_000_000 + 1;
        return uint128(l);
    }

    /// @dev Pays a negative delta of the coin to the pool manager (sync / transfer / settle). Returns what was paid.
    function _pay(address currency, int256 delta) internal returns (uint256 paid) {
        if (delta >= 0) return 0;
        paid = uint256(-delta);
        poolManager.sync(currency);
        currency.safeTransfer(address(poolManager), paid);
        poolManager.settle();
    }

    function _credit(address asset, address recipient, uint256 amount) internal {
        if (amount == 0) return;
        if (asset == address(0)) {
            escrow.credit{value: amount}(recipient);
        } else {
            asset.forceApprove(address(escrow), amount);
            escrow.creditToken(recipient, asset, amount);
        }
    }
}

interface ILaunchTokenBurn {
    function burn(uint256 amount) external;
}
