// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Calendar
/// @notice The time rules' calendar, ported function for function from the Solana hook program's `calendar.rs`:
/// proleptic Gregorian dates from unix days, weekdays (Monday = 0 … Sunday = 6), nth/last weekdays of a month, Gregorian
/// Easter, the NYSE holiday calendar, US and EU daylight-saving rules, and the open/closed decisions built on them.
/// Pure integer arithmetic over unix seconds; the hook program's tests are mirrored in test/Calendar.t.sol.
library Calendar {
    int256 internal constant SECONDS_PER_DAY = 86_400;
    uint256 internal constant MINUTES_PER_DAY = 1_440;
    uint256 internal constant MONDAY = 0;
    uint256 internal constant THURSDAY = 3;
    uint256 internal constant SATURDAY = 5;
    uint256 internal constant SUNDAY = 6;
    uint8 internal constant DST_NONE = 0;
    uint8 internal constant DST_US = 1;
    uint8 internal constant DST_EU = 2;
    int256 internal constant NEW_YORK_OFFSET_MINUTES = -300;
    uint256 internal constant NYSE_OPEN_MINUTE = 9 * 60 + 30;
    uint256 internal constant NYSE_CLOSE_MINUTE = 16 * 60;

    function floorDiv(int256 a, int256 b) internal pure returns (int256) {
        int256 q = a / b;
        if ((a % b != 0) && ((a < 0) != (b < 0))) q -= 1;
        return q;
    }

    function floorMod(int256 a, int256 b) internal pure returns (int256) {
        int256 m = a % b;
        if (m < 0) m += b;
        return m;
    }

    /// @dev Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
    function daysFromCivil(int256 y, uint256 m, uint256 d) internal pure returns (int256) {
        if (m <= 2) y -= 1;
        int256 era = floorDiv(y, 400);
        int256 yoe = y - era * 400;
        int256 mp = int256((m + 9) % 12);
        int256 doy = (153 * mp + 2) / 5 + int256(d) - 1;
        int256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146_097 + doe - 719_468;
    }

    /// @dev (year, month 1..12, day 1..31) of a unix day number.
    function civilFromDays(int256 z) internal pure returns (int256 y, uint256 m, uint256 d) {
        z += 719_468;
        int256 era = floorDiv(z, 146_097);
        int256 doe = z - era * 146_097;
        int256 yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
        y = yoe + era * 400;
        int256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        int256 mp = (5 * doy + 2) / 153;
        d = uint256(doy - (153 * mp + 2) / 5 + 1);
        m = mp < 10 ? uint256(mp + 3) : uint256(mp - 9);
        if (m <= 2) y += 1;
    }

    /// @dev Monday = 0 … Sunday = 6 of a unix day number.
    function weekdayFromDays(int256 dayNumber) internal pure returns (uint256) {
        return uint256(floorMod(dayNumber + 3, 7));
    }

    function isLeapYear(int256 y) internal pure returns (bool) {
        return (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    }

    function daysInMonth(int256 y, uint256 m) internal pure returns (uint256) {
        if (m == 1 || m == 3 || m == 5 || m == 7 || m == 8 || m == 10 || m == 12) return 31;
        if (m == 4 || m == 6 || m == 9 || m == 11) return 30;
        return isLeapYear(y) ? 29 : 28;
    }

    /// @dev Day of month of the n-th (1-based) `weekday` in month `m` of year `y`.
    function nthWeekdayOfMonth(int256 y, uint256 m, uint256 weekday, uint256 n) internal pure returns (uint256) {
        uint256 first = weekdayFromDays(daysFromCivil(y, m, 1));
        uint256 offset = uint256(floorMod(int256(weekday) - int256(first), 7));
        return 1 + offset + 7 * (n - 1);
    }

    /// @dev Day of month of the last `weekday` in month `m` of year `y`.
    function lastWeekdayOfMonth(int256 y, uint256 m, uint256 weekday) internal pure returns (uint256) {
        uint256 last = daysInMonth(y, m);
        uint256 lastWeekday = weekdayFromDays(daysFromCivil(y, m, last));
        return last - uint256(floorMod(int256(lastWeekday) - int256(weekday), 7));
    }

    /// @dev Easter Sunday (month, day) of a Gregorian year (the anonymous/Meeus algorithm).
    function easterSunday(int256 y) internal pure returns (uint256 month, uint256 day) {
        int256 a = y % 19;
        int256 b = y / 100;
        int256 c = y % 100;
        int256 d = b / 4;
        int256 e = b % 4;
        int256 f = (b + 8) / 25;
        int256 g = (b - f + 1) / 3;
        int256 h = (19 * a + b - d - g + 15) % 30;
        int256 i = c / 4;
        int256 k = c % 4;
        int256 l = (32 + 2 * e + 2 * i - h - k) % 7;
        int256 m = (a + 11 * h + 22 * l) / 451;
        month = uint256((h + l - 7 * m + 114) / 31);
        day = uint256((h + l - 7 * m + 114) % 31 + 1);
    }

    /// @dev A fixed-date holiday observed on the nearest weekday: Saturday → Friday, Sunday → Monday.
    function observed(int256 y, uint256 m, uint256 d) internal pure returns (int256) {
        int256 dayNumber = daysFromCivil(y, m, d);
        uint256 weekday = weekdayFromDays(dayNumber);
        if (weekday == SATURDAY) return dayNumber - 1;
        if (weekday == SUNDAY) return dayNumber + 1;
        return dayNumber;
    }

    /// @dev Whether the unix day is a New York Stock Exchange holiday (New Year's Day observed Monday when on a Sunday
    /// and not observed when on a Saturday; MLK Day; Presidents' Day; Good Friday; Memorial Day; Juneteenth;
    /// Independence Day; Labor Day; Thanksgiving; Christmas, the fixed dates observed Friday/Monday on a weekend).
    function isNyseHoliday(int256 dayNumber) internal pure returns (bool) {
        (int256 y,,) = civilFromDays(dayNumber);
        int256 newYear = daysFromCivil(y, 1, 1);
        uint256 newYearWeekday = weekdayFromDays(newYear);
        if (newYearWeekday != SATURDAY) {
            int256 observedNewYear = newYearWeekday == SUNDAY ? newYear + 1 : newYear;
            if (observedNewYear == dayNumber) return true;
        }
        (uint256 easterMonth, uint256 easterDay) = easterSunday(y);
        if (dayNumber == daysFromCivil(y, 1, nthWeekdayOfMonth(y, 1, MONDAY, 3))) return true;
        if (dayNumber == daysFromCivil(y, 2, nthWeekdayOfMonth(y, 2, MONDAY, 3))) return true;
        if (dayNumber == daysFromCivil(y, easterMonth, easterDay) - 2) return true;
        if (dayNumber == daysFromCivil(y, 5, lastWeekdayOfMonth(y, 5, MONDAY))) return true;
        if (dayNumber == observed(y, 6, 19)) return true;
        if (dayNumber == observed(y, 7, 4)) return true;
        if (dayNumber == daysFromCivil(y, 9, nthWeekdayOfMonth(y, 9, MONDAY, 1))) return true;
        if (dayNumber == daysFromCivil(y, 11, nthWeekdayOfMonth(y, 11, THURSDAY, 4))) return true;
        if (dayNumber == observed(y, 12, 25)) return true;
        return false;
    }

    /// @dev US daylight saving, evaluated in local standard time: from the second Sunday of March 02:00 standard time
    /// until the first Sunday of November 02:00 daylight time (= 01:00 standard time).
    function usDstActive(int256 localStandard) internal pure returns (bool) {
        (int256 y,,) = civilFromDays(floorDiv(localStandard, SECONDS_PER_DAY));
        int256 start = daysFromCivil(y, 3, nthWeekdayOfMonth(y, 3, SUNDAY, 2)) * SECONDS_PER_DAY + 2 * 3_600;
        int256 end = daysFromCivil(y, 11, nthWeekdayOfMonth(y, 11, SUNDAY, 1)) * SECONDS_PER_DAY + 3_600;
        return localStandard >= start && localStandard < end;
    }

    /// @dev EU summer time, evaluated in UTC: from the last Sunday of March 01:00 UTC until the last Sunday of October 01:00 UTC.
    function euDstActive(int256 utc) internal pure returns (bool) {
        (int256 y,,) = civilFromDays(floorDiv(utc, SECONDS_PER_DAY));
        int256 start = daysFromCivil(y, 3, lastWeekdayOfMonth(y, 3, SUNDAY)) * SECONDS_PER_DAY + 3_600;
        int256 end = daysFromCivil(y, 10, lastWeekdayOfMonth(y, 10, SUNDAY)) * SECONDS_PER_DAY + 3_600;
        return utc >= start && utc < end;
    }

    /// @dev Local wall-clock seconds: UTC + the standard offset, plus one hour while the zone's daylight-saving rule is active.
    function localTime(int256 utc, int256 offsetMinutes, uint8 dstRule) internal pure returns (int256) {
        int256 standard = utc + offsetMinutes * 60;
        bool dst = dstRule == DST_US ? usDstActive(standard) : dstRule == DST_EU ? euDstActive(utc) : false;
        return dst ? standard + 3_600 : standard;
    }

    function minuteOfDay(int256 local) internal pure returns (uint256) {
        return uint256(floorMod(local, SECONDS_PER_DAY)) / 60;
    }

    function dayOf(int256 local) internal pure returns (int256) {
        return floorDiv(local, SECONDS_PER_DAY);
    }

    /// @dev NYSE regular session: Monday–Friday 09:30 ≤ New York time < 16:00, not a holiday unless `ignoreHolidays`.
    function nyseOpen(int256 utc, bool ignoreHolidays) internal pure returns (bool) {
        int256 local = localTime(utc, NEW_YORK_OFFSET_MINUTES, DST_US);
        int256 dayNumber = dayOf(local);
        uint256 minute = minuteOfDay(local);
        return weekdayFromDays(dayNumber) < SATURDAY && minute >= NYSE_OPEN_MINUTE && minute < NYSE_CLOSE_MINUTE && (ignoreHolidays || !isNyseHoliday(dayNumber));
    }

    /// @dev The creator's trading window: `open < close` → open ≤ minute < close on an allowed weekday; `close ≤ open`
    /// runs past midnight → minute ≥ open on an allowed weekday, or minute < close on the day after an allowed weekday.
    /// `weekdayMask` has Monday = bit 0. Open 0 / close 1440 is all day.
    function tradingWindowOpen(int256 utc, uint256 openMinute, uint256 closeMinute, uint256 weekdayMask, int256 offsetMinutes, uint8 dstRule) internal pure returns (bool) {
        int256 local = localTime(utc, offsetMinutes, dstRule);
        uint256 weekday = weekdayFromDays(dayOf(local));
        uint256 minute = minuteOfDay(local);
        if (openMinute < closeMinute) {
            return allowedDay(weekdayMask, weekday) && minute >= openMinute && minute < closeMinute;
        }
        return (allowedDay(weekdayMask, weekday) && minute >= openMinute) || (allowedDay(weekdayMask, (weekday + 6) % 7) && minute < closeMinute);
    }

    function allowedDay(uint256 mask, uint256 weekday) internal pure returns (bool) {
        return (mask >> weekday) & 1 == 1;
    }
}
