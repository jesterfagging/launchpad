//! Calendar math for the time rules (market_hours, trading_hours): proleptic
//! Gregorian dates from unix days, weekdays, nth/last weekdays of a month,
//! Gregorian Easter, the NYSE holiday calendar, US and EU daylight-saving rules
//! and the open/closed decisions built on them. Pure integer functions over
//! unix seconds; depends on nothing but core.
//!
//! Conventions: unix day 0 (1970-01-01) is a Thursday; weekdays are Monday = 0
//! … Sunday = 6 (the catalogue's `weekdays` bit mask uses the same order:
//! Monday = bit 0). Minutes of the day are 0..1440.

pub const SECONDS_PER_DAY: i64 = 86_400;
pub const MINUTES_PER_DAY: u64 = 1_440;
pub const MONDAY: u32 = 0;
pub const THURSDAY: u32 = 3;
pub const FRIDAY: u32 = 4;
pub const SATURDAY: u32 = 5;
pub const SUNDAY: u32 = 6;

/// Daylight-saving rule codes (parameter `dst` of trading_hours).
pub const DST_NONE: u8 = 0;
pub const DST_US: u8 = 1;
pub const DST_EU: u8 = 2;

/// New York standard time is UTC − 5 h.
pub const NEW_YORK_OFFSET_MINUTES: i64 = -300;
pub const NYSE_OPEN_MINUTE: u64 = 9 * 60 + 30;
pub const NYSE_CLOSE_MINUTE: u64 = 16 * 60;

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's algorithm).
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = ((m + 9) % 12) as i64; // March = 0
    let doy = (153 * mp + 2) / 5 + d as i64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// (year, month 1..=12, day 1..=31) of a unix day number.
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Monday = 0 … Sunday = 6 of a unix day number.
pub fn weekday_from_days(days: i64) -> u32 {
    (days + 3).rem_euclid(7) as u32
}

pub fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

pub fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if is_leap_year(y) {
                29
            } else {
                28
            }
        }
    }
}

/// Day of month of the n-th (1-based) `weekday` in month `m` of year `y`.
pub fn nth_weekday_of_month(y: i64, m: u32, weekday: u32, n: u32) -> u32 {
    let first = weekday_from_days(days_from_civil(y, m, 1));
    let offset = (weekday as i64 - first as i64).rem_euclid(7) as u32;
    1 + offset + 7 * (n - 1)
}

/// Day of month of the last `weekday` in month `m` of year `y`.
pub fn last_weekday_of_month(y: i64, m: u32, weekday: u32) -> u32 {
    let last = days_in_month(y, m);
    let last_weekday = weekday_from_days(days_from_civil(y, m, last));
    last - (last_weekday as i64 - weekday as i64).rem_euclid(7) as u32
}

/// Easter Sunday (month, day) of a Gregorian year (the anonymous/Meeus algorithm).
pub fn easter_sunday(y: i64) -> (u32, u32) {
    let a = y % 19;
    let b = y / 100;
    let c = y % 100;
    let d = b / 4;
    let e = b % 4;
    let f = (b + 8) / 25;
    let g = (b - f + 1) / 3;
    let h = (19 * a + b - d - g + 15) % 30;
    let i = c / 4;
    let k = c % 4;
    let l = (32 + 2 * e + 2 * i - h - k) % 7;
    let m = (a + 11 * h + 22 * l) / 451;
    let month = (h + l - 7 * m + 114) / 31;
    let day = (h + l - 7 * m + 114) % 31 + 1;
    (month as u32, day as u32)
}

/// A fixed-date holiday observed on the nearest weekday: Saturday → Friday, Sunday → Monday.
fn observed(y: i64, m: u32, d: u32) -> i64 {
    let day = days_from_civil(y, m, d);
    match weekday_from_days(day) {
        SATURDAY => day - 1,
        SUNDAY => day + 1,
        _ => day,
    }
}

