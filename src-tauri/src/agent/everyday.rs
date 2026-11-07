//! The small things people ask an assistant every day: timers, the weather,
//! how fast the internet is, shutting the PC down later, the clipboard.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;

use crate::storage::now_millis;

/// → panel: a timer has run out, so NOVA says it.
const EVENT_TIMER: &str = "assistant://timer";
pub const LONGEST_TIMER: u64 = 24 * 60 * 60;
const MOST_TIMERS: usize = 20;
/// Windows gets this long at least before going down, so it can still be called off.
const SHORTEST_SHUTDOWN: u64 = 30;
pub const LONGEST_SHUTDOWN: u64 = 24 * 60 * 60;
/// What NOVA reads of the clipboard; a whole book doesn't belong in a conversation.
const LONGEST_CLIPBOARD: usize = 20_000;
/// A test file Hetzner offers for exactly this.
const SPEED_URL: &str = "https://fsn1-speed.hetzner.com/100MB.bin";
const SPEED_HOST: &str = "fsn1-speed.hetzner.com:443";
const SPEED_SECONDS: u64 = 6;

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timer {
    pub id: u64,
    pub label: String,
    pub ends_at: i64,
}

static TIMERS: Mutex<Vec<Timer>> = Mutex::new(Vec::new());

fn timers_list() -> std::sync::MutexGuard<'static, Vec<Timer>> {
    TIMERS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// "1 h 5 min", "90 s" → how long something still takes, for a sentence.
pub fn duration_words(seconds: u64) -> String {
    match seconds {
        s if s < 60 => format!("{s} s"),
        s if s < 3600 && s % 60 == 0 => format!("{} min", s / 60),
        s if s < 3600 => format!("{} min {} s", s / 60, s % 60),
        s if s % 3600 / 60 == 0 => format!("{} h", s / 3600),
        s => format!("{} h {} min", s / 3600, s % 3600 / 60),
    }
}

/// Starts a timer. They live as long as NOVA runs, and go off late after the PC slept.
pub fn start_timer<R: Runtime>(app: &AppHandle<R>, seconds: u64, label: &str) -> Result<Timer, String> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let timer = Timer { id: NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed), label: label.chars().take(60).collect(), ends_at: now_millis() + seconds as i64 * 1000 };
    {
        let mut list = timers_list();
        if list.len() >= MOST_TIMERS {
            return Err("That's enough timers at once. Cancel one first.".into());
        }
        list.push(timer.clone());
    }
    let (app, id) = (app.clone(), timer.id);
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let due = {
            let mut list = timers_list();
            let Some(index) = list.iter().position(|t| t.id == id) else { return };
            (list[index].ends_at <= now_millis()).then(|| list.remove(index))
        };
        if let Some(timer) = due {
            let body = if timer.label.is_empty() { "Your timer has run out.".to_string() } else { timer.label.clone() };
            let _ = app.notification().builder().title("NOVA timer").body(body).show();
            // Also with the panel closed and a game in front: its page says it.
            if let Some(panel) = app.get_webview_window(crate::assistant::PANEL_LABEL) {
                crate::desktop::set_page_visible(&panel, true);
            }
            let _ = app.emit(EVENT_TIMER, &timer);
            return;
        }
    });
    Ok(timer)
}

pub fn timers() -> Vec<Timer> {
    timers_list().clone()
}

/// Cancels by id, or by part of the label; nothing given means all. Returns how many.
pub fn cancel_timers(wanted: Option<&str>) -> usize {
    let mut list = timers_list();
    let before = list.len();
    match wanted.map(str::trim).filter(|w| !w.is_empty()) {
        None => list.clear(),
        Some(wanted) => {
            let lower = wanted.to_lowercase();
            list.retain(|t| t.id.to_string() != wanted && !t.label.to_lowercase().contains(&lower));
        }
    }
    before - list.len()
}

/// The ✕ on a timer's card.
#[tauri::command]
pub async fn assistant_timer_cancel(id: u64) -> Result<(), String> {
    timers_list().retain(|t| t.id != id);
    Ok(())
}

// ---------------------------------------------------------------------------
// The PC's power
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Power {
    Shutdown,
    Restart,
    Sleep,
    Lock,
}

/// When Windows goes down, if NOVA told it to.
static GOING_DOWN: Mutex<Option<i64>> = Mutex::new(None);

fn run_shutdown(arguments: &[String]) -> Result<bool, String> {
    let mut command = std::process::Command::new("shutdown.exe");
    command.args(arguments);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command.status().map(|status| status.success()).map_err(|e| format!("Windows couldn't be asked: {e}"))
}

