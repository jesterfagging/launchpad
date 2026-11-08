// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";

/// @title LaunchPayouts
/// @notice Pays many holders in one transaction: native ETH from the call's value, or an ERC-20 pulled from the payer
/// (approve this contract first). Stateless and ownerless. A recipient that cannot take its payment (a contract
/// without a receive function, a token that refuses the transfer) is skipped and reported, so one bad address never
/// blocks a reward cycle; skipped ETH goes back to the payer with any excess value.
contract LaunchPayouts is ReentrancyGuard {
    error LengthMismatch();
    error TooManyRecipients();
    error InsufficientValue(uint256 needed, uint256 sent);
    error RefundFailed();

    event Paid(address indexed payer, address indexed asset, uint256 total, uint256 recipients, uint256 skipped);
    event PayoutSkipped(address indexed payer, address indexed asset, address indexed to, uint256 amount);

    uint256 public constant MAX_RECIPIENTS = 500;

    /// @notice Pays `amounts[i]` of ETH to `to[i]`; returns the number of recipients that could not be paid.
    function payEth(address[] calldata to, uint256[] calldata amounts) external payable nonReentrant returns (uint256 skipped) {
        if (to.length != amounts.length) revert LengthMismatch();
        if (to.length > MAX_RECIPIENTS) revert TooManyRecipients();
        uint256 needed;
        for (uint256 i = 0; i < amounts.length; i++) needed += amounts[i];
        if (msg.value < needed) revert InsufficientValue(needed, msg.value);
        uint256 paid;
        for (uint256 i = 0; i < to.length; i++) {
            (bool ok,) = to[i].call{value: amounts[i], gas: 30_000}("");
            if (ok) paid += amounts[i];
            else { skipped += 1; emit PayoutSkipped(msg.sender, address(0), to[i], amounts[i]); }
        }
        uint256 leftover = msg.value - paid;
        if (leftover > 0) {
            (bool ok,) = msg.sender.call{value: leftover}("");
            if (!ok) revert RefundFailed();
        }
        emit Paid(msg.sender, address(0), paid, to.length - skipped, skipped);
    }

    /// @notice Pays `amounts[i]` of `token` to `to[i]` from the caller's balance; returns the number skipped.
    function payToken(address token, address[] calldata to, uint256[] calldata amounts) external nonReentrant returns (uint256 skipped) {
        if (to.length != amounts.length) revert LengthMismatch();
        if (to.length > MAX_RECIPIENTS) revert TooManyRecipients();
        uint256 paid;
        for (uint256 i = 0; i < to.length; i++) {
            (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transferFrom, (msg.sender, to[i], amounts[i])));
            if (ok && (data.length == 0 || abi.decode(data, (bool)))) paid += amounts[i];
            else { skipped += 1; emit PayoutSkipped(msg.sender, token, to[i], amounts[i]); }
        }
        emit Paid(msg.sender, token, paid, to.length - skipped, skipped);
    }
}
