// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The slice of Foundry's cheatcodes these tests use (forge-std is not vendored: the build needs no download).
interface Vm {
    function prank(address msgSender) external;
    function snapshotState() external returns (uint256);
    function revertToState(uint256 snapshotId) external returns (bool);
    function startPrank(address msgSender) external;
    function stopPrank() external;
    function deal(address account, uint256 newBalance) external;
    function warp(uint256 newTimestamp) external;
    function roll(uint256 newHeight) external;
    function expectRevert() external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert(bytes calldata revertData) external;
    function label(address account, string calldata newLabel) external;
    function addr(uint256 privateKey) external pure returns (address);
    function etch(address target, bytes calldata newRuntimeBytecode) external;
    function assume(bool condition) external pure;
    function startBroadcast() external;
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
    function envOr(string calldata name, uint256 defaultValue) external view returns (uint256);
    function envOr(string calldata name, address defaultValue) external view returns (address);
    function envOr(string calldata name, bool defaultValue) external view returns (bool);
    function envOr(string calldata name, string calldata defaultValue) external view returns (string memory);
}
