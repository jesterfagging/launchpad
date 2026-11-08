// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager, IUnlockCallback, PoolKey, ModifyLiquidityParams, SwapParams} from "../../src/interfaces/IUniswapV4.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";
import {V4Math} from "../../src/lib/V4Math.sol";
import {CurveMath} from "../../src/lib/CurveMath.sol";

/// @notice A Uniswap v4 PoolManager stand-in for the tests: one pool per key, the slot0 price readable through
/// `extsload` at the real storage slot, full-range liquidity (positions are tracked, ticks are not), constant-product
/// exact-input swaps with the LP fee, the unlock / delta / sync / settle / take accounting with the same reverts as
/// v4-core, and test helpers that move the price, add outside liquidity and credit LP fees.
contract MockPoolManager is IPoolManager {
    error AlreadyUnlocked();
    error ManagerLocked();
    error PoolAlreadyInitialized();
    error PoolNotInitialized();
    error CurrenciesOutOfOrderOrEqual();
    error TickSpacingTooLarge();
    error TickSpacingTooSmall();
    error LPFeeTooLarge();
    error CurrencyNotSettled();
    error PriceLimitAlreadyExceeded();
    error PriceLimitOutOfBounds();
    error SwapAmountCannotBeZero();
    error ExactOutputUnsupported();
    error NonzeroNativeValue();
    error TransferFailed();

    struct Pool {
        bool initialized;
        uint160 sqrtPriceX96;
        uint24 fee;
        uint128 liquidity; // the whole pool's, every position being full range
        uint256 fees0; // LP fees waiting to be collected, split by liquidity share
        uint256 fees1;
    }

    uint256 internal constant PIPS = 1_000_000;
    bytes32 internal constant POOLS_SLOT = bytes32(uint256(6));

    mapping(bytes32 poolId => Pool) internal _pools;
    mapping(bytes32 slot => uint160) internal _slot0Price;
    mapping(bytes32 positionKey => uint128) public positionLiquidity;
    mapping(address who => mapping(address currency => int256)) public currencyDelta;
    mapping(address currency => uint256) internal _reserves;
    address internal _synced;
    address internal _unlocker;
    bool internal _unlocked;
    address[] internal _touched;
    uint256 public swaps;

    receive() external payable {}

    // ------------------------------------------------------------------ IPoolManager

    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external override returns (int24) {
        if (key.currency0 >= key.currency1) revert CurrenciesOutOfOrderOrEqual();
        if (key.tickSpacing > 32767) revert TickSpacingTooLarge();
        if (key.tickSpacing < 1) revert TickSpacingTooSmall();
        if (key.fee > PIPS) revert LPFeeTooLarge();
        if (sqrtPriceX96 < V4Math.MIN_SQRT_PRICE || sqrtPriceX96 >= V4Math.MAX_SQRT_PRICE) revert PriceLimitOutOfBounds();
        bytes32 id = V4Math.poolId(key);
        Pool storage p = _pools[id];
        if (p.initialized) revert PoolAlreadyInitialized();
        p.initialized = true;
        p.fee = key.fee;
        _setPrice(id, sqrtPriceX96);
        return 0;
    }

    function unlock(bytes calldata data) external override returns (bytes memory result) {
        if (_unlocked) revert AlreadyUnlocked();
        _unlocked = true;
        _unlocker = msg.sender;
        result = IUnlockCallback(msg.sender).unlockCallback(data);
        for (uint256 i = 0; i < _touched.length; i++) {
            if (currencyDelta[msg.sender][_touched[i]] != 0) revert CurrencyNotSettled();
        }
        delete _touched;
        _unlocked = false;
        _unlocker = address(0);
    }

    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata) external override returns (int256 callerDelta, int256 feesAccrued) {
        if (!_unlocked) revert ManagerLocked();
        bytes32 id = V4Math.poolId(key);
        Pool storage p = _pools[id];
        if (!p.initialized) revert PoolNotInitialized();
        bytes32 posKey = keccak256(abi.encode(msg.sender, id, params.tickLower, params.tickUpper, params.salt));
        uint128 posLiq = positionLiquidity[posKey];
        if (posLiq > 0 && p.liquidity > 0) {
            uint256 f0 = p.fees0 * posLiq / p.liquidity;
            uint256 f1 = p.fees1 * posLiq / p.liquidity;
            p.fees0 -= f0;
            p.fees1 -= f1;
            feesAccrued = _toDelta(int256(f0), int256(f1));
        }
        int256 principal;
        if (params.liquidityDelta != 0) {
            uint160 sqrtA = V4Math.getSqrtPriceAtTick(params.tickLower);
            uint160 sqrtB = V4Math.getSqrtPriceAtTick(params.tickUpper);
            if (params.liquidityDelta > 0) {
                uint256 liq = uint256(params.liquidityDelta);
                (uint256 a0, uint256 a1) = V4Math.amountsForLiquidity(p.sqrtPriceX96, sqrtA, sqrtB, liq);
                principal = _toDelta(-int256(a0), -int256(a1));
                positionLiquidity[posKey] = posLiq + uint128(liq);
                p.liquidity += uint128(liq);
            } else {
                uint256 liq = uint256(-params.liquidityDelta);
                (uint256 a0, uint256 a1) = V4Math.amountsForLiquidity(p.sqrtPriceX96, sqrtA, sqrtB, liq);
                principal = _toDelta(int256(a0), int256(a1));
                positionLiquidity[posKey] = posLiq - uint128(liq);
                p.liquidity -= uint128(liq);
            }
        }
        callerDelta = _add(principal, feesAccrued);
        _account(msg.sender, key.currency0, V4Math.amount0(callerDelta));
        _account(msg.sender, key.currency1, V4Math.amount1(callerDelta));
    }

    function swap(PoolKey memory key, SwapParams memory params, bytes calldata) external override returns (int256 swapDelta) {
        if (!_unlocked) revert ManagerLocked();
        if (params.amountSpecified == 0) revert SwapAmountCannotBeZero();
        if (params.amountSpecified > 0) revert ExactOutputUnsupported();
        bytes32 id = V4Math.poolId(key);
        Pool storage p = _pools[id];
        if (!p.initialized) revert PoolNotInitialized();
        uint160 sqrtP = p.sqrtPriceX96;
        uint160 limit = params.sqrtPriceLimitX96;
        if (params.zeroForOne) {
            if (limit >= sqrtP) revert PriceLimitAlreadyExceeded();
            if (limit <= V4Math.MIN_SQRT_PRICE) revert PriceLimitOutOfBounds();
        } else {
            if (limit <= sqrtP) revert PriceLimitAlreadyExceeded();
            if (limit >= V4Math.MAX_SQRT_PRICE) revert PriceLimitOutOfBounds();
        }
        swaps += 1;
        (uint160 next, uint256 used, uint256 out, uint256 feeAmount) = _step(p, params.zeroForOne, uint256(-params.amountSpecified), limit);
        _setPrice(id, next);
        if (params.zeroForOne) {
            p.fees0 += feeAmount;
            swapDelta = _toDelta(-int256(used + feeAmount), int256(out));
        } else {
            p.fees1 += feeAmount;
            swapDelta = _toDelta(int256(out), -int256(used + feeAmount));
        }
        _account(msg.sender, key.currency0, V4Math.amount0(swapDelta));
        _account(msg.sender, key.currency1, V4Math.amount1(swapDelta));
    }

    function sync(address currency) external override {
        if (currency == address(0)) {
            _synced = address(0);
        } else {
            _synced = currency;
            _reserves[currency] = IERC20(currency).balanceOf(address(this));
        }
    }

    function settle() external payable override returns (uint256 paid) {
        if (!_unlocked) revert ManagerLocked();
        address currency = _synced;
        if (currency == address(0)) {
            paid = msg.value;
        } else {
            if (msg.value > 0) revert NonzeroNativeValue();
            paid = IERC20(currency).balanceOf(address(this)) - _reserves[currency];
            _synced = address(0);
        }
        _account(msg.sender, currency, int256(paid));
    }

    function take(address currency, address to, uint256 amount) external override {
        if (!_unlocked) revert ManagerLocked();
        _account(msg.sender, currency, -int256(amount));
        _send(currency, to, amount);
    }

    function extsload(bytes32 slot) external view override returns (bytes32) {
        return bytes32(uint256(_slot0Price[slot]));
    }

    // ------------------------------------------------------------------ test helpers

    function sqrtPriceOf(bytes32 id) external view returns (uint160) { return _pools[id].sqrtPriceX96; }
    function liquidityOf(bytes32 id) external view returns (uint128) { return _pools[id].liquidity; }
    function feesOf(bytes32 id) external view returns (uint256, uint256) { return (_pools[id].fees0, _pools[id].fees1); }

    /// @dev Someone traded the pool to another price.
    function setPrice(bytes32 id, uint160 sqrtPriceX96) external {
        if (!_pools[id].initialized) revert PoolNotInitialized();
        _setPrice(id, sqrtPriceX96);
    }

    /// @dev An outside LP's liquidity (its tokens are assumed to be here already).
    function addLiquidity(bytes32 id, uint128 liquidity) external {
        if (!_pools[id].initialized) revert PoolNotInitialized();
        _pools[id].liquidity += liquidity;
    }

    /// @dev LP fees the pool earned (transfer the amounts to this contract first).
    function accrueFees(bytes32 id, uint256 fees0, uint256 fees1) external {
        if (!_pools[id].initialized) revert PoolNotInitialized();
        _pools[id].fees0 += fees0;
        _pools[id].fees1 += fees1;
    }

    // ------------------------------------------------------------------ internals

    function _setPrice(bytes32 id, uint160 sqrtPriceX96) internal {
        _pools[id].sqrtPriceX96 = sqrtPriceX96;
        _slot0Price[keccak256(abi.encodePacked(id, POOLS_SLOT))] = sqrtPriceX96;
    }

    function _account(address who, address currency, int256 delta) internal {
        if (delta == 0) return;
        currencyDelta[who][currency] += delta;
        _touched.push(currency);
    }

    function _send(address currency, address to, uint256 amount) internal {
        if (currency == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            if (!IERC20(currency).transfer(to, amount)) revert TransferFailed();
        }
    }

    /// @dev One exact-input step of the constant-product curve at the pool's liquidity, to `limit` at most.
    function _step(Pool storage p, bool zeroForOne, uint256 amountIn, uint160 limit) internal view returns (uint160 next, uint256 used, uint256 out, uint256 feeAmount) {
        uint128 liquidity = p.liquidity;
        uint160 sqrtP = p.sqrtPriceX96;
        if (liquidity == 0) return (limit, 0, 0, 0);
        uint256 inLessFee = amountIn * (PIPS - p.fee) / PIPS;
        next = zeroForOne ? _nextFromInput0(sqrtP, liquidity, inLessFee) : _nextFromInput1(sqrtP, liquidity, inLessFee);
        bool reached = zeroForOne ? next <= limit : next >= limit;
        if (reached) next = limit;
        if (zeroForOne) {
            used = V4Math.amount0Delta(next, sqrtP, liquidity);
            out = _amount1Down(next, sqrtP, liquidity);
        } else {
            used = V4Math.amount1Delta(sqrtP, next, liquidity);
            out = _amount0Down(sqrtP, next, liquidity);
        }
        if (!reached) {
            if (used > amountIn) used = amountIn;
            feeAmount = amountIn - used;
        } else {
            feeAmount = CurveMath.mulDivUp(used, p.fee, PIPS - p.fee);
        }
    }

    /// @dev SqrtPriceMath.getNextSqrtPriceFromAmount0RoundingUp for an input of token0.
    function _nextFromInput0(uint160 sqrtP, uint128 liquidity, uint256 amount) internal pure returns (uint160) {
        if (amount == 0) return sqrtP;
        uint256 numerator1 = uint256(liquidity) << 96;
        unchecked {
            uint256 product = amount * sqrtP;
            if (product / amount == sqrtP) {
                uint256 denominator = numerator1 + product;
                if (denominator >= numerator1) return uint160(CurveMath.mulDivUp(numerator1, sqrtP, denominator));
            }
        }
        return uint160(CurveMath.mulDivUp(numerator1, 1, numerator1 / sqrtP + amount));
    }

    /// @dev SqrtPriceMath.getNextSqrtPriceFromAmount1RoundingDown for an input of token1.
    function _nextFromInput1(uint160 sqrtP, uint128 liquidity, uint256 amount) internal pure returns (uint160) {
        uint256 quotient = amount <= type(uint160).max ? (amount << 96) / liquidity : CurveMath.mulDiv(amount, V4Math.Q96, liquidity);
        uint256 next = uint256(sqrtP) + quotient;
        if (next >= V4Math.MAX_SQRT_PRICE) next = V4Math.MAX_SQRT_PRICE - 1;
        return uint160(next);
    }

    function _amount0Down(uint160 sqrtA, uint160 sqrtB, uint256 liquidity) internal pure returns (uint256) {
        uint256 numerator1 = liquidity << 96;
        uint256 numerator2 = uint256(sqrtB) - uint256(sqrtA);
        return CurveMath.mulDiv(numerator1, numerator2, sqrtB) / sqrtA;
    }

    function _amount1Down(uint160 sqrtA, uint160 sqrtB, uint256 liquidity) internal pure returns (uint256) {
        return CurveMath.mulDiv(liquidity, uint256(sqrtB) - uint256(sqrtA), V4Math.Q96);
    }

    function _toDelta(int256 a0, int256 a1) internal pure returns (int256 d) {
        assembly {
            d := or(shl(128, a0), and(sub(shl(128, 1), 1), a1))
        }
    }

    function _add(int256 a, int256 b) internal pure returns (int256) {
        return _toDelta(int256(V4Math.amount0(a)) + int256(V4Math.amount0(b)), int256(V4Math.amount1(a)) + int256(V4Math.amount1(b)));
    }
}
