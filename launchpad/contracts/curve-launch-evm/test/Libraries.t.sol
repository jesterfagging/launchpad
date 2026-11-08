// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./utils/TestBase.sol";
import {Calendar} from "../src/lib/Calendar.sol";
import {Oscillator} from "../src/lib/Oscillator.sol";
import {CurveMath} from "../src/lib/CurveMath.sol";
import {V4Math} from "../src/lib/V4Math.sol";
import {PoolKey} from "../src/interfaces/IUniswapV4.sol";
import {LaunchFeeEscrow} from "../src/LaunchFeeEscrow.sol";
import {MockERC20} from "./mocks/MockTokens.sol";
import {MockPoolManager} from "./mocks/MockPoolManager.sol";

/// @notice The library ports checked against the Solana hook program's own test values (calendar.rs, osc.rs), plus the
/// math library, the Uniswap v4 arithmetic against Uniswap's TickMath constants and a high-precision 1.0001^(t/2),
/// and the escrow on its own.
contract LibrariesTest is TestBase {
    int256 internal constant DAY = 86_400;

    function ts(int256 y, uint256 m, uint256 d, int256 hh, int256 mm) internal pure returns (int256) {
        return Calendar.daysFromCivil(y, m, d) * DAY + hh * 3_600 + mm * 60;
    }

    function holiday(int256 y, uint256 m, uint256 d) internal pure returns (bool) {
        return Calendar.isNyseHoliday(Calendar.daysFromCivil(y, m, d));
    }

    // ---------------------------------------------------------------- calendar

    function testCivilConversionsRoundTrip() public pure {
        assertEq(uint256(Calendar.daysFromCivil(1970, 1, 1)), 0, "epoch");
        assertEq(uint256(Calendar.daysFromCivil(2000, 3, 1)), 11_017, "2000-03-01");
        assertEq(uint256(Calendar.daysFromCivil(2024, 1, 1)), 19_723, "2024-01-01");
        assertTrue(Calendar.daysFromCivil(1969, 12, 31) == -1, "the day before the epoch");
        (int256 y, uint256 m, uint256 d) = Calendar.civilFromDays(19_723);
        assertTrue(y == 2024 && m == 1 && d == 1, "back to 2024-01-01");
        (y, m, d) = Calendar.civilFromDays(-1);
        assertTrue(y == 1969 && m == 12 && d == 31, "back to 1969-12-31");
        (y, m, d) = Calendar.civilFromDays(Calendar.daysFromCivil(2024, 2, 29));
        assertTrue(y == 2024 && m == 2 && d == 29, "leap day");
        for (int256 dayNumber = -4_000; dayNumber < 40_000; dayNumber += 97) {
            (int256 yy, uint256 mm, uint256 dd) = Calendar.civilFromDays(dayNumber);
            assertTrue(mm >= 1 && mm <= 12 && dd >= 1 && dd <= Calendar.daysInMonth(yy, mm), "valid date");
            assertTrue(Calendar.daysFromCivil(yy, mm, dd) == dayNumber, "round trip");
        }
    }

    function testWeekdaysLeapYearsAndNthWeekdays() public pure {
        assertEq(Calendar.weekdayFromDays(0), Calendar.THURSDAY, "1970-01-01 was a Thursday");
        assertEq(Calendar.weekdayFromDays(Calendar.daysFromCivil(2024, 1, 1)), Calendar.MONDAY, "2024-01-01");
        assertEq(Calendar.weekdayFromDays(Calendar.daysFromCivil(2023, 11, 14)), 1, "Tuesday");
        assertEq(Calendar.weekdayFromDays(Calendar.daysFromCivil(2026, 10, 4)), Calendar.SUNDAY, "2026-10-04");
        assertTrue(Calendar.isLeapYear(2000) && Calendar.isLeapYear(2024) && !Calendar.isLeapYear(1900) && !Calendar.isLeapYear(2023), "leap years");
        assertEq(Calendar.daysInMonth(2024, 2), 29, "Feb 2024");
        assertEq(Calendar.daysInMonth(2023, 2), 28, "Feb 2023");
        assertEq(Calendar.nthWeekdayOfMonth(2024, 1, Calendar.MONDAY, 3), 15, "MLK day 2024");
        assertEq(Calendar.nthWeekdayOfMonth(2024, 11, Calendar.THURSDAY, 4), 28, "Thanksgiving 2024");
        assertEq(Calendar.nthWeekdayOfMonth(2024, 3, Calendar.SUNDAY, 2), 10, "second Sunday of March 2024");
        assertEq(Calendar.nthWeekdayOfMonth(2024, 11, Calendar.SUNDAY, 1), 3, "first Sunday of November 2024");
        assertEq(Calendar.lastWeekdayOfMonth(2024, 5, Calendar.MONDAY), 27, "Memorial day 2024");
        assertEq(Calendar.lastWeekdayOfMonth(2024, 3, Calendar.SUNDAY), 31, "last Sunday of March 2024");
        assertEq(Calendar.lastWeekdayOfMonth(2024, 10, Calendar.SUNDAY), 27, "last Sunday of October 2024");
        assertEq(Calendar.lastWeekdayOfMonth(2026, 3, Calendar.SUNDAY), 29, "last Sunday of March 2026");
        assertEq(Calendar.lastWeekdayOfMonth(2026, 10, Calendar.SUNDAY), 25, "last Sunday of October 2026");
    }

    function testEaster() public pure {
        (uint256 m, uint256 d) = Calendar.easterSunday(2000); assertTrue(m == 4 && d == 23, "2000");
        (m, d) = Calendar.easterSunday(2019); assertTrue(m == 4 && d == 21, "2019");
        (m, d) = Calendar.easterSunday(2023); assertTrue(m == 4 && d == 9, "2023");
        (m, d) = Calendar.easterSunday(2024); assertTrue(m == 3 && d == 31, "2024");
        (m, d) = Calendar.easterSunday(2025); assertTrue(m == 4 && d == 20, "2025");
        (m, d) = Calendar.easterSunday(2026); assertTrue(m == 4 && d == 5, "2026");
        (m, d) = Calendar.easterSunday(2027); assertTrue(m == 3 && d == 28, "2027");
        (m, d) = Calendar.easterSunday(2038); assertTrue(m == 4 && d == 25, "2038");
        (m, d) = Calendar.easterSunday(1818); assertTrue(m == 3 && d == 22, "earliest possible date");
    }

    function testNyseHolidays() public pure {
        assertTrue(holiday(2021, 7, 5) && !holiday(2021, 7, 4), "July 4 2021 (Sunday) observed Monday");
        assertTrue(holiday(2021, 12, 24) && !holiday(2021, 12, 25), "Christmas 2021 (Saturday) observed Friday");
        assertTrue(holiday(2022, 6, 20) && !holiday(2022, 6, 19), "Juneteenth 2022 (Sunday) observed Monday");
        assertTrue(holiday(2022, 12, 26), "Christmas 2022 (Sunday) observed Monday");
        assertTrue(holiday(2026, 7, 3) && !holiday(2026, 7, 4), "July 4 2026 (Saturday) observed Friday");
        assertTrue(holiday(2027, 12, 24), "Christmas 2027 (Saturday) observed Friday");
        assertTrue(holiday(2023, 1, 2) && !holiday(2023, 1, 1), "Jan 1 2023 (Sunday) observed Monday");
        assertTrue(!holiday(2022, 1, 1) && !holiday(2021, 12, 31), "Jan 1 2022 (Saturday) is not observed");
        assertTrue(!holiday(2027, 12, 31) && !holiday(2028, 1, 1), "Jan 1 2028 (Saturday) is not observed");
        assertTrue(holiday(2026, 1, 1) && holiday(2027, 1, 1), "ordinary New Year's Days");
        assertTrue(holiday(2023, 4, 7), "Good Friday 2023");
        assertTrue(holiday(2026, 4, 3), "Good Friday 2026");
        assertTrue(holiday(2025, 4, 18), "Good Friday 2025");
        assertTrue(holiday(2026, 1, 19) && holiday(2026, 2, 16) && holiday(2026, 5, 25) && holiday(2026, 9, 7) && holiday(2026, 11, 26) && holiday(2026, 12, 25), "the 2026 calendar");
        assertTrue(!holiday(2026, 11, 27), "the Friday after Thanksgiving is an early close, not a holiday");
        assertTrue(!holiday(2024, 10, 14), "Columbus Day is not an NYSE holiday");
        assertTrue(!holiday(2024, 11, 11), "Veterans Day is not an NYSE holiday");
    }

    function testDaylightSaving() public pure {
        assertTrue(!Calendar.usDstActive(ts(2024, 3, 10, 1, 59)), "before the US spring switch");
        assertTrue(Calendar.usDstActive(ts(2024, 3, 10, 2, 0)), "at the US spring switch");
        assertTrue(Calendar.usDstActive(ts(2024, 11, 3, 0, 59)), "before the US autumn switch");
        assertTrue(!Calendar.usDstActive(ts(2024, 11, 3, 1, 0)), "at the US autumn switch");
        assertTrue(Calendar.usDstActive(ts(2025, 3, 9, 2, 0)) && !Calendar.usDstActive(ts(2025, 3, 9, 1, 59)), "2025 spring");
        assertTrue(!Calendar.usDstActive(ts(2025, 11, 2, 1, 0)) && Calendar.usDstActive(ts(2025, 11, 2, 0, 59)), "2025 autumn");
        assertTrue(Calendar.usDstActive(ts(2026, 3, 8, 2, 0)) && !Calendar.usDstActive(ts(2026, 11, 1, 1, 0)), "2026");
        assertTrue(!Calendar.usDstActive(ts(2024, 1, 15, 12, 0)) && !Calendar.usDstActive(ts(2024, 12, 15, 12, 0)) && Calendar.usDstActive(ts(2024, 7, 1, 12, 0)), "seasons");
        assertTrue(!Calendar.euDstActive(ts(2024, 3, 31, 0, 59)), "before the EU spring switch");
        assertTrue(Calendar.euDstActive(ts(2024, 3, 31, 1, 0)), "at the EU spring switch");
        assertTrue(Calendar.euDstActive(ts(2024, 10, 27, 0, 59)), "before the EU autumn switch");
        assertTrue(!Calendar.euDstActive(ts(2024, 10, 27, 1, 0)), "at the EU autumn switch");
        assertTrue(Calendar.euDstActive(ts(2026, 3, 29, 1, 0)) && !Calendar.euDstActive(ts(2026, 10, 25, 1, 0)), "EU 2026");
        assertTrue(Calendar.localTime(ts(2024, 1, 2, 14, 30), Calendar.NEW_YORK_OFFSET_MINUTES, Calendar.DST_US) == ts(2024, 1, 2, 9, 30), "New York in winter");
        assertTrue(Calendar.localTime(ts(2024, 7, 8, 13, 30), Calendar.NEW_YORK_OFFSET_MINUTES, Calendar.DST_US) == ts(2024, 7, 8, 9, 30), "New York in summer");
    }

    function testNyseOpenAndTradingWindows() public pure {
        assertTrue(Calendar.nyseOpen(ts(2024, 1, 2, 14, 30), false), "09:30 opens");
        assertTrue(!Calendar.nyseOpen(ts(2024, 1, 2, 14, 29), false), "09:29 is closed");
        assertTrue(!Calendar.nyseOpen(ts(2024, 1, 2, 21, 0), false), "16:00 closes");
        assertTrue(Calendar.nyseOpen(ts(2024, 1, 2, 20, 59), false), "15:59 is open");
        assertTrue(!Calendar.nyseOpen(ts(2024, 1, 15, 15, 0), false) && Calendar.nyseOpen(ts(2024, 1, 15, 15, 0), true), "MLK day, unless holidays are ignored");
        assertTrue(!Calendar.nyseOpen(ts(2024, 1, 6, 15, 0), false), "Saturday");
        // 22:00-02:00 on Friday nights, Central European time with EU daylight saving.
        uint256 friday = 1 << 4;
        assertTrue(Calendar.tradingWindowOpen(ts(2024, 7, 12, 21, 0), 1320, 120, friday, 60, Calendar.DST_EU), "23:00 CEST Friday");
        assertTrue(Calendar.tradingWindowOpen(ts(2024, 7, 12, 23, 30), 1320, 120, friday, 60, Calendar.DST_EU), "01:30 CEST Saturday, inside the Friday window");
        assertTrue(!Calendar.tradingWindowOpen(ts(2024, 7, 13, 0, 30), 1320, 120, friday, 60, Calendar.DST_EU), "02:30 CEST Saturday");
        assertTrue(!Calendar.tradingWindowOpen(ts(2024, 7, 11, 21, 0), 1320, 120, friday, 60, Calendar.DST_EU), "Thursday");
        assertTrue(Calendar.tradingWindowOpen(ts(2024, 7, 10, 12, 0), 0, 1440, 127, 0, Calendar.DST_NONE), "all day every day");
    }

    // ---------------------------------------------------------------- oscillator

    function testSineTableAndInterpolation() public pure {
        assertEq(Oscillator.sinQuarter(0), 0, "sin 0");
        assertEq(Oscillator.sinQuarter(128), 46_341, "sqrt(2)/2");
        assertEq(Oscillator.sinQuarter(256), 65_536, "sin 90");
        for (uint256 i = 1; i <= 256; i++) assertTrue(Oscillator.sinQuarter(i) >= Oscillator.sinQuarter(i - 1), "monotonic");
        assertTrue(Oscillator.sinQ16(0) == 0, "0");
        assertTrue(Oscillator.sinQ16(Oscillator.PHASE_QUARTER) == Oscillator.Q16_ONE, "quarter");
        assertTrue(Oscillator.sinQ16(2 * Oscillator.PHASE_QUARTER) == 0, "half");
        assertTrue(Oscillator.sinQ16(3 * Oscillator.PHASE_QUARTER) == -Oscillator.Q16_ONE, "three quarters");
        assertTrue(Oscillator.sinQ16(Oscillator.PHASE_CYCLE) == 0, "wraps");
        assertTrue(Oscillator.cosQ16(0) == Oscillator.Q16_ONE && Oscillator.cosQ16(2 * Oscillator.PHASE_QUARTER) == -Oscillator.Q16_ONE && Oscillator.cosQ16(Oscillator.PHASE_QUARTER) == 0, "cos");
        assertTrue(Oscillator.sinQ16(8_192) == 46_341, "45 degrees");
        assertEq(Oscillator.phaseInCycle(150, 600), Oscillator.PHASE_QUARTER, "a quarter of the way");
        assertEq(Oscillator.advancePhase(Oscillator.PHASE_QUARTER, 450, 600), 0, "advances and wraps");
        assertEq(Oscillator.alignmentQ16(0, 600), uint256(Oscillator.Q16_ONE), "on the beat");
        assertEq(Oscillator.alignmentQ16(300, 600), 0, "half way between beats");
    }

    function testDecayKickAndCaps() public pure {
        assertEq(Oscillator.decayFactor(0, 100), Oscillator.DECAY_SCALE, "no damping, no loss");
        assertEq(Oscillator.decayFactor(1, 0), Oscillator.DECAY_SCALE, "no time, no loss");
        assertEq(Oscillator.decayFactor(100, 1), 0, "full damping");
        assertEq(Oscillator.decayFactor(1, 600), 0, "cut off after ten idle minutes");
        assertApprox(Oscillator.decayFactor(1, 150), 221_396_000_000, 500_000_000, "0.99^150");
        assertEq(Oscillator.applyDecay(1_000_000, Oscillator.DECAY_SCALE / 2), 500_000, "half");
        assertEq(Oscillator.kick(0, 50, 100, 100, uint256(Oscillator.Q16_ONE)), 500_000, "a full buy adds half the energy");
        assertEq(Oscillator.kick(0, 50, 50, 100, uint256(Oscillator.Q16_ONE)), 250_000, "a half buy adds a quarter");
        assertEq(Oscillator.kick(900_000, 50, 100, 100, uint256(Oscillator.Q16_ONE)), 1_000_000, "capped at one");
        assertEq(Oscillator.kick(0, 50, 100, 100, uint256(Oscillator.Q16_ONE) / 2), 250_000, "half aligned");
        assertEq(Oscillator.capWithSwing(100, 500_000, Oscillator.Q16_ONE, 50), 150, "base x (1 + energy x sin)");
        assertEq(Oscillator.capWithSwing(100, 1_000_000, -Oscillator.Q16_ONE, 50), 50, "floored");
        assertEq(Oscillator.capWithEnergy(100, 500_000, 50), 150, "base x (1 + energy)");
        assertEq(Oscillator.breathingCap(100, 50, Oscillator.Q16_ONE, 50), 150, "breathing peak");
        assertEq(Oscillator.breathingCap(100, 50, -Oscillator.Q16_ONE, 70), 70, "breathing trough, floored");
        assertEq(Oscillator.clampCap(20_000, 0), 10_000, "never above 100%");
        (uint256 a, uint256 b) = Oscillator.coupledStep(1_000_000, 0, 50, 0, 1);
        assertTrue(a + b == 1_000_000 && b == 250_000, "a second of coupling moves a quarter across, nothing lost without damping");
        (a, b) = Oscillator.coupledStep(1_000_000, 0, 50, 0, 1000);
        assertTrue(a == 500_000 && b == 500_000, "they equalise");
    }

    function testOscillatorStep() public pure {
        Oscillator.State memory o;
        Oscillator.step(o, 1_000, 600, 1, 0);
        assertEq(o.ts, 1_000, "first call stamps the time");
        o.energy = 500_000;
        Oscillator.step(o, 1_150, 600, 1, 0);
        assertEq(o.phase, Oscillator.PHASE_QUARTER, "a quarter period later");
        assertApprox(o.energy, 110_698, 300, "decayed");
        Oscillator.step(o, 1_150 + 600, 600, 1, 0);
        assertEq(o.energy, 0, "gone after ten idle minutes");
        assertEq(o.phase, Oscillator.PHASE_QUARTER, "a whole period keeps the phase");
    }

    // ---------------------------------------------------------------- math

    function testMulDivAndSqrt() public pure {
        assertEq(CurveMath.mulDiv(1e30, 1e30, 1e30), 1e30, "mulDiv through the 512-bit path");
        assertEq(CurveMath.mulDiv(type(uint256).max, 3, 3), type(uint256).max, "max");
        assertEq(CurveMath.mulDiv(7, 3, 2), 10, "floor");
        assertEq(CurveMath.mulDivUp(7, 3, 2), 11, "ceil");
        assertEq(CurveMath.mulDivUp(6, 3, 2), 9, "exact stays");
        assertEq(CurveMath.sqrt(0), 0, "sqrt 0");
        assertEq(CurveMath.sqrt(1), 1, "sqrt 1");
        assertEq(CurveMath.sqrt(15), 3, "sqrt 15");
        assertEq(CurveMath.sqrt(16), 4, "sqrt 16");
        assertEq(CurveMath.sqrt(1e36), 1e18, "sqrt 1e36");
        assertEq(CurveMath.sqrt(type(uint256).max), 340282366920938463463374607431768211455, "sqrt max");
        assertEq(CurveMath.sqrt((1 << 192) * 4), 1 << 97, "sqrt of a Q192 ratio");
    }

    function testMulDivOverflowReverts() public {
        vm.expectRevert(CurveMath.MathOverflow.selector);
        this.mulDivExternal(type(uint256).max, 2, 1);
    }

    function mulDivExternal(uint256 a, uint256 b, uint256 d) external pure returns (uint256) { return CurveMath.mulDiv(a, b, d); }

    // ---------------------------------------------------------------- Uniswap v4 arithmetic

    function sqrtAtTickExternal(int24 tick) external pure returns (uint160) { return V4Math.getSqrtPriceAtTick(tick); }

    function assertTick(int24 tick, uint256 expected) internal pure {
        // 2^96 * 1.0001^(tick / 2) to 80 digits; Uniswap's bit-by-bit product is within a few parts in 1e18 of it.
        uint256 got = uint256(V4Math.getSqrtPriceAtTick(tick));
        assertApprox(got, expected, expected / 1e15 + 1, "sqrt price at tick");
    }

    function testTickMathMatchesUniswap() public {
        assertEq(uint256(V4Math.getSqrtPriceAtTick(V4Math.MIN_TICK)), uint256(V4Math.MIN_SQRT_PRICE), "MIN_TICK -> MIN_SQRT_PRICE");
        assertEq(uint256(V4Math.getSqrtPriceAtTick(V4Math.MAX_TICK)), uint256(V4Math.MAX_SQRT_PRICE), "MAX_TICK -> MAX_SQRT_PRICE");
        assertEq(uint256(V4Math.getSqrtPriceAtTick(0)), 1 << 96, "tick 0 is 2^96");
        assertTick(1, 79232123823359799118286999567);
        assertTick(-1, 79224201403219477170569942573);
        assertTick(100, 79625275426524748796330556127);
        assertTick(-100, 78833030112140176575862854578);
        assertTick(1000, 83290069058676223003182343269);
        assertTick(-1000, 75364347830767020784054125654);
        assertTick(5000, 101729702841318637793976746269);
        assertTick(-5000, 61703726247759831737814779830);
        assertTick(100000, 11755562826496067164730007768449);
        assertTick(-100000, 533968626430936354154228407);
        assertTick(443636, 340275971719517849884101479063205952279);
        assertTick(-443636, 18447090764788882727);
        assertTick(887200, 1456195216270955103182949462556801019286893565306);
        assertTick(-887200, 4310618291);
        // Monotonic across the single-bit ticks the product is built from.
        uint160 previous = 0;
        for (int24 tick = -887272; tick <= 887272; tick += 61_523) {
            uint160 price = V4Math.getSqrtPriceAtTick(tick);
            assertTrue(price > previous, "increasing");
            previous = price;
        }
        vm.expectRevert(abi.encodeWithSelector(V4Math.TickOutOfRange.selector, int24(887273)));
        this.sqrtAtTickExternal(887273);
        vm.expectRevert(abi.encodeWithSelector(V4Math.TickOutOfRange.selector, int24(-887273)));
        this.sqrtAtTickExternal(-887273);
        (int24 lower, int24 upper) = V4Math.fullRange(200);
        assertTrue(lower == -887200 && upper == 887200, "full range for spacing 200");
        (lower, upper) = V4Math.fullRange(60);
        assertTrue(lower == -887220 && upper == 887220, "full range for spacing 60");
        (lower, upper) = V4Math.fullRange(1);
        assertTrue(lower == -887272 && upper == 887272, "full range for spacing 1");
    }

    /// getTickAtSqrtPrice is the inverse of getSqrtPriceAtTick across the whole range, at the boundaries of every tick.
    function testTickAtSqrtPriceInvertsSqrtPriceAtTick() public pure {
        assertEq(int256(V4Math.getTickAtSqrtPrice(V4Math.MIN_SQRT_PRICE)), int256(V4Math.MIN_TICK), "min");
        assertEq(int256(V4Math.getTickAtSqrtPrice(V4Math.MAX_SQRT_PRICE - 1)), int256(V4Math.MAX_TICK - 1), "max - 1");
        assertEq(int256(V4Math.getTickAtSqrtPrice(uint160(1 << 96))), 0, "tick 0");
        assertEq(int256(V4Math.getTickAtSqrtPrice(uint160((1 << 96) - 1))), -1, "just under tick 0");
        int24[14] memory ticks = [int24(-887271), -887200, -443636, -100000, -5000, -1000, -100, -1, 1, 100, 1000, 5000, 100000, 443636];
        for (uint256 i = 0; i < ticks.length; i++) {
            int24 tick = ticks[i];
            uint160 at = V4Math.getSqrtPriceAtTick(tick);
            assertEq(int256(V4Math.getTickAtSqrtPrice(at)), int256(tick), "at the tick");
            assertEq(int256(V4Math.getTickAtSqrtPrice(at - 1)), int256(tick - 1), "one below the tick");
            uint160 next = V4Math.getSqrtPriceAtTick(tick + 1);
            assertEq(int256(V4Math.getTickAtSqrtPrice(next - 1)), int256(tick), "just under the next tick");
        }
        for (int24 tick = -887000; tick <= 887000; tick += 37_811) {
            uint160 at = V4Math.getSqrtPriceAtTick(tick);
            assertEq(int256(V4Math.getTickAtSqrtPrice(at)), int256(tick), "sweep");
            assertEq(int256(V4Math.getTickAtSqrtPrice(at + 1)), int256(tick), "sweep + 1 wei of price");
        }
        assertEq(uint256(V4Math.mostSignificantBit(1)), 0, "msb 1");
        assertEq(uint256(V4Math.mostSignificantBit(2)), 1, "msb 2");
        assertEq(uint256(V4Math.mostSignificantBit(type(uint256).max)), 255, "msb max");
        assertEq(uint256(V4Math.mostSignificantBit(1 << 200)), 200, "msb 2^200");
        // Alignment: down towards negative infinity, up towards positive, inside the usable range.
        assertEq(int256(V4Math.alignDown(199, 200)), 0, "down 199"); assertEq(int256(V4Math.alignDown(-1, 200)), -200, "down -1"); assertEq(int256(V4Math.alignDown(-200, 200)), -200, "down -200"); assertEq(int256(V4Math.alignDown(401, 200)), 400, "down 401");
        assertEq(int256(V4Math.alignUp(1, 200)), 200, "up 1"); assertEq(int256(V4Math.alignUp(-199, 200)), 0, "up -199"); assertEq(int256(V4Math.alignUp(400, 200)), 400, "up 400"); assertEq(int256(V4Math.alignUp(-401, 200)), -400, "up -401");
        assertEq(int256(V4Math.alignDown(-887272, 200)), -887200, "down min"); assertEq(int256(V4Math.alignUp(887272, 200)), 887200, "up max"); assertEq(int256(V4Math.alignUp(887201, 10)), 887210, "up 887201"); assertEq(int256(V4Math.alignUp(887271, 10)), 887270, "up capped at the usable max");
    }

    function testLiquidityAmountsRoundTrip() public pure {
        // The graduation deposit: 85 ETH (currency0) against the pool share of the supply (currency1).
        uint256 amount0 = 85 ether;
        uint256 amount1 = 208695652173913043478260869;
        uint160 sqrtP = V4Math.sqrtPriceForAmounts(amount0, amount1);
        // sqrt(amount1 / amount0) * 2^96, so the price (currency1 per currency0) is amount1 / amount0 (18 decimals both sides).
        uint256 price = CurveMath.mulDiv(uint256(sqrtP) * uint256(sqrtP), 1e18, 1 << 192);
        assertApproxBps(price, amount1 * 1e18 / amount0, 1, "price from amounts");
        (int24 lower, int24 upper) = V4Math.fullRange(200);
        uint160 sqrtA = V4Math.getSqrtPriceAtTick(lower);
        uint160 sqrtB = V4Math.getSqrtPriceAtTick(upper);
        uint128 liquidity = V4Math.liquidityForAmounts(sqrtP, sqrtA, sqrtB, amount0, amount1);
        assertTrue(liquidity > 0, "liquidity");
        (uint256 need0, uint256 need1) = V4Math.amountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity);
        assertTrue(need0 <= amount0 && need1 <= amount1, "a mint never takes more than was offered");
        assertApprox(need0, amount0, 1e6, "uses almost all of currency0");
        assertApprox(need1, amount1, 1e12, "uses almost all of currency1");
        // The single-sided helpers agree with the two-sided one at both edges.
        assertEq(V4Math.liquidityForAmounts(sqrtA, sqrtA, sqrtB, amount0, 0), uint128(V4Math.liquidityForAmount0(sqrtA, sqrtB, amount0)), "all currency0 below the range");
        assertEq(V4Math.liquidityForAmounts(sqrtB, sqrtA, sqrtB, 0, amount1), uint128(V4Math.liquidityForAmount1(sqrtA, sqrtB, amount1)), "all currency1 above the range");
        // Clamping: a ratio beyond the tick range lands on the bounds.
        assertEq(uint256(V4Math.sqrtPriceForAmounts(1e40, 1)), uint256(V4Math.MIN_SQRT_PRICE), "tiny price clamps to MIN");
        assertEq(uint256(V4Math.sqrtPriceForAmounts(1, 1e40)), uint256(V4Math.MAX_SQRT_PRICE) - 1, "huge price clamps below MAX");
        assertEq(uint256(V4Math.sqrtPriceForAmounts(1, 1e60)), uint256(V4Math.MAX_SQRT_PRICE) - 1, "a ratio past 2^160 clamps too");
        // A ratio past 2^64 takes the lower-precision path and still lands within a part in 1e12 of the true root.
        uint256 big = uint256(V4Math.sqrtPriceForAmounts(1, 1 << 70)); // sqrt(2^70) * 2^96 = 2^131
        assertApprox(big, 1 << 131, uint256(1 << 131) / 1e12, "2^131");
    }

    function testBalanceDeltaUnpacking() public pure {
        int256 packed;
        int256 a0 = -5 ether;
        int256 a1 = 3 ether;
        assembly {
            packed := or(shl(128, a0), and(sub(shl(128, 1), 1), a1))
        }
        assertTrue(V4Math.amount0(packed) == int128(a0), "amount0 is the upper half, signed");
        assertTrue(V4Math.amount1(packed) == int128(a1), "amount1 is the lower half");
        a0 = 7;
        a1 = -9;
        assembly {
            packed := or(shl(128, a0), and(sub(shl(128, 1), 1), a1))
        }
        assertTrue(V4Math.amount0(packed) == 7, "positive upper");
        assertTrue(V4Math.amount1(packed) == -9, "negative lower");
    }

    function testPoolIdAndSlot0ReadThroughExtsload() public {
        MockPoolManager pm = new MockPoolManager();
        PoolKey memory key = PoolKey({currency0: address(0), currency1: address(0xBEEF), fee: 10000, tickSpacing: 200, hooks: address(0)});
        bytes32 id = V4Math.poolId(key);
        assertEq(id, keccak256(abi.encode(key)), "PoolId.toId is the abi hash of the key");
        assertEq(uint256(V4Math.sqrtPriceX96(pm, id)), 0, "0 before initialize");
        pm.initialize(key, 1 << 96);
        assertEq(uint256(V4Math.sqrtPriceX96(pm, id)), 1 << 96, "slot0's sqrt price, read at keccak(poolId . 6)");
        vm.expectRevert(MockPoolManager.PoolAlreadyInitialized.selector);
        pm.initialize(key, 1 << 96);
        vm.expectRevert(MockPoolManager.CurrenciesOutOfOrderOrEqual.selector);
        pm.initialize(PoolKey({currency0: address(0xBEEF), currency1: address(0), fee: 10000, tickSpacing: 200, hooks: address(0)}), 1 << 96);
    }

    // ---------------------------------------------------------------- escrow

    function testEscrowCreditsAndClaims() public {
        LaunchFeeEscrow escrow = new LaunchFeeEscrow();
        MockERC20 token = new MockERC20("Pair", "PAIR", 6);
        address alice = address(0xA1);
        address bob = address(0xB0B);
        vm.deal(address(this), 10 ether);
        escrow.credit{value: 1 ether}(alice);
        escrow.credit{value: 2 ether}(alice);
        assertEq(escrow.balanceOf(alice), 3 ether, "ETH credited");
        vm.expectRevert(LaunchFeeEscrow.ZeroAmount.selector);
        escrow.credit{value: 0}(alice);
        vm.expectRevert(LaunchFeeEscrow.ZeroRecipient.selector);
        escrow.credit{value: 1}(address(0));
        token.mint(address(this), 1_000e6);
        token.approve(address(escrow), 1_000e6);
        escrow.creditToken(alice, address(token), 400e6);
        assertEq(escrow.balanceOfToken(alice, address(token)), 400e6, "token credited");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LaunchFeeEscrow.InsufficientBalance.selector, 3 ether, 4 ether));
        escrow.claim(alice, 4 ether);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(LaunchFeeEscrow.InsufficientBalance.selector, 0, 0));
        escrow.claimAll(bob);
        vm.prank(alice);
        escrow.claim(bob, 1 ether);
        assertEq(bob.balance, 1 ether, "claimed to bob");
        assertEq(escrow.balanceOf(alice), 2 ether, "remaining");
        vm.prank(alice);
        escrow.claimAllToken(address(token), bob);
        assertEq(token.balanceOf(bob), 400e6, "token claimed to bob");
        assertEq(escrow.balanceOfToken(alice, address(token)), 0, "cleared");
    }
}