/// Whether the unix day is a New York Stock Exchange holiday: New Year's Day
/// (observed Monday when on a Sunday, not observed when on a Saturday), Martin
/// Luther King Jr. Day, Presidents' Day, Good Friday, Memorial Day, Juneteenth,
/// Independence Day, Labor Day, Thanksgiving, Christmas (the fixed dates
/// observed Friday/Monday when they fall on a weekend). Early closes are ignored.
pub fn is_nyse_holiday(days: i64) -> bool {
    let (y, _, _) = civil_from_days(days);
    let new_year = days_from_civil(y, 1, 1);
    let new_year_observed = match weekday_from_days(new_year) {
        SATURDAY => None,
        SUNDAY => Some(new_year + 1),
        _ => Some(new_year),
    };
    if new_year_observed == Some(days) {
        return true;
    }
    let (easter_month, easter_day) = easter_sunday(y);
    let fixed = [
        days_from_civil(y, 1, nth_weekday_of_month(y, 1, MONDAY, 3)),
        days_from_civil(y, 2, nth_weekday_of_month(y, 2, MONDAY, 3)),
        days_from_civil(y, easter_month, easter_day) - 2,
        days_from_civil(y, 5, last_weekday_of_month(y, 5, MONDAY)),
        observed(y, 6, 19),
        observed(y, 7, 4),
        days_from_civil(y, 9, nth_weekday_of_month(y, 9, MONDAY, 1)),
        days_from_civil(y, 11, nth_weekday_of_month(y, 11, THURSDAY, 4)),
        observed(y, 12, 25),
    ];
    fixed.contains(&days)
}

/// US daylight saving, evaluated in local standard time: from the second Sunday
/// of March 02:00 standard time until the first Sunday of November 02:00 daylight
/// time (= 01:00 standard time).
pub fn us_dst_active(local_standard: i64) -> bool {
    let (y, _, _) = civil_from_days(local_standard.div_euclid(SECONDS_PER_DAY));
    let start = days_from_civil(y, 3, nth_weekday_of_month(y, 3, SUNDAY, 2)) * SECONDS_PER_DAY + 2 * 3_600;
    let end = days_from_civil(y, 11, nth_weekday_of_month(y, 11, SUNDAY, 1)) * SECONDS_PER_DAY + 3_600;
    local_standard >= start && local_standard < end
}

/// EU summer time, evaluated in UTC: from the last Sunday of March 01:00 UTC
/// until the last Sunday of October 01:00 UTC.
pub fn eu_dst_active(utc: i64) -> bool {
    let (y, _, _) = civil_from_days(utc.div_euclid(SECONDS_PER_DAY));
    let start = days_from_civil(y, 3, last_weekday_of_month(y, 3, SUNDAY)) * SECONDS_PER_DAY + 3_600;
    let end = days_from_civil(y, 10, last_weekday_of_month(y, 10, SUNDAY)) * SECONDS_PER_DAY + 3_600;
    utc >= start && utc < end
}

/// Local wall-clock seconds: UTC + the standard offset, plus one hour while the
/// zone's daylight-saving rule (0 none, 1 US, 2 EU) is active.
pub fn local_time(utc: i64, offset_minutes: i64, dst_rule: u8) -> i64 {
    let standard = utc.saturating_add(offset_minutes.saturating_mul(60));
    let dst = match dst_rule {
        DST_US => us_dst_active(standard),
        DST_EU => eu_dst_active(utc),
        _ => false,
    };
    if dst {
        standard.saturating_add(3_600)
    } else {
        standard
    }
}

pub fn minute_of_day(local: i64) -> u64 {
    (local.rem_euclid(SECONDS_PER_DAY) / 60) as u64
}

pub fn day_of(local: i64) -> i64 {
    local.div_euclid(SECONDS_PER_DAY)
}

/// NYSE regular session: Monday–Friday 09:30 ≤ New York time < 16:00, not a
/// holiday (unless `ignore_holidays`). Early closes are ignored.
pub fn nyse_open(utc: i64, ignore_holidays: bool) -> bool {
    let local = local_time(utc, NEW_YORK_OFFSET_MINUTES, DST_US);
    let day = day_of(local);
    let minute = minute_of_day(local);
    weekday_from_days(day) < SATURDAY && (NYSE_OPEN_MINUTE..NYSE_CLOSE_MINUTE).contains(&minute) && (ignore_holidays || !is_nyse_holiday(day))
}

