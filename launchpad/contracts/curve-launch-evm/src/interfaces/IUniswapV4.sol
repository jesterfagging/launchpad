// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The slice of Uniswap v4 the launch contracts use. v4 is one singleton, the PoolManager: pools are keyed by
/// their PoolKey, positions belong to whoever calls `modifyLiquidity` (no NFT needed), and every balance change inside
/// an `unlock` must be settled before it returns. `Currency` is an address (address(0) is native ETH) and `BalanceDelta`
/// is an int256 packing two int128 amounts (amount0 in the upper half). Signatures follow v4-core.

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified; // negative = exact input, positive = exact output
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
    function unlock(bytes calldata data) external returns (bytes memory);
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData) external returns (int256 callerDelta, int256 feesAccrued);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 swapDelta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
    function extsload(bytes32 slot) external view returns (bytes32 value);
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/// @notice Arbitrum's ArbSys precompile (0x64): the L2 block number, which a Robinhood Chain block is.
interface IArbSys {
    function arbBlockNumber() external view returns (uint256);
}
