// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CurveMath
/// @notice Full-precision `a × b / d` (the 512-bit method Uniswap and OpenZeppelin use) and an integer square root, for
/// the pool price at graduation and the bonding curve's reserve arithmetic.
library CurveMath {
    error MathOverflow();

    uint256 internal constant BPS = 10_000;

    /// @dev floor(a × b / d) without overflowing the intermediate product. Reverts when the result does not fit.
    function mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly ("memory-safe") {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) {
                if (denominator == 0) revert MathOverflow();
                return prod0 / denominator;
            }
            if (denominator <= prod1) revert MathOverflow();
            uint256 remainder;
            assembly ("memory-safe") {
                remainder := mulmod(a, b, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = denominator & (0 - denominator);
            assembly ("memory-safe") {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inverse = (3 * denominator) ^ 2;
            inverse *= 2 - denominator * inverse; // inverse mod 2^8
            inverse *= 2 - denominator * inverse; // 2^16
            inverse *= 2 - denominator * inverse; // 2^32
            inverse *= 2 - denominator * inverse; // 2^64
            inverse *= 2 - denominator * inverse; // 2^128
            inverse *= 2 - denominator * inverse; // 2^256
            result = prod0 * inverse;
        }
    }

    /// @dev ceil(a × b / d).
    function mulDivUp(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        result = mulDiv(a, b, denominator);
        if (mulmod(a, b, denominator) != 0) {
            if (result == type(uint256).max) revert MathOverflow();
            result += 1;
        }
    }

    /// @dev floor(sqrt(x)) by Newton's method from a power-of-two estimate.
    function sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        uint256 estimate = 1;
        uint256 y = x;
        if (y >= 1 << 128) { y >>= 128; estimate <<= 64; }
        if (y >= 1 << 64) { y >>= 64; estimate <<= 32; }
        if (y >= 1 << 32) { y >>= 32; estimate <<= 16; }
        if (y >= 1 << 16) { y >>= 16; estimate <<= 8; }
        if (y >= 1 << 8) { y >>= 8; estimate <<= 4; }
        if (y >= 1 << 4) { y >>= 4; estimate <<= 2; }
        if (y >= 1 << 2) { estimate <<= 1; }
        z = estimate << 1; // ≥ sqrt(x)
        unchecked {
            for (uint256 i = 0; i < 8; i++) {
                uint256 next = (z + x / z) >> 1;
                if (next >= z) break;
                z = next;
            }
            if (z > x / z) z = x / z; // never above the true root
        }
    }

    /// @dev total × bps / 10 000.
    function share(uint256 total, uint256 bps) internal pure returns (uint256) {
        return mulDiv(total, bps, BPS);
    }

    function min(uint256 a, uint256 b) internal pure returns (uint256) { return a < b ? a : b; }
    function max(uint256 a, uint256 b) internal pure returns (uint256) { return a > b ? a : b; }
}
