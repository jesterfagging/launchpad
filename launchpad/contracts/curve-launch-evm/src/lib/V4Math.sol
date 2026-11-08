// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolKey, IPoolManager} from "../interfaces/IUniswapV4.sol";
import {CurveMath} from "./CurveMath.sol";

/// @title V4Math
/// @notice The Uniswap v4 arithmetic the launch contracts need: tick ↔ sqrt price (TickMath, the same constants as
/// Uniswap's), liquidity from token amounts (LiquidityAmounts), the pool id and its slot0 read through `extsload`,
/// BalanceDelta unpacking, and the full-range ticks of a tick spacing.
library V4Math {
    error TickOutOfRange(int24 tick);

    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;
    uint256 internal constant Q96 = 1 << 96;
    bytes32 internal constant POOLS_SLOT = bytes32(uint256(6));

    /// @dev sqrt(1.0001^tick) × 2^96 (Uniswap's TickMath.getSqrtPriceAtTick).
    function getSqrtPriceAtTick(int24 tick) internal pure returns (uint160 sqrtP) {
        if (tick < MIN_TICK || tick > MAX_TICK) revert TickOutOfRange(tick);
        uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
        uint256 ratio = absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
        unchecked {
            if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;
            if (tick > 0) ratio = type(uint256).max / ratio;
            // Round up so the result at MAX_TICK is MAX_SQRT_PRICE and the tick ↔ price pair is consistent.
            sqrtP = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
        }
    }

    /// @dev The widest ticks a pool of `tickSpacing` allows.
    function fullRange(int24 tickSpacing) internal pure returns (int24 tickLower, int24 tickUpper) {
        tickLower = (MIN_TICK / tickSpacing) * tickSpacing;
        tickUpper = (MAX_TICK / tickSpacing) * tickSpacing;
    }

    /// @dev The greatest tick whose sqrt price is at most `sqrtPriceX96` (Uniswap's TickMath.getTickAtSqrtPrice).
    function getTickAtSqrtPrice(uint160 sqrtP) internal pure returns (int24 tick) {
        if (sqrtP < MIN_SQRT_PRICE || sqrtP >= MAX_SQRT_PRICE) revert TickOutOfRange(0);
        unchecked {
            uint256 price = uint256(sqrtP) << 32;
            uint256 r = price;
            uint256 msb = mostSignificantBit(r);
            if (msb >= 128) r = price >> (msb - 127);
            else r = price << (127 - msb);
            int256 log_2 = (int256(msb) - 128) << 64;
            assembly ("memory-safe") {
                r := shr(127, mul(r, r))
                let f := shr(128, r)
                log_2 := or(log_2, shl(63, f))
                r := shr(f, r)
            }
            assembly ("memory-safe") {
                r := shr(127, mul(r, r))
                let f := shr(128, r)
                log_2 := or(log_2, shl(62, f))
                r := shr(f, r)
            }
            assembly ("memory-safe") {
                r := shr(127, mul(r, r))
                let f := shr(128, r)
                log_2 := or(log_2, shl(61, f))
                r := shr(f, r)
            }
            assembly ("memory-safe") {
                r := shr(127, mul(r, r))
                let f := shr(128, r)
                log_2 := or(log_2, shl(60, f))
                r := shr(f, r)
            }
            assembly ("memory-safe") {
                r := shr(127, mul(r, r))
                let f := shr(128, r)
                log_2 := or(log_2, shl(59, f))
                r := shr(f, r)
            }
            assembly ("memory-safe") {
                r := shr(127, mul(r, r))
                let f := shr(128, r)
                log_2 := or(log_2, shl(58, f))
                r := shr(f, r)
            }
            assembly ("memory-safe") {
                r := shr(127, mul(r, r))
                let f := shr(128, r)
                log_2 := or(log_2, shl(57, f))
                r := shr(f, r)
            }
            assembly ("memory-safe") {
                r := shr(127, mul(r, r))
                let f := shr(128, r)
                log_2 := or(log_2, shl(56, f))
                r := shr(f, r)
            }
            assembly ("memory-safe") {
                r := shr(127, mul(r, r))
                let f := shr(128, r)
                log_2 := or(log_2, shl(55, f))
                r := shr(f, r)
            }
            assembly ("memory-safe") {
                r := shr(127, mul(r, r))
                let f := shr(128, r)
                log_2 := or(log_2, shl(54, f))
                r := shr(f, r)
            }
            assembly ("memory-safe") {
                r := shr(127, mul(r, r))
                let f := shr(128, r)
                log_2 := or(log_2, shl(53, f))
                r := shr(f, r)
            }
            assembly ("memory-safe") {
                r := shr(127, mul(r, r))
                let f := shr(128, r)
                log_2 := or(log_2, shl(52, f))
                r := shr(f, r)
            }
            assembly ("memory-safe") {
                r := shr(127, mul(r, r))
                let f := shr(128, r)
                log_2 := or(log_2, shl(51, f))
                r := shr(f, r)
            }
            assembly ("memory-safe") {
                r := shr(127, mul(r, r))
                let f := shr(128, r)
                log_2 := or(log_2, shl(50, f))
            }
            int256 log_sqrt10001 = log_2 * 255738958999603826347141; // 128.128 number
            int24 tickLow = int24((log_sqrt10001 - 3402992956809132418596140100660247210) >> 128);
            int24 tickHi = int24((log_sqrt10001 + 291339464771989622907027621153398088495) >> 128);
            tick = tickLow == tickHi ? tickLow : getSqrtPriceAtTick(tickHi) <= sqrtP ? tickHi : tickLow;
        }
    }

    /// @dev The index of the highest set bit of `x` (x > 0).
    function mostSignificantBit(uint256 x) internal pure returns (uint8 r) {
        unchecked {
            if (x >= 0x100000000000000000000000000000000) { x >>= 128; r += 128; }
            if (x >= 0x10000000000000000) { x >>= 64; r += 64; }
            if (x >= 0x100000000) { x >>= 32; r += 32; }
            if (x >= 0x10000) { x >>= 16; r += 16; }
            if (x >= 0x100) { x >>= 8; r += 8; }
            if (x >= 0x10) { x >>= 4; r += 4; }
            if (x >= 0x4) { x >>= 2; r += 2; }
            if (x >= 0x2) r += 1;
        }
    }

    /// @dev `tick` rounded down to a multiple of `tickSpacing` (towards negative infinity), inside the usable range.
    function alignDown(int24 tick, int24 tickSpacing) internal pure returns (int24 aligned) {
        aligned = tick / tickSpacing * tickSpacing;
        if (aligned > tick) aligned -= tickSpacing; // Solidity's division truncates towards zero
        (int24 lo, int24 hi) = fullRange(tickSpacing);
        if (aligned < lo) aligned = lo;
        if (aligned > hi) aligned = hi;
    }

    /// @dev `tick` rounded up to a multiple of `tickSpacing`, inside the usable range.
    function alignUp(int24 tick, int24 tickSpacing) internal pure returns (int24 aligned) {
        aligned = alignDown(tick, tickSpacing);
        if (aligned < tick) aligned += tickSpacing;
        (, int24 hi) = fullRange(tickSpacing);
        if (aligned > hi) aligned = hi;
    }

    /// @dev The liquidity `amount0` of token0 provides between sqrtA and sqrtB (sqrtA < sqrtB).
    function liquidityForAmount0(uint160 sqrtA, uint160 sqrtB, uint256 a0) internal pure returns (uint256) {
        uint256 intermediate = CurveMath.mulDiv(sqrtA, sqrtB, Q96);
        return CurveMath.mulDiv(a0, intermediate, uint256(sqrtB) - uint256(sqrtA));
    }

    /// @dev The liquidity `amount1` of token1 provides between sqrtA and sqrtB.
    function liquidityForAmount1(uint160 sqrtA, uint160 sqrtB, uint256 a1) internal pure returns (uint256) {
        return CurveMath.mulDiv(a1, Q96, uint256(sqrtB) - uint256(sqrtA));
    }

    /// @dev The largest liquidity both amounts can fund at `sqrtP` in the range [sqrtA, sqrtB] (LiquidityAmounts.getLiquidityForAmounts).
    function liquidityForAmounts(uint160 sqrtP, uint160 sqrtA, uint160 sqrtB, uint256 a0, uint256 a1) internal pure returns (uint128) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        uint256 liquidity;
        if (sqrtP <= sqrtA) liquidity = liquidityForAmount0(sqrtA, sqrtB, a0);
        else if (sqrtP < sqrtB) {
            uint256 l0 = liquidityForAmount0(sqrtP, sqrtB, a0);
            uint256 l1 = liquidityForAmount1(sqrtA, sqrtP, a1);
            liquidity = l0 < l1 ? l0 : l1;
        } else liquidity = liquidityForAmount1(sqrtA, sqrtB, a1);
        return liquidity > type(uint128).max ? type(uint128).max : uint128(liquidity);
    }

    /// @dev The token amounts `liquidity` needs at `sqrtP` in [sqrtA, sqrtB], rounded up (what a mint takes).
    function amountsForLiquidity(uint160 sqrtP, uint160 sqrtA, uint160 sqrtB, uint256 liquidity) internal pure returns (uint256 a0, uint256 a1) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        if (sqrtP <= sqrtA) a0 = amount0Delta(sqrtA, sqrtB, liquidity);
        else if (sqrtP < sqrtB) {
            a0 = amount0Delta(sqrtP, sqrtB, liquidity);
            a1 = amount1Delta(sqrtA, sqrtP, liquidity);
        } else a1 = amount1Delta(sqrtA, sqrtB, liquidity);
    }

    /// @dev liquidity × (sqrtB − sqrtA) / (sqrtA × sqrtB) in token0, rounded up.
    function amount0Delta(uint160 sqrtA, uint160 sqrtB, uint256 liquidity) internal pure returns (uint256) {
        uint256 numerator1 = liquidity << 96;
        uint256 numerator2 = uint256(sqrtB) - uint256(sqrtA);
        return CurveMath.mulDivUp(CurveMath.mulDivUp(numerator1, numerator2, sqrtB), 1, sqrtA);
    }

    /// @dev liquidity × (sqrtB − sqrtA) in token1, rounded up.
    function amount1Delta(uint160 sqrtA, uint160 sqrtB, uint256 liquidity) internal pure returns (uint256) {
        return CurveMath.mulDivUp(liquidity, uint256(sqrtB) - uint256(sqrtA), Q96);
    }

    /// @dev sqrt(amount1 / amount0) × 2^96: the price of token1 per token0 that deposits both amounts in full.
    function sqrtPriceForAmounts(uint256 a0, uint256 a1) internal pure returns (uint160) {
        uint256 root;
        if (a1 / a0 < (1 << 64)) {
            root = CurveMath.sqrt(CurveMath.mulDiv(a1, 1 << 192, a0));
        } else if (a1 / a0 < (1 << 160)) {
            root = CurveMath.sqrt(CurveMath.mulDiv(a1, 1 << 96, a0)) << 48; // a huge ratio: 48 bits less precision, still exact enough
        } else {
            return MAX_SQRT_PRICE - 1;
        }
        if (root < MIN_SQRT_PRICE) return MIN_SQRT_PRICE;
        if (root >= MAX_SQRT_PRICE) return MAX_SQRT_PRICE - 1;
        return uint160(root);
    }

    function poolId(PoolKey memory key) internal pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    /// @dev The pool's current sqrt price, 0 before initialization (StateLibrary.getSlot0 through extsload).
    function sqrtPriceX96(IPoolManager manager, bytes32 id) internal view returns (uint160) {
        bytes32 slot = keccak256(abi.encodePacked(id, POOLS_SLOT));
        return uint160(uint256(manager.extsload(slot)));
    }

    /// @dev The pool's sqrt price and tick (slot0 packs the price in the low 160 bits and the tick in the next 24).
    function slot0(IPoolManager manager, bytes32 id) internal view returns (uint160 sqrtP, int24 tick) {
        bytes32 slot = keccak256(abi.encodePacked(id, POOLS_SLOT));
        uint256 value = uint256(manager.extsload(slot));
        sqrtP = uint160(value);
        tick = int24(uint24(value >> 160));
    }

    /// @dev The pool's active liquidity (StateLibrary.getLiquidity: the pool state's fourth slot).
    function poolLiquidity(IPoolManager manager, bytes32 id) internal view returns (uint128) {
        bytes32 slot = bytes32(uint256(keccak256(abi.encodePacked(id, POOLS_SLOT))) + 3);
        return uint128(uint256(manager.extsload(slot)));
    }

    function amount0(int256 delta) internal pure returns (int128) {
        return int128(delta >> 128);
    }

    function amount1(int256 delta) internal pure returns (int128) {
        return int128(delta);
    }
}
