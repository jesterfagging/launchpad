// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ILaunchFactory} from "../../src/interfaces/ILaunch.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";
import {IPoolManager, IUnlockCallback, PoolKey, SwapParams} from "../../src/interfaces/IUniswapV4.sol";
import {V4Math} from "../../src/lib/V4Math.sol";

/// @notice A test-only router that buys an exact number of coins from a launch's pool (an exact-output swap), so the
/// rule tests can ask for "1.5% of the supply" and get exactly that. The rules run inside the token on the pool
/// manager's transfer, so they see the same thing whichever router asked; the production router is exercised by the
/// launch tests. Settles ETH from `msg.value` (the rest comes back) or an ERC-20 pulled from the caller.
contract ExactOutBuyer is IUnlockCallback {
    error NotPoolManager();

    struct Order {
        address token;
        address payer;
        address recipient;
        uint256 tokensOut;
    }

    ILaunchFactory public immutable factory;
    IPoolManager public immutable poolManager;

    constructor(address factory_) {
        factory = ILaunchFactory(factory_);
        poolManager = IPoolManager(factory.poolManager());
    }

    receive() external payable {}

    /// @notice Buys exactly `tokensOut` of `token` for `recipient`; returns the pair asset spent.
    function buyExact(address token, uint256 tokensOut, address recipient) external payable returns (uint256 spent) {
        bytes memory result = poolManager.unlock(abi.encode(Order({token: token, payer: msg.sender, recipient: recipient, tokensOut: tokensOut})));
        spent = abi.decode(result, (uint256));
        if (msg.value > spent) {
            (bool ok,) = payable(msg.sender).call{value: msg.value - spent}("");
            require(ok, "refund");
        }
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        Order memory o = abi.decode(data, (Order));
        (PoolKey memory key, bool tokenIs0) = factory.poolKeyOf(o.token);
        bool zeroForOne = !tokenIs0; // the pair asset goes in, the coin comes out
        // A positive amountSpecified is an exact output in Uniswap v4.
        int256 delta = poolManager.swap(key, SwapParams({zeroForOne: zeroForOne, amountSpecified: int256(o.tokensOut), sqrtPriceLimitX96: zeroForOne ? V4Math.MIN_SQRT_PRICE + 1 : V4Math.MAX_SQRT_PRICE - 1}), "");
        address currencyIn = zeroForOne ? key.currency0 : key.currency1;
        int128 dIn = zeroForOne ? V4Math.amount0(delta) : V4Math.amount1(delta);
        int128 dOut = zeroForOne ? V4Math.amount1(delta) : V4Math.amount0(delta);
        uint256 amountIn = dIn < 0 ? uint256(uint128(-dIn)) : 0;
        uint256 amountOut = dOut > 0 ? uint256(uint128(dOut)) : 0;
        require(amountOut == o.tokensOut, "exact output");
        if (currencyIn == address(0)) {
            poolManager.settle{value: amountIn}();
        } else {
            poolManager.sync(currencyIn);
            require(IERC20(currencyIn).transferFrom(o.payer, address(poolManager), amountIn), "pull");
            poolManager.settle();
        }
        poolManager.take(o.token, o.recipient, amountOut);
        return abi.encode(amountIn);
    }
}
