// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../interfaces/IERC20.sol";

/// @title SafeTransfer
/// @notice ERC-20 calls that tolerate tokens returning nothing (the USDT shape) but never a token returning false, plus
/// a checked native transfer. Every pair asset Launchpad approves is an ordinary ERC-20; a token that lies about a transfer
/// cannot pass these checks.
library SafeTransfer {
    error SafeTransferFailed(address token);
    error SafeApproveFailed(address token);
    error NativeTransferFailed(address to);

    function safeTransfer(address token, address to, uint256 value) internal {
        _call(token, abi.encodeCall(IERC20.transfer, (to, value)));
    }

    function safeTransferFrom(address token, address from, address to, uint256 value) internal {
        _call(token, abi.encodeCall(IERC20.transferFrom, (from, to, value)));
    }

    /// @dev Sets the allowance to exactly `value`, going through zero for tokens that refuse a non-zero to non-zero change.
    function forceApprove(address token, address spender, uint256 value) internal {
        bytes memory data = abi.encodeCall(IERC20.approve, (spender, value));
        if (!_try(token, data)) {
            _approveCall(token, abi.encodeCall(IERC20.approve, (spender, 0)));
            _approveCall(token, data);
        }
    }

    function sendValue(address to, uint256 value) internal {
        (bool ok,) = payable(to).call{value: value}("");
        if (!ok) revert NativeTransferFailed(to);
    }

    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok) _bubble(ret, token);
        if ((ret.length != 0 && !abi.decode(ret, (bool))) || (ret.length == 0 && token.code.length == 0)) revert SafeTransferFailed(token);
    }

    function _approveCall(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok) _bubble(ret, token);
        if ((ret.length != 0 && !abi.decode(ret, (bool))) || (ret.length == 0 && token.code.length == 0)) revert SafeApproveFailed(token);
    }

    /// @dev A token's own revert reason (a rule's `RuleRefused(kind)`, say) is passed through unchanged.
    function _bubble(bytes memory ret, address token) private pure {
        if (ret.length == 0) revert SafeTransferFailed(token);
        assembly ("memory-safe") {
            revert(add(ret, 32), mload(ret))
        }
    }

    function _try(address token, bytes memory data) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(data);
        return ok && (ret.length == 0 ? token.code.length > 0 : abi.decode(ret, (bool)));
    }
}