/// Shuts down or restarts after `seconds` (at least half a minute, so it can be
/// called off), or sleeps or locks right away. Returns when it happens, if later.
pub fn power(action: Power, seconds: u64) -> Result<Option<i64>, String> {
    let schedule = |flag: &str| -> Result<Option<i64>, String> {
        let seconds = seconds.clamp(SHORTEST_SHUTDOWN, LONGEST_SHUTDOWN);
        if !run_shutdown(&[flag.to_string(), "/t".to_string(), seconds.to_string()])? {
            return Err("Windows refused. Something may already be scheduled; call it off first.".into());
        }
        let at = now_millis() + seconds as i64 * 1000;
        *GOING_DOWN.lock().unwrap_or_else(|p| p.into_inner()) = Some(at);
        Ok(Some(at))
    };
    match action {
        Power::Shutdown => schedule("/s"),
        Power::Restart => schedule("/r"),
        Power::Sleep => suspend().map(|()| None),
        Power::Lock => lock_screen().map(|()| None),
    }
}

/// Calls off a shutdown or restart; false when none was on its way.
pub fn cancel_power() -> Result<bool, String> {
    let called_off = run_shutdown(&["/a".to_string()])?;
    *GOING_DOWN.lock().unwrap_or_else(|p| p.into_inner()) = None;
    Ok(called_off)
}

/// The button on the shutdown card.
#[tauri::command]
pub async fn assistant_power_cancel() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(cancel_power).await.map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn suspend() -> Result<(), String> {
    use windows::Win32::System::Power::SetSuspendState;
    // SAFETY: no pointers; sleep, not hibernation, and wake timers stay allowed.
    if unsafe { SetSuspendState(false, false, false) } { Ok(()) } else { Err("Windows didn't go to sleep. Sleep may be turned off on this PC.".into()) }
}

#[cfg(windows)]
fn lock_screen() -> Result<(), String> {
    use windows::Win32::System::Shutdown::LockWorkStation;
    // SAFETY: no arguments; locks the current session.
    unsafe { LockWorkStation() }.map_err(|e| format!("Windows didn't lock the screen: {e}"))
}

#[cfg(not(windows))]
fn suspend() -> Result<(), String> {
    Err("This requires Windows".into())
}

#[cfg(not(windows))]
fn lock_screen() -> Result<(), String> {
    Err("This requires Windows".into())
}

// ---------------------------------------------------------------------------
// The internet
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Speed {
    pub ping_ms: u64,
    pub megabits: f64,
}

/// Measures the ping and the download speed with a public test file. One download
/// from one server, so a very fast line can be faster than this says. Blocks for a
/// few seconds and fetches up to 100 MB.
pub fn speed_test() -> Result<Speed, String> {
    let ping = ping()?;
    tauri::async_runtime::block_on(async {
        let client = crate::http::client();
        let mut response = client.get(SPEED_URL).timeout(Duration::from_secs(SPEED_SECONDS + 10)).send().await.map_err(crate::http::describe)?;
        if !response.status().is_success() {
            return Err(format!("The speed test answered with HTTP {}", response.status().as_u16()));
        }
        let started = Instant::now();
        let mut bytes = 0u64;
        while started.elapsed() < Duration::from_secs(SPEED_SECONDS) {
            match response.chunk().await.map_err(crate::http::describe)? {
                Some(chunk) => bytes += chunk.len() as u64,
                None => break,
            }
        }
        let seconds = started.elapsed().as_secs_f64().max(0.01);
        Ok(Speed { ping_ms: ping, megabits: bytes as f64 * 8.0 / 1_000_000.0 / seconds })
    })
}

/// How long the server takes to answer a connection: the best of a few tries.
fn ping() -> Result<u64, String> {
    use std::net::{TcpStream, ToSocketAddrs};
    let address = SPEED_HOST.to_socket_addrs().ok().and_then(|mut found| found.next()).ok_or("Couldn't connect — check your internet connection")?;
    let tries = (0..4).filter_map(|_| {
        let started = Instant::now();
        TcpStream::connect_timeout(&address, Duration::from_secs(3)).ok().map(|_| started.elapsed().as_millis() as u64)
    });
    tries.min().ok_or_else(|| "Couldn't connect — check your internet connection".to_string())
}

/// What a connection is good for, for the model to pass on.
pub fn speed_verdict(speed: Speed) -> &'static str {
    match (speed.megabits, speed.ping_ms) {
        (m, _) if m < 5.0 => "slow: websites work, video may stutter",
        (_, p) if p > 100 => "fast enough to download and stream, but the ping is high for online games",
        (m, _) if m < 50.0 => "fine for streaming and gaming, big downloads take a while",
        _ => "fast: good for everything",
    }
}

// ---------------------------------------------------------------------------
// The clipboard
// ---------------------------------------------------------------------------

/// The text on the clipboard, cut off at a sensible length.
pub fn read_clipboard() -> Result<Option<String>, String> {
    Ok(clipboard_text()?.map(|text| text.chars().take(LONGEST_CLIPBOARD).collect()))
}

#[cfg(windows)]
const CF_UNICODETEXT: u32 = 13;

