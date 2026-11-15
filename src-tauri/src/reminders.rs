//! Task reminders while NOVA's main window doesn't exist.
//!
//! The main window's page fires them while it is there (also hidden in the
//! tray). Once closing to the tray ends that page to give its memory back,
//! this takes over: the same rule, the same record of what was already
//! reminded (`nova.reminders`), so nothing is lost and nothing comes twice.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use crate::storage::productivity::Task;
use crate::storage::{self, Database};

const REMINDED_KEY: &str = "nova.reminders";
const SETTINGS_KEY: &str = "nova.settings";
const CHECK_EVERY: Duration = Duration::from_secs(30);
/// Older than this, a task is simply overdue: no reminder any more.
const FRESH_MINUTES: i64 = 12 * 60;
/// As many keys as the page keeps.
const REMEMBERED: usize = 300;

/// A local date and time as minutes on one continuous scale.
fn minutes(date: &str, time: &str) -> Option<i64> {
    let mut parts = date.split('-').map(|part| part.parse::<i64>().ok());
    let (year, month, day) = (parts.next()??, parts.next()??, parts.next()??);
    let (hours, mins) = time.split_once(':')?;
    let (hours, mins) = (hours.parse::<i64>().ok()?, mins.parse::<i64>().ok()?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || !(0..24).contains(&hours) || !(0..60).contains(&mins) {
        return None;
    }
    // Days since 1970-01-01 in the proleptic Gregorian calendar (Howard Hinnant's algorithm).
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some((days * 24 + hours) * 60 + mins)
}

/// Changes when the due moment changes, so a rescheduled task reminds again (as the page builds it).
fn key(task: &Task) -> String {
    format!("{}@{}T{}", task.id, task.due_date.as_deref().unwrap_or("null"), task.due_time.as_deref().unwrap_or("null"))
}

/// Tasks with a reminder whose due moment has come, within the last twelve hours, that weren't reminded yet.
fn due<'a>(tasks: &'a [Task], now: i64, reminded: &[String]) -> Vec<&'a Task> {
    tasks
        .iter()
        .filter(|task| task.remind && task.completed_at.is_none())
        .filter(|task| {
            let moment = task.due_date.as_deref().zip(task.due_time.as_deref()).and_then(|(date, time)| minutes(date, time));
            moment.is_some_and(|moment| moment <= now && now - moment < FRESH_MINUTES)
        })
        .filter(|task| !reminded.contains(&key(task)))
        .collect()
}

/// "14:30" as the user's clock shows it: stays, or "2:30 PM".
fn clock(time: &str, use_24_hours: bool) -> String {
    let parsed = time.split_once(':').and_then(|(h, m)| Some((h.parse::<u32>().ok()?, m.parse::<u32>().ok()?)));
    match parsed {
        Some((hours, mins)) if !use_24_hours => format!("{}:{mins:02} {}", if hours % 12 == 0 { 12 } else { hours % 12 }, if hours < 12 { "AM" } else { "PM" }),
        _ => time.to_string(),
    }
}

fn body(task: &Task, use_24_hours: bool) -> String {
    let at = clock(task.due_time.as_deref().unwrap_or_default(), use_24_hours);
    match task.notes.lines().next().filter(|line| !line.is_empty()) {
        Some(note) => format!("Due at {at} — {note}"),
        None => format!("Due at {at}"),
    }
}

#[cfg(windows)]
fn now_minutes() -> Option<i64> {
    use windows::Win32::System::SystemInformation::GetLocalTime;
    // SAFETY: reads the clock; no pointers involved.
    let t = unsafe { GetLocalTime() };
    minutes(&format!("{:04}-{:02}-{:02}", t.wYear, t.wMonth, t.wDay), &format!("{:02}:{:02}", t.wHour, t.wMinute))
}

#[cfg(not(windows))]
fn now_minutes() -> Option<i64> {
    None
}

/// A setting from the page's settings document ({ state, version }), true or false.
fn setting(document: &Value, name: &str, default: bool) -> bool {
    document.get("state").unwrap_or(document).get(name).and_then(Value::as_bool).unwrap_or(default)
}

fn check<R: Runtime>(app: &AppHandle<R>) {
    let Some(now) = now_minutes() else { return };
    let db = app.state::<Database>();
    let Ok(data) = db.with(storage::productivity::load) else { return };
    let read = |key: &'static str| db.with(|conn| storage::kv_get(conn, key)).ok().flatten().and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let mut reminded: Vec<String> = read(REMINDED_KEY).and_then(|value| serde_json::from_value(value).ok()).unwrap_or_default();
    let found = due(&data.tasks, now, &reminded);
    if found.is_empty() {
        return;
    }
    let settings = read(SETTINGS_KEY).unwrap_or(Value::Null);
    let (windows_notifications, use_24_hours) = (setting(&settings, "systemNotifications", true), setting(&settings, "use24HourClock", true));
    for task in found {
        reminded.push(key(task));
        let body = body(task, use_24_hours);
        if windows_notifications {
            crate::assistant::notify(app, &format!("Reminder: {}", task.title), &body);
        }
        // The page's own notification list gets it when the window is back.
        crate::desktop::missed_by_main(app, crate::desktop::EVENT_REMINDER, serde_json::json!({ "title": task.title, "body": body }));
    }
    let keep = reminded.len().saturating_sub(REMEMBERED);
    if let Ok(json) = serde_json::to_string(&reminded[keep..]) {
        let _ = db.with(|conn| storage::kv_set(conn, REMINDED_KEY, &json));
    }
}

