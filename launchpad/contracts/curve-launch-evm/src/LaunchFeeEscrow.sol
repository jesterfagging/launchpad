// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ILaunchFeeEscrow} from "./interfaces/ILaunch.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {SafeTransfer} from "./lib/SafeTransfer.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";

/// @title LaunchFeeEscrow
/// @notice A pull-based ledger for every fee the launch contracts split: the platform share and the creator share of
/// curve trades, the creator tax, the launch fee, the migration fee and the locked pool's LP fees. Credits are pushed
/// here by the curves and the locker (or by anyone: a credit is a gift); a recipient claims its own balance whenever it
/// likes, in ETH or in the pair asset, to an address of its choice. Nothing here can be paused, redirected or clawed back:
/// there is no owner.
///
/// For Launchpad this is where the platform's revenue is: the host's treasury claims `balanceOf(platform)` at any time, and
/// each coin's fee wallet claims its creator share before routing it to holders, a buyback, a Gotchi pot or an agent.
contract LaunchFeeEscrow is ILaunchFeeEscrow, ReentrancyGuard {
    using SafeTransfer for address;

    error ZeroRecipient();
    error ZeroAmount();
    error InsufficientBalance(uint256 balance, uint256 needed);
    error TokenIsNative();

    mapping(address recipient => uint256) private _native;
    mapping(address recipient => mapping(address token => uint256)) private _tokens;

    /// @notice Credits `msg.value` of ETH to `recipient`.
    function credit(address recipient) external payable {
        if (recipient == address(0)) revert ZeroRecipient();
        if (msg.value == 0) revert ZeroAmount();
        _native[recipient] += msg.value;
        emit Credited(recipient, address(0), msg.value, msg.sender);
    }

    /// @notice Pulls `amount` of `token` from the caller (approve first) and credits it to `recipient`. The amount credited
    /// is what actually arrived, so a fee-on-transfer token cannot inflate a balance.
    function creditToken(address recipient, address token, uint256 amount) external nonReentrant {
        if (recipient == address(0)) revert ZeroRecipient();
        if (token == address(0)) revert TokenIsNative();
        if (amount == 0) revert ZeroAmount();
        uint256 before = IERC20(token).balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();
        _tokens[recipient][token] += received;
        emit Credited(recipient, token, received, msg.sender);
    }

    /// @notice Sends `amount` of the caller's ETH balance to `to`.
    function claim(address to, uint256 amount) public nonReentrant returns (uint256) {
        if (to == address(0)) revert ZeroRecipient();
        uint256 balance = _native[msg.sender];
        if (amount == 0 || amount > balance) revert InsufficientBalance(balance, amount);
        unchecked { _native[msg.sender] = balance - amount; }
        to.sendValue(amount);
        emit Claimed(msg.sender, address(0), amount, to);
        return amount;
    }

    function claimAll(address to) external returns (uint256) {
        return claim(to, _native[msg.sender]);
    }

    /// @notice Sends `amount` of the caller's balance of `token` to `to`.
    function claimToken(address token, address to, uint256 amount) public nonReentrant returns (uint256) {
        if (to == address(0)) revert ZeroRecipient();
        uint256 balance = _tokens[msg.sender][token];
        if (amount == 0 || amount > balance) revert InsufficientBalance(balance, amount);
        unchecked { _tokens[msg.sender][token] = balance - amount; }
        token.safeTransfer(to, amount);
        emit Claimed(msg.sender, token, amount, to);
        return amount;
    }

    function claimAllToken(address token, address to) external returns (uint256) {
        return claimToken(token, to, _tokens[msg.sender][token]);
    }

    function balanceOf(address recipient) external view returns (uint256) { return _native[recipient]; }
    function balanceOfToken(address recipient, address token) external view returns (uint256) { return _tokens[recipient][token]; }
}