/// Windows lets one program at a time at the clipboard; another may hold it for a moment.
#[cfg(windows)]
fn open_clipboard() -> Result<(), String> {
    use windows::Win32::System::DataExchange::OpenClipboard;
    for _ in 0..10 {
        // SAFETY: no window owns it; closed by the caller.
        if unsafe { OpenClipboard(None) }.is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err("Another program is holding the clipboard right now".into())
}

#[cfg(windows)]
fn clipboard_text() -> Result<Option<String>, String> {
    use windows::Win32::Foundation::{HANDLE, HGLOBAL};
    use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, IsClipboardFormatAvailable};
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    // SAFETY: checked before opening; a plain query.
    if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT) }.is_err() {
        return Ok(None);
    }
    open_clipboard()?;
    // SAFETY: the clipboard is open until CloseClipboard below; the memory is
    // only read while locked, within the size Windows reports for it.
    let text = unsafe {
        let text = GetClipboardData(CF_UNICODETEXT).ok().and_then(|data: HANDLE| {
            let memory = HGLOBAL(data.0);
            let start = GlobalLock(memory) as *const u16;
            if start.is_null() {
                return None;
            }
            let units = std::slice::from_raw_parts(start, GlobalSize(memory) / 2);
            let end = units.iter().position(|unit| *unit == 0).unwrap_or(units.len());
            let text = String::from_utf16_lossy(&units[..end]);
            let _ = GlobalUnlock(memory);
            Some(text)
        });
        let _ = CloseClipboard();
        text
    };
    Ok(text.filter(|t| !t.trim().is_empty()))
}

#[cfg(windows)]
pub fn write_clipboard(text: &str) -> Result<(), String> {
    use windows::Win32::Foundation::{GlobalFree, HANDLE};
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, SetClipboardData};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    let units: Vec<u16> = text.encode_utf16().chain([0]).collect();
    open_clipboard()?;
    // SAFETY: the copy stays within the allocation made for it; once SetClipboardData
    // has succeeded the memory belongs to Windows, otherwise it is freed here.
    let result = unsafe {
        (|| {
            let memory = GlobalAlloc(GMEM_MOVEABLE, units.len() * 2).map_err(|e| e.to_string())?;
            let target = GlobalLock(memory) as *mut u16;
            if target.is_null() {
                let _ = GlobalFree(Some(memory));
                return Err("Couldn't get memory for the clipboard".to_string());
            }
            std::ptr::copy_nonoverlapping(units.as_ptr(), target, units.len());
            let _ = GlobalUnlock(memory);
            let _ = EmptyClipboard();
            SetClipboardData(CF_UNICODETEXT, Some(HANDLE(memory.0))).map(|_| ()).map_err(|e| {
                let _ = GlobalFree(Some(memory));
                e.to_string()
            })
        })()
    };
    // SAFETY: opened above.
    let _ = unsafe { CloseClipboard() };
    result.map_err(|e| format!("Couldn't copy it: {e}"))
}

#[cfg(not(windows))]
fn clipboard_text() -> Result<Option<String>, String> {
    Err("This requires Windows".into())
}

#[cfg(not(windows))]
pub fn write_clipboard(_: &str) -> Result<(), String> {
    Err("This requires Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_durations_in_words() {
        assert_eq!(duration_words(45), "45 s");
        assert_eq!(duration_words(600), "10 min");
        assert_eq!(duration_words(90), "1 min 30 s");
        assert_eq!(duration_words(3600), "1 h");
        assert_eq!(duration_words(3900), "1 h 5 min");
    }

    #[test]
    fn timers_cancel_by_label_or_all() {
        let mut list = timers_list();
        list.clear();
        list.extend([Timer { id: 1, label: "Pizza".into(), ends_at: 0 }, Timer { id: 2, label: "Wäsche".into(), ends_at: 0 }, Timer { id: 3, label: String::new(), ends_at: 0 }]);
        drop(list);
        assert_eq!(cancel_timers(Some("pizza")), 1);
        assert_eq!(cancel_timers(Some("nichts")), 0);
        assert_eq!(cancel_timers(Some("3")), 1);
        assert_eq!(cancel_timers(None), 1);
        assert!(timers().is_empty());
    }

    #[test]
    fn judges_connections() {
        assert!(speed_verdict(Speed { ping_ms: 20, megabits: 2.0 }).starts_with("slow"));
        assert!(speed_verdict(Speed { ping_ms: 150, megabits: 200.0 }).contains("ping"));
        assert!(speed_verdict(Speed { ping_ms: 20, megabits: 200.0 }).starts_with("fast:"));
    }

    /// Fetches up to 100 MB, so only by hand.
    #[test]
    #[ignore]
    fn measures_a_real_connection() {
        let speed = speed_test().unwrap();
        println!("{speed:?}");
        assert!(speed.ping_ms < 2000 && speed.megabits > 0.1);
    }

    /// Touches the real clipboard, so only by hand.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn the_clipboard_round_trips() {
        let before = clipboard_text().unwrap();
        write_clipboard("Grüße von NOVA 🎮").unwrap();
        assert_eq!(read_clipboard().unwrap().as_deref(), Some("Grüße von NOVA 🎮"));
        if let Some(text) = before {
            write_clipboard(&text).unwrap();
        }
    }
}