static WATCHING: AtomicBool = AtomicBool::new(false);

/// Checks every half minute for as long as the main window doesn't exist.
pub fn watch_while_main_is_gone<R: Runtime>(app: &AppHandle<R>) {
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        while app.get_webview_window(crate::desktop::MAIN_LABEL).is_none() {
            check(&app);
            std::thread::sleep(CHECK_EVERY);
        }
        WATCHING.store(false, Ordering::SeqCst);
        // Closed again while this was on its way out.
        if app.get_webview_window(crate::desktop::MAIN_LABEL).is_none() {
            watch_while_main_is_gone(&app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, date: Option<&str>, time: Option<&str>) -> Task {
        Task {
            id: id.into(),
            title: format!("Task {id}"),
            notes: String::new(),
            project_id: None,
            priority: 0,
            due_date: date.map(str::to_string),
            due_time: time.map(str::to_string),
            remind: true,
            completed_at: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn dates_line_up_on_one_scale() {
        assert_eq!(minutes("1970-01-01", "00:00"), Some(0));
        assert_eq!(minutes("1970-01-02", "01:30"), Some(24 * 60 + 90));
        // Over a month's end, a leap day and a year's end.
        assert_eq!(minutes("2026-12-01", "00:00").unwrap() - minutes("2026-11-30", "23:59").unwrap(), 1);
        assert_eq!(minutes("2028-03-01", "00:00").unwrap() - minutes("2028-02-28", "00:00").unwrap(), 2 * 24 * 60);
        assert_eq!(minutes("2027-01-01", "00:00").unwrap() - minutes("2026-12-31", "23:00").unwrap(), 60);
        assert_eq!(minutes("2026-11-11", "17:45").unwrap() / (24 * 60), 20_768, "days since 1970");
        for bad in [("2026-13-01", "10:00"), ("2026-11-11", "24:00"), ("2026-11-11", "10"), ("soon", "10:00"), ("2026-11", "10:00"), ("2026-11-11", "10:60")] {
            assert_eq!(minutes(bad.0, bad.1), None, "{bad:?}");
        }
    }

    #[test]
    fn reminds_once_when_the_moment_has_come() {
        let now = minutes("2026-11-11", "14:30").unwrap();
        let tasks = [
            task("due", Some("2026-11-11"), Some("14:30")),
            task("later", Some("2026-11-11"), Some("14:31")),
            task("morning", Some("2026-11-11"), Some("02:31")),
            task("stale", Some("2026-11-11"), Some("02:30")),
            task("yesterday-evening", Some("2026-11-10"), Some("23:00")),
            task("no-time", Some("2026-11-11"), None),
            task("no-date", None, Some("09:00")),
        ];
        let ids = |found: Vec<&Task>| found.iter().map(|t| t.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(due(&tasks, now, &[])), vec!["due", "morning"]);
        // Across midnight: yesterday evening is nine hours ago at eight in the morning.
        assert_eq!(ids(due(&tasks, minutes("2026-11-11", "08:00").unwrap(), &[])), vec!["morning", "stale", "yesterday-evening"]);
        // Already reminded for this very moment; moved to another time it reminds again.
        let reminded = vec!["due@2026-11-11T14:30".to_string(), "morning@2026-11-11T02:00".to_string()];
        assert_eq!(ids(due(&tasks, now, &reminded)), vec!["morning"]);
        // Done, or without a reminder: never.
        let mut done = task("done", Some("2026-11-11"), Some("14:00"));
        done.completed_at = Some(1);
        let mut silent = task("silent", Some("2026-11-11"), Some("14:00"));
        silent.remind = false;
        assert!(due(&[done, silent], now, &[]).is_empty());
    }

    #[test]
    fn words_match_the_pages() {
        let mut call = task("t1", Some("2026-11-11"), Some("14:05"));
        assert_eq!(key(&call), "t1@2026-11-11T14:05");
        assert_eq!(body(&call, true), "Due at 14:05");
        call.notes = "Ask about the invoice\nand the delivery".into();
        assert_eq!(body(&call, false), "Due at 2:05 PM — Ask about the invoice");
        assert_eq!(clock("00:07", false), "12:07 AM");
        assert_eq!(clock("12:00", false), "12:00 PM");
        assert_eq!(clock("23:59", false), "11:59 PM");
        assert_eq!(clock("23:59", true), "23:59");
    }

    #[test]
    fn reads_the_pages_settings() {
        let document = serde_json::json!({ "state": { "systemNotifications": false }, "version": 3 });
        assert!(!setting(&document, "systemNotifications", true));
        assert!(setting(&document, "use24HourClock", true), "not saved yet: the default");
        assert!(setting(&Value::Null, "systemNotifications", true));
    }
}