/// The creator's trading window (trading_hours): `open < close` → open ≤ minute
/// < close on an allowed weekday; `close ≤ open` runs past midnight → minute ≥
/// open on an allowed weekday, or minute < close on the day after an allowed
/// weekday. `weekday_mask` has Monday = bit 0. Open 0 / close 1440 is all day.
pub fn trading_window_open(utc: i64, open_minute: u64, close_minute: u64, weekday_mask: u64, offset_minutes: i64, dst_rule: u8) -> bool {
    let local = local_time(utc, offset_minutes, dst_rule);
    let weekday = weekday_from_days(day_of(local));
    let minute = minute_of_day(local);
    let allowed = |w: u32| (weekday_mask >> w) & 1 == 1;
    if open_minute < close_minute {
        allowed(weekday) && minute >= open_minute && minute < close_minute
    } else {
        (allowed(weekday) && minute >= open_minute) || (allowed((weekday + 6) % 7) && minute < close_minute)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = SECONDS_PER_DAY;
    fn ts(y: i64, m: u32, d: u32, hh: i64, mm: i64) -> i64 {
        days_from_civil(y, m, d) * DAY + hh * 3_600 + mm * 60
    }

    #[test]
    fn civil_conversions_round_trip() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
        assert_eq!(days_from_civil(2024, 1, 1), 19_723);
        assert_eq!(days_from_civil(1969, 12, 31), -1);
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(days_from_civil(2024, 2, 29)), (2024, 2, 29));
        for day in -40_000i64..60_000 {
            let (y, m, d) = civil_from_days(day);
            assert!((1..=12).contains(&m) && d >= 1 && d <= days_in_month(y, m));
            assert_eq!(days_from_civil(y, m, d), day);
        }
        assert_eq!(weekday_from_days(0), THURSDAY, "1970-01-01 was a Thursday");
        assert_eq!(weekday_from_days(days_from_civil(2024, 1, 1)), MONDAY);
        assert_eq!(weekday_from_days(days_from_civil(2023, 11, 14)), 1, "Tuesday");
        assert_eq!(weekday_from_days(days_from_civil(2026, 10, 4)), SUNDAY);
        assert!(is_leap_year(2000) && is_leap_year(2024) && !is_leap_year(1900) && !is_leap_year(2023));
        assert_eq!(days_in_month(2024, 2), 29);
        assert_eq!(days_in_month(2023, 2), 28);
        assert_eq!(nth_weekday_of_month(2024, 1, MONDAY, 3), 15, "MLK day 2024");
        assert_eq!(nth_weekday_of_month(2024, 11, THURSDAY, 4), 28, "Thanksgiving 2024");
        assert_eq!(nth_weekday_of_month(2024, 3, SUNDAY, 2), 10);
        assert_eq!(nth_weekday_of_month(2024, 11, SUNDAY, 1), 3);
        assert_eq!(last_weekday_of_month(2024, 5, MONDAY), 27, "Memorial day 2024");
        assert_eq!(last_weekday_of_month(2024, 3, SUNDAY), 31);
        assert_eq!(last_weekday_of_month(2024, 10, SUNDAY), 27);
        assert_eq!(last_weekday_of_month(2026, 3, SUNDAY), 29);
        assert_eq!(last_weekday_of_month(2026, 10, SUNDAY), 25);
    }

    #[test]
    fn gregorian_easter() {
        assert_eq!(easter_sunday(2000), (4, 23));
        assert_eq!(easter_sunday(2019), (4, 21));
        assert_eq!(easter_sunday(2023), (4, 9));
        assert_eq!(easter_sunday(2024), (3, 31));
        assert_eq!(easter_sunday(2025), (4, 20));
        assert_eq!(easter_sunday(2026), (4, 5));
        assert_eq!(easter_sunday(2027), (3, 28));
        assert_eq!(easter_sunday(2038), (4, 25));
        assert_eq!(easter_sunday(1818), (3, 22), "earliest possible date");
    }

    fn holiday(y: i64, m: u32, d: u32) -> bool {
        is_nyse_holiday(days_from_civil(y, m, d))
    }

    #[test]
    fn nyse_holidays_2024_and_observance_rules() {
        let expected_2024 = [(1, 1), (1, 15), (2, 19), (3, 29), (5, 27), (6, 19), (7, 4), (9, 2), (11, 28), (12, 25)];
        let mut found = Vec::new();
        for m in 1..=12 {
            for d in 1..=days_in_month(2024, m) {
                if holiday(2024, m, d) {
                    found.push((m, d));
                }
            }
        }
        assert_eq!(found, expected_2024.to_vec());
        // observance: Saturday -> Friday, Sunday -> Monday for the fixed dates
        assert!(holiday(2021, 7, 5) && !holiday(2021, 7, 4), "July 4 2021 (Sunday) observed Monday");
        assert!(holiday(2021, 12, 24) && !holiday(2021, 12, 25), "Christmas 2021 (Saturday) observed Friday");
        assert!(holiday(2022, 6, 20) && !holiday(2022, 6, 19), "Juneteenth 2022 (Sunday) observed Monday");
        assert!(holiday(2022, 12, 26), "Christmas 2022 (Sunday) observed Monday");
        assert!(holiday(2026, 7, 3) && !holiday(2026, 7, 4), "July 4 2026 (Saturday) observed Friday");
        assert!(holiday(2027, 12, 24));
        // New Year's Day: Sunday -> Monday, Saturday -> not observed
        assert!(holiday(2023, 1, 2) && !holiday(2023, 1, 1), "Jan 1 2023 (Sunday) observed Monday");
        assert!(!holiday(2022, 1, 1) && !holiday(2021, 12, 31), "Jan 1 2022 (Saturday) is not observed");
        assert!(!holiday(2027, 12, 31) && !holiday(2028, 1, 1), "Jan 1 2028 (Saturday) is not observed");
        assert!(holiday(2026, 1, 1) && holiday(2027, 1, 1));
        // movable holidays in other years
        assert!(holiday(2023, 4, 7), "Good Friday 2023");
        assert!(holiday(2026, 4, 3), "Good Friday 2026");
        assert!(holiday(2025, 4, 18), "Good Friday 2025");
        assert!(holiday(2026, 1, 19) && holiday(2026, 2, 16) && holiday(2026, 5, 25) && holiday(2026, 9, 7) && holiday(2026, 11, 26) && holiday(2026, 12, 25));
        assert!(!holiday(2026, 11, 27), "the Friday after Thanksgiving is an early close, not a holiday");
        assert!(!holiday(2024, 10, 14), "Columbus Day is not an NYSE holiday");
        assert!(!holiday(2024, 11, 11), "Veterans Day is not an NYSE holiday");
    }

    #[test]
    fn us_and_eu_daylight_saving_boundaries() {
        // US rule in local standard time: 2024-03-10 02:00 .. 2024-11-03 01:00 standard
        assert!(!us_dst_active(ts(2024, 3, 10, 1, 59)));
        assert!(us_dst_active(ts(2024, 3, 10, 2, 0)));
        assert!(us_dst_active(ts(2024, 11, 3, 0, 59)));
        assert!(!us_dst_active(ts(2024, 11, 3, 1, 0)));
        assert!(us_dst_active(ts(2025, 3, 9, 2, 0)) && !us_dst_active(ts(2025, 3, 9, 1, 59)));
        assert!(!us_dst_active(ts(2025, 11, 2, 1, 0)) && us_dst_active(ts(2025, 11, 2, 0, 59)));
        assert!(us_dst_active(ts(2026, 3, 8, 2, 0)) && !us_dst_active(ts(2026, 11, 1, 1, 0)));
        assert!(!us_dst_active(ts(2024, 1, 15, 12, 0)) && !us_dst_active(ts(2024, 12, 15, 12, 0)) && us_dst_active(ts(2024, 7, 1, 12, 0)));
        // EU rule in UTC: last Sunday of March 01:00 .. last Sunday of October 01:00
        assert!(!eu_dst_active(ts(2024, 3, 31, 0, 59)));
        assert!(eu_dst_active(ts(2024, 3, 31, 1, 0)));
        assert!(eu_dst_active(ts(2024, 10, 27, 0, 59)));
        assert!(!eu_dst_active(ts(2024, 10, 27, 1, 0)));
        assert!(eu_dst_active(ts(2026, 3, 29, 1, 0)) && !eu_dst_active(ts(2026, 10, 25, 1, 0)));
        // local time: New York in winter and summer; Berlin; a zone without DST
        assert_eq!(local_time(ts(2024, 1, 2, 14, 30), NEW_YORK_OFFSET_MINUTES, DST_US), ts(2024, 1, 2, 9, 30));
        assert_eq!(local_time(ts(2024, 7, 8, 13, 30), NEW_YORK_OFFSET_MINUTES, DST_US), ts(2024, 7, 8, 9, 30));
        assert_eq!(local_time(ts(2024, 3, 10, 6, 59), NEW_YORK_OFFSET_MINUTES, DST_US), ts(2024, 3, 10, 1, 59));
        assert_eq!(local_time(ts(2024, 3, 10, 7, 0), NEW_YORK_OFFSET_MINUTES, DST_US), ts(2024, 3, 10, 3, 0), "02:00 EST springs to 03:00 EDT");
        assert_eq!(local_time(ts(2024, 11, 3, 5, 59), NEW_YORK_OFFSET_MINUTES, DST_US), ts(2024, 11, 3, 1, 59));
        assert_eq!(local_time(ts(2024, 11, 3, 6, 0), NEW_YORK_OFFSET_MINUTES, DST_US), ts(2024, 11, 3, 1, 0), "02:00 EDT falls back to 01:00 EST");
        assert_eq!(local_time(ts(2024, 7, 1, 12, 0), 60, DST_EU), ts(2024, 7, 1, 14, 0), "Berlin summer = UTC+2");
        assert_eq!(local_time(ts(2024, 1, 1, 12, 0), 60, DST_EU), ts(2024, 1, 1, 13, 0));
        assert_eq!(local_time(ts(2024, 7, 1, 12, 0), 540, DST_NONE), ts(2024, 7, 1, 21, 0), "Tokyo");
        assert_eq!(local_time(ts(2024, 7, 1, 12, 0), -180, DST_NONE), ts(2024, 7, 1, 9, 0));
        assert_eq!(minute_of_day(ts(2024, 1, 1, 9, 30)), 570);
        assert_eq!(minute_of_day(-1), 1_439, "negative times wrap correctly");
        assert_eq!(day_of(-1), -1);
    }

    #[test]
    fn nyse_session() {
        // Tuesday 2024-01-02, winter (EST = UTC-5): 09:30 = 14:30 UTC, 16:00 = 21:00 UTC
        assert!(!nyse_open(ts(2024, 1, 2, 14, 29), false));
        assert!(nyse_open(ts(2024, 1, 2, 14, 30), false));
        assert!(nyse_open(ts(2024, 1, 2, 20, 59), false));
        assert!(!nyse_open(ts(2024, 1, 2, 21, 0), false), "the close is exclusive");
        // Monday 2024-07-08, summer (EDT = UTC-4): 09:30 = 13:30 UTC
        assert!(!nyse_open(ts(2024, 7, 8, 13, 29), false));
        assert!(nyse_open(ts(2024, 7, 8, 13, 30), false));
        assert!(nyse_open(ts(2024, 7, 8, 19, 59), false));
        assert!(!nyse_open(ts(2024, 7, 8, 20, 0), false));
        // weekend
        assert!(!nyse_open(ts(2024, 7, 6, 15, 0), false) && !nyse_open(ts(2024, 7, 7, 15, 0), false));
        // Independence Day 2024 (Thursday): closed unless holidays are ignored; the Friday after is open
        assert!(!nyse_open(ts(2024, 7, 4, 15, 0), false));
        assert!(nyse_open(ts(2024, 7, 4, 15, 0), true));
        assert!(nyse_open(ts(2024, 7, 5, 15, 0), false));
        // New Year's Day 2024 (Monday) closed, 2024-01-01 15:00 UTC
        assert!(!nyse_open(ts(2024, 1, 1, 15, 0), false));
        // the day New York switches to EDT (Sunday) is closed anyway; the Monday after opens at 13:30 UTC
        assert!(!nyse_open(ts(2024, 3, 11, 13, 29), false) && nyse_open(ts(2024, 3, 11, 13, 30), false));
        // the Monday after the November switch opens at 14:30 UTC again
        assert!(!nyse_open(ts(2024, 11, 4, 14, 29), false) && nyse_open(ts(2024, 11, 4, 14, 30), false));
    }

    #[test]
    fn trading_windows() {
        let weekdays = 0b0011111; // Mon-Fri
        // 09:00-17:00 UTC Mon-Fri
        let monday_9 = ts(2024, 1, 1, 9, 0);
        assert!(!trading_window_open(monday_9 - 1, 540, 1020, weekdays, 0, DST_NONE));
        assert!(trading_window_open(monday_9, 540, 1020, weekdays, 0, DST_NONE));
        assert!(trading_window_open(monday_9 + 8 * 3_600 - 1, 540, 1020, weekdays, 0, DST_NONE));
        assert!(!trading_window_open(monday_9 + 8 * 3_600, 540, 1020, weekdays, 0, DST_NONE), "the close is exclusive");
        assert!(trading_window_open(monday_9 + 4 * DAY, 540, 1020, weekdays, 0, DST_NONE), "Friday");
        assert!(!trading_window_open(monday_9 + 5 * DAY, 540, 1020, weekdays, 0, DST_NONE), "Saturday");
        assert!(!trading_window_open(monday_9 + 6 * DAY, 540, 1020, weekdays, 0, DST_NONE), "Sunday");
        // all day on the weekend only
        assert!(trading_window_open(monday_9 + 5 * DAY, 0, 1440, 0b1100000, 0, DST_NONE));
        assert!(!trading_window_open(monday_9, 0, 1440, 0b1100000, 0, DST_NONE));
        assert!(trading_window_open(ts(2024, 1, 7, 23, 59), 0, 1440, 0b1000000, 0, DST_NONE), "Sunday 23:59");
        // past midnight: 22:00-02:00 on Fridays means Friday 22:00 .. Saturday 02:00
        let friday = ts(2024, 1, 5, 0, 0);
        let fri_only = 1 << FRIDAY;
        assert!(!trading_window_open(friday + 21 * 3_600 + 59 * 60, 1320, 120, fri_only, 0, DST_NONE));
        assert!(trading_window_open(friday + 22 * 3_600, 1320, 120, fri_only, 0, DST_NONE));
        assert!(trading_window_open(friday + 23 * 3_600 + 59 * 60, 1320, 120, fri_only, 0, DST_NONE));
        assert!(trading_window_open(friday + DAY, 1320, 120, fri_only, 0, DST_NONE), "Saturday 00:00 is still Friday's window");
        assert!(trading_window_open(friday + DAY + 3_600 + 59 * 60, 1320, 120, fri_only, 0, DST_NONE));
        assert!(!trading_window_open(friday + DAY + 2 * 3_600, 1320, 120, fri_only, 0, DST_NONE), "Saturday 02:00 closes");
        assert!(!trading_window_open(friday - DAY + 23 * 3_600, 1320, 120, fri_only, 0, DST_NONE), "Thursday night is not Friday's window");
        assert!(!trading_window_open(friday + 2 * DAY, 1320, 120, fri_only, 0, DST_NONE), "Sunday 00:00: Saturday is not allowed");
        // open == close runs the full day from the open on allowed days (and spills into the next morning)
        assert!(trading_window_open(monday_9 + 3 * 3_600, 540, 540, 1 << MONDAY, 0, DST_NONE));
        assert!(trading_window_open(monday_9 + DAY - 1, 540, 540, 1 << MONDAY, 0, DST_NONE), "Tuesday 08:59 after a Monday window");
        assert!(!trading_window_open(monday_9 + DAY, 540, 540, 1 << MONDAY, 0, DST_NONE));
        // time zones with DST: New York 09:30-16:00 via trading_hours equals the NYSE session (holidays aside)
        for utc in [ts(2024, 1, 2, 14, 29), ts(2024, 1, 2, 14, 30), ts(2024, 7, 8, 13, 29), ts(2024, 7, 8, 13, 30), ts(2024, 7, 8, 20, 0), ts(2024, 7, 6, 15, 0)] {
            assert_eq!(trading_window_open(utc, 570, 960, weekdays, NEW_YORK_OFFSET_MINUTES, DST_US), nyse_open(utc, true), "{}", utc);
        }
        // Berlin 09:00-17:00 in summer = 07:00-15:00 UTC
        assert!(trading_window_open(ts(2024, 7, 8, 7, 0), 540, 1020, weekdays, 60, DST_EU));
        assert!(!trading_window_open(ts(2024, 7, 8, 6, 59), 540, 1020, weekdays, 60, DST_EU));
        assert!(!trading_window_open(ts(2024, 7, 8, 15, 0), 540, 1020, weekdays, 60, DST_EU));
        // ...and 08:00-16:00 UTC in winter
        assert!(trading_window_open(ts(2024, 1, 8, 8, 0), 540, 1020, weekdays, 60, DST_EU));
        assert!(!trading_window_open(ts(2024, 1, 8, 7, 59), 540, 1020, weekdays, 60, DST_EU));
        // a negative offset without DST (Sao Paulo, UTC-3): Monday 09:00 local = 12:00 UTC
        assert!(trading_window_open(ts(2024, 1, 8, 12, 0), 540, 1020, weekdays, -180, DST_NONE));
        assert!(!trading_window_open(ts(2024, 1, 8, 11, 59), 540, 1020, weekdays, -180, DST_NONE));
        // a window crossing the UTC day boundary through the offset: Tokyo Monday 09:00 = Sunday 24:00 UTC
        assert!(trading_window_open(ts(2024, 1, 8, 0, 0), 540, 1020, weekdays, 540, DST_NONE));
        assert!(!trading_window_open(ts(2024, 1, 7, 23, 59), 540, 1020, weekdays, 540, DST_NONE));
    }
}
