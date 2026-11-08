// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ReentrancyGuard
/// @notice The classic storage mutex. Plain storage rather than transient storage so the contracts build for any EVM
/// version Robinhood Chain's ArbOS accepts.
abstract contract ReentrancyGuard {
    error ReentrancyGuardReentrantCall();

    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;
    uint256 private _status = NOT_ENTERED;

    modifier nonReentrant() {
        if (_status == ENTERED) revert ReentrancyGuardReentrantCall();
        _status = ENTERED;
        _;
        _status = NOT_ENTERED;
    }

    function _reentrancyGuardEntered() internal view returns (bool) { return _status == ENTERED; }
}
