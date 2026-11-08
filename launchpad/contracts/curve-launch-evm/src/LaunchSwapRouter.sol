// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ILaunchFactory} from "./interfaces/ILaunch.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IPoolManager, IUnlockCallback, PoolKey, SwapParams} from "./interfaces/IUniswapV4.sol";
import {SafeTransfer} from "./lib/SafeTransfer.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";
import {V4Math} from "./lib/V4Math.sol";

/// @title LaunchSwapRouter
/// @notice The Launchpad site's own way in and out of a coin's Uniswap v4 pool: one call buys with the pair asset (ETH as
/// value, an ERC-20 pulled from the caller) or sells coins (approve this router once), exact input with a minimum
/// output and a deadline, settled straight between the trader and the PoolManager. It is a convenience, not a
/// requirement: the pool is a plain v4 pool and any router, aggregator or wallet trades it the same way. The router
/// holds nothing between calls and has no owner.
contract LaunchSwapRouter is IUnlockCallback, ReentrancyGuard {
    using SafeTransfer for address;

    error NotPoolManager();
    error Expired(uint256 deadline);
    error Slippage(uint256 amountOut, uint256 minimum);
    error UnknownToken(address token);
    error ValueMismatch(uint256 expected, uint256 sent);
    error ZeroAmount();
    error ZeroAddress();
    error TooLarge();

    event Swapped(address indexed token, address indexed payer, address indexed recipient, bool buy, uint256 quoteAmount, uint256 tokenAmount, uint160 sqrtPriceX96After, int24 tickAfter);

    struct Order {
        address token;
        address payer;
        address recipient;
        bool buy;
        uint256 amountIn;
        uint256 minOut;
    }

    ILaunchFactory public immutable factory;
    IPoolManager public immutable poolManager;

    constructor(address factory_) {
        if (factory_ == address(0)) revert ZeroAddress();
        factory = ILaunchFactory(factory_);
        poolManager = IPoolManager(factory.poolManager());
    }

    /// @dev Native ETH comes back from the pool manager (`take`) and leaves again in the same call.
    receive() external payable {}

    /// @notice Buys `token` with exactly `quoteIn` of its pair asset: ETH as `msg.value`, an ERC-20 pulled from the
    /// caller (approve this router). At least `minTokensOut` coins reach `recipient`, or the call reverts.
    function buy(address token, uint256 quoteIn, uint256 minTokensOut, address recipient, uint256 deadline) external payable nonReentrant returns (uint256 tokensOut) {
        (PoolKey memory key, bool tokenIs0) = factory.poolKeyOf(token);
        address quote = tokenIs0 ? key.currency1 : key.currency0;
        if (quote == address(0)) { if (msg.value != quoteIn) revert ValueMismatch(quoteIn, msg.value); }
        else if (msg.value != 0) revert ValueMismatch(0, msg.value);
        (uint256 amountIn, uint256 amountOut) = _swap(Order({token: token, payer: msg.sender, recipient: recipient, buy: true, amountIn: quoteIn, minOut: minTokensOut}), deadline);
        if (quote == address(0) && amountIn < quoteIn) msg.sender.sendValue(quoteIn - amountIn); // the pool took less (its price limit)
        return amountOut;
    }

    /// @notice Sells exactly `tokensIn` of `token` (approve this router) for its pair asset; at least `minQuoteOut`
    /// reaches `recipient`, or the call reverts.
    function sell(address token, uint256 tokensIn, uint256 minQuoteOut, address recipient, uint256 deadline) external nonReentrant returns (uint256 quoteOut) {
        (, uint256 amountOut) = _swap(Order({token: token, payer: msg.sender, recipient: recipient, buy: false, amountIn: tokensIn, minOut: minQuoteOut}), deadline);
        return amountOut;
    }

    function _swap(Order memory o, uint256 deadline) internal returns (uint256 amountIn, uint256 amountOut) {
        if (block.timestamp > deadline) revert Expired(deadline);
        if (o.recipient == address(0)) revert ZeroAddress();
        if (o.amountIn == 0) revert ZeroAmount();
        if (o.amountIn > uint256(uint128(type(int128).max))) revert TooLarge();
        bytes memory result = poolManager.unlock(abi.encode(o));
        (amountIn, amountOut) = abi.decode(result, (uint256, uint256));
        if (amountOut < o.minOut) revert Slippage(amountOut, o.minOut);
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Order memory o = abi.decode(data, (Order));
        (PoolKey memory key, bool tokenIs0) = factory.poolKeyOf(o.token);
        // A buy pays the pair asset for the coin; a sell the other way round. zeroForOne says which currency goes in.
        bool zeroForOne = o.buy ? !tokenIs0 : tokenIs0;
        int256 delta = poolManager.swap(key, SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(o.amountIn), sqrtPriceLimitX96: zeroForOne ? V4Math.MIN_SQRT_PRICE + 1 : V4Math.MAX_SQRT_PRICE - 1}), "");
        address currencyIn = zeroForOne ? key.currency0 : key.currency1;
        address currencyOut = zeroForOne ? key.currency1 : key.currency0;
        int128 dIn = zeroForOne ? V4Math.amount0(delta) : V4Math.amount1(delta);
        int128 dOut = zeroForOne ? V4Math.amount1(delta) : V4Math.amount0(delta);
        uint256 amountIn = dIn < 0 ? uint256(uint128(-dIn)) : 0;
        uint256 amountOut = dOut > 0 ? uint256(uint128(dOut)) : 0;
        if (amountIn > 0) {
            if (currencyIn == address(0)) {
                poolManager.settle{value: amountIn}();
            } else {
                poolManager.sync(currencyIn);
                currencyIn.safeTransferFrom(o.payer, address(poolManager), amountIn);
                poolManager.settle();
            }
        }
        if (amountOut > 0) poolManager.take(currencyOut, o.recipient, amountOut);
        (uint160 sqrtP, int24 tick) = V4Math.slot0(poolManager, V4Math.poolId(key));
        emit Swapped(o.token, o.payer, o.recipient, o.buy, o.buy ? amountIn : amountOut, o.buy ? amountOut : amountIn, sqrtP, tick);
        return abi.encode(amountIn, amountOut);
    }
}
