// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Ownable2Step
/// @notice One owner (the Launchpad host), handed over in two steps so a typo can never orphan the factory. Ownership gates
/// configuration only; no owner function can move a launch's funds.
abstract contract Ownable2Step {
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error OwnableUnauthorized(address caller);
    error OwnableInvalidOwner(address owner);

    address private _owner;
    address private _pendingOwner;

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert OwnableInvalidOwner(address(0));
        _owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        if (msg.sender != _owner) revert OwnableUnauthorized(msg.sender);
        _;
    }

    function owner() public view returns (address) { return _owner; }
    function pendingOwner() public view returns (address) { return _pendingOwner; }

    function transferOwnership(address newOwner) external onlyOwner {
        _pendingOwner = newOwner;
        emit OwnershipTransferStarted(_owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != _pendingOwner) revert OwnableUnauthorized(msg.sender);
        emit OwnershipTransferred(_owner, msg.sender);
        _owner = msg.sender;
        _pendingOwner = address(0);
    }
}
