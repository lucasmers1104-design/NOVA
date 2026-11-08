//! When a task from the phone runs. Pure functions; the store and the runner live in `mod.rs`.
//!
//! "Sobald PC an" never reaches this file: the phone keeps it until it can deliver it,
//! and the PC runs it on arrival. "Um HH:MM" waits here in local time.

/// A task whose time passed while the PC was off still runs if it is at most this late.
pub const LATE_MINUTES: i64 = 120;
/// How far ahead a task can be scheduled.
pub const MOST_DAYS_AHEAD: i64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Due {
    Wait,
    Run,
    /// Later than `LATE_MINUTES`: dropped, and the phone is told.
    Missed,
}

/// Days since 1970-01-01 for "YYYY-MM-DD"; `None` for dates that don't exist.
pub fn day_number(date: &str) -> Option<i64> {
    let bytes = date.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i64 = date[0..4].parse().ok()?;
    let month: i64 = date[5..7].parse().ok()?;
    let day: i64 = date[8..10].parse().ok()?;
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    if !(1..=days_in_month).contains(&day) || !(1970..=9999).contains(&year) {
        return None;
    }
    // Howard Hinnant's days_from_civil.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// Minutes after midnight for "HH:MM".
pub fn minutes_of(time: &str) -> Option<i64> {
    let (hours, minutes) = time.split_once(':')?;
    let (hours, minutes): (i64, i64) = (hours.parse().ok()?, minutes.parse().ok()?);
    (time.len() == 5 && (0..24).contains(&hours) && (0..60).contains(&minutes)).then_some(hours * 60 + minutes)
}

fn absolute(date: &str, time: &str) -> Option<i64> {
    Some(day_number(date)? * 1440 + minutes_of(time)?)
}

/// Whether a task for `date` `time` runs now. `now_*` is the PC's local time.
pub fn due(date: &str, time: &str, now_date: &str, now_time: &str) -> Due {
    let (Some(at), Some(now)) = (absolute(date, time), absolute(now_date, now_time)) else { return Due::Missed };
    match now - at {
        late if late < 0 => Due::Wait,
        late if late <= LATE_MINUTES => Due::Run,
        _ => Due::Missed,
    }
}

/// Refuses times that are already over or too far ahead when the task arrives.
pub fn check_new(date: &str, time: &str, now_date: &str, now_time: &str) -> Result<(), String> {
    let (Some(at), Some(now)) = (absolute(date, time), absolute(now_date, now_time)) else { return Err("That time isn't valid".into()) };
    if now - at > LATE_MINUTES {
        return Err("That time is already over".into());
    }
    if at - now > MOST_DAYS_AHEAD * 1440 {
        return Err(format!("Tasks can be planned up to {MOST_DAYS_AHEAD} days ahead"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_and_times_are_checked() {
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(day_number("2026-11-08"), Some(20_765));
        assert_eq!(day_number("2028-02-29").map(|d| d - day_number("2028-02-28").unwrap()), Some(1));
        assert_eq!(day_number("2026-02-29"), None);
        assert_eq!(day_number("2026-13-01"), None);
        assert_eq!(day_number("2026-1-01"), None);
        assert_eq!(minutes_of("18:30"), Some(1110));
        assert_eq!(minutes_of("24:00"), None);
        assert_eq!(minutes_of("9:30"), None);
    }

    #[test]
    fn a_task_runs_at_its_time_and_up_to_two_hours_late() {
        assert_eq!(due("2026-11-08", "18:30", "2026-11-08", "18:29"), Due::Wait);
        assert_eq!(due("2026-11-08", "18:30", "2026-11-08", "18:30"), Due::Run);
        assert_eq!(due("2026-11-08", "18:30", "2026-11-08", "20:30"), Due::Run);
        assert_eq!(due("2026-11-08", "18:30", "2026-11-08", "20:31"), Due::Missed);
        // Tomorrow's task waits, also when today's clock is later.
        assert_eq!(due("2026-11-09", "08:00", "2026-11-08", "23:00"), Due::Wait);
    }

    #[test]
    fn the_late_window_crosses_midnight() {
        assert_eq!(due("2026-11-08", "23:30", "2026-11-09", "00:45"), Due::Run);
        assert_eq!(due("2026-11-08", "23:30", "2026-11-09", "01:31"), Due::Missed);
        // The PC was off for days.
        assert_eq!(due("2026-11-01", "08:00", "2026-11-08", "08:00"), Due::Missed);
    }

    #[test]
    fn new_tasks_must_lie_ahead_but_not_too_far() {
        assert!(check_new("2026-11-08", "18:30", "2026-11-08", "12:00").is_ok());
        assert!(check_new("2026-11-08", "08:00", "2026-11-08", "12:00").is_err());
        assert!(check_new("2026-12-09", "08:00", "2026-11-08", "12:00").is_err());
    }
}
