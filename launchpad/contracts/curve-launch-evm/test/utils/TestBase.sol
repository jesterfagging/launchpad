// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "./Vm.sol";

/// @notice A tiny test base: Foundry's cheatcode handle and revert-on-mismatch assertions with readable messages.
abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error AssertEqFailed(string what, uint256 a, uint256 b);
    error AssertEqAddressFailed(string what, address a, address b);
    error AssertTrueFailed(string what);
    error AssertApproxFailed(string what, uint256 a, uint256 b, uint256 tolerance);

    function assertEq(uint256 a, uint256 b, string memory what) internal pure {
        if (a != b) revert AssertEqFailed(what, a, b);
    }

    function assertEq(address a, address b, string memory what) internal pure {
        if (a != b) revert AssertEqAddressFailed(what, a, b);
    }

    error AssertEqIntFailed(string what, int256 a, int256 b);

    function assertEq(int256 a, int256 b, string memory what) internal pure {
        if (a != b) revert AssertEqIntFailed(what, a, b);
    }

    function assertEq(bool a, bool b, string memory what) internal pure {
        if (a != b) revert AssertTrueFailed(what);
    }

    function assertEq(bytes32 a, bytes32 b, string memory what) internal pure {
        if (a != b) revert AssertEqFailed(what, uint256(a), uint256(b));
    }

    function assertTrue(bool ok, string memory what) internal pure {
        if (!ok) revert AssertTrueFailed(what);
    }

    /// @dev |a − b| ≤ tolerance.
    function assertApprox(uint256 a, uint256 b, uint256 tolerance, string memory what) internal pure {
        uint256 diff = a > b ? a - b : b - a;
        if (diff > tolerance) revert AssertApproxFailed(what, a, b, tolerance);
    }

    /// @dev |a − b| ≤ b × bps / 10000.
    function assertApproxBps(uint256 a, uint256 b, uint256 bps, string memory what) internal pure {
        assertApprox(a, b, b * bps / 10_000, what);
    }
}
