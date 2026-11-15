//! Desktop integration: tray icon, optional close-to-tray, and optional start
//! with Windows. Background behaviors are off until the user enables them.
//!
//! The main window's page is the biggest thing NOVA keeps in memory, and in
//! the tray nobody looks at it. So closing to the tray ends the window and
//! its page (unless the user turns that off); it is made again when it is
//! asked for, and opens where it was. What the page did in the background
//! goes on without it: task reminders (see `reminders`), and questions that
//! need it — "Pair this phone?" — bring it back and are handed to it.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Listener, Manager, Runtime, WebviewWindow, WebviewWindowBuilder};

type CommandResult<T> = Result<T, String>;

pub const BACKGROUND_FLAG: &str = "--background";
pub const MAIN_LABEL: &str = "main";
const PREFERENCES_KEY: &str = "nova.desktop";
const EVENT_NAVIGATE: &str = "nova://navigate";
/// A task reminder that fired while the main window didn't exist (for its notification list).
pub const EVENT_REMINDER: &str = "nova://reminder";
/// Started in the background, the main window's page gets this long for what it
/// does once per launch (announcing an update, checking for the next one).
const BACKGROUND_SETTLE: Duration = Duration::from_secs(180);
/// A window closed to the tray is hidden at once and ended this much later: what its
/// page was about to save (a note being typed, a moved widget) is saved by then,
/// and closing by mistake costs nothing.
const RELEASE_AFTER: Duration = Duration::from_secs(3);
/// More than this many missed events and the oldest go: the page was away for very long.
const MOST_MISSED: usize = 50;

/// Where the main window should open.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Navigation {
    route: &'static str,
    section: &'static str,
}

/// An event the main window's page would have handled, had it existed.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Missed {
    event: &'static str,
    payload: Value,
}

#[derive(Default)]
struct MainWindow {
    /// Its page is up and listens for events.
    loaded: bool,
    creating: bool,
    /// When the window was asked for again (for the time it takes to be back).
    asked_at: Option<Instant>,
    /// Where it should open once its page is up.
    go_to: Option<Navigation>,
    missed: Vec<Missed>,
    /// NOVA started in the background and nobody has asked for the window yet.
    never_shown: bool,
}

#[derive(Default)]
pub struct DesktopState {
    pub close_to_tray: AtomicBool,
    main: Mutex<MainWindow>,
    /// Counts every time the main window is asked for: a window that was asked for
    /// again isn't ended by a close that came before.
    shown: AtomicU64,
}

impl DesktopState {
    fn main(&self) -> MutexGuard<'_, MainWindow> {
        self.main.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn state<R: Runtime>(app: &AppHandle<R>) -> &DesktopState {
    app.state::<DesktopState>().inner()
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPreferences {
    #[serde(default)]
    close_to_tray: bool,
}

/// Reads the persisted close-to-tray preference (written by the frontend).
pub fn load_preferences(db: &crate::storage::Database) -> bool {
    db.with(|conn| crate::storage::kv_get(conn, PREFERENCES_KEY))
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<DesktopPreferences>(&raw).ok())
        .unwrap_or_default()
        .close_to_tray
}

/// Shows the main window, making it again if closing to the tray ended it.
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    state(app).shown.fetch_add(1, Ordering::SeqCst);
    state(app).main().never_shown = false;
    match app.get_webview_window(MAIN_LABEL) {
        Some(window) => {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
            set_page_visible(&window, true);
        }
        None => create_main_window(app),
    }
}

/// Shows the main window at `route` (and, in Settings, at `section`).
pub fn open_main_at<R: Runtime>(app: &AppHandle<R>, route: &'static str, section: &'static str) {
    let navigation = Navigation { route, section };
    let listening = {
        let mut main = state(app).main();
        let listening = main.loaded && app.get_webview_window(MAIN_LABEL).is_some();
        if !listening {
            // A page that isn't up yet opens there right away: see `opening_script` and `desktop_main_ready`.
            main.go_to = Some(navigation.clone());
        }
        listening
    };
    show_main_window(app);
    if listening {
        let _ = app.emit_to(MAIN_LABEL, EVENT_NAVIGATE, navigation);
    }
}

/// What the page reads before it draws anything: that it is a window that came
/// back (it then opens where it was) and where it should open instead.
fn opening_script(go_to: Option<&Navigation>) -> String {
    let opening = serde_json::json!({ "reopened": true, "route": go_to.map(|n| n.route), "section": go_to.map(|n| n.section) });
    format!("window.__NOVA_OPENING__ = {opening};")
}

/// Makes the main window again, as `tauri.conf.json` describes it. Off the
/// calling thread: WebView2 deadlocks when a window is made in an event handler.
fn create_main_window<R: Runtime>(app: &AppHandle<R>) {
    {
        let mut main = state(app).main();
        if main.creating {
            return;
        }
        main.creating = true;
        main.asked_at = Some(Instant::now());
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let go_to = state(&app).main().go_to.take();
        let built = app
            .config()
            .app
            .windows
            .iter()
            .find(|window| window.label == MAIN_LABEL)
            .ok_or(tauri::Error::WindowNotFound)
            .and_then(|config| WebviewWindowBuilder::from_config(&app, config))
            .and_then(|builder| builder.initialization_script(opening_script(go_to.as_ref())).build());
        state(&app).main().creating = false;
        match built {
            Ok(window) => {
                let _ = window.set_focus();
            }
            Err(error) => {
                eprintln!("[NOVA] the main window couldn't be opened: {error}");
                let mut main = state(&app).main();
                main.asked_at = None;
                main.go_to = go_to;
            }
        }
    });
}

/// What closing the main window does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// NOVA ends.
    Quit,
    /// The window hides; its page stays in memory.
    Hide,
    /// The window hides, and a moment later it and its page end; NOVA goes on in the tray.
    Release,
}

/// `stays`: NOVA keeps running without its window (close-to-tray, the dot or
/// the island). `release`: the user lets NOVA give the page's memory back.
/// `update_waiting`: the page counts down to an update and installs it.
pub fn close_action(stays: bool, release: bool, update_waiting: bool) -> CloseAction {
    match (stays, release && !update_waiting) {
        (false, _) => CloseAction::Quit,
        (true, true) => CloseAction::Release,
        (true, false) => CloseAction::Hide,
    }
}

/// Whether NOVA keeps running once its main window is closed.
pub fn stays_in_background<R: Runtime>(app: &AppHandle<R>) -> bool {
    state(app).close_to_tray.load(Ordering::Relaxed) || crate::assistant::runs_in_background(app)
}

/// The main window's ✕ (or Alt+F4); the close itself is always prevented.
pub fn on_main_close_requested<R: Runtime>(window: &tauri::Window<R>) {
    let app = window.app_handle();
    let action = close_action(stays_in_background(app), crate::performance::prefs(app).release_main_window, crate::updates::waiting(app));
    if action == CloseAction::Quit {
        // Quit for real: the assistant windows would otherwise keep NOVA alive.
        app.exit(0);
        return;
    }
    let _ = window.hide();
    if let Some(main) = app.get_webview_window(MAIN_LABEL) {
        set_page_visible(&main, false);
    }
    if action == CloseAction::Release {
        let (app, asked) = (app.clone(), state(app).shown.load(Ordering::SeqCst));
        std::thread::spawn(move || {
            std::thread::sleep(RELEASE_AFTER);
            // Asked for again meanwhile: it stays.
            if state(&app).shown.load(Ordering::SeqCst) == asked {
                if let Some(main) = app.get_webview_window(MAIN_LABEL) {
                    let _ = main.destroy();
                }
            }
        });
    }
}

/// The main window is gone (it was closed to the tray): what its page did in the background goes on here.
pub fn on_main_destroyed<R: Runtime>(app: &AppHandle<R>) {
    state(app).main().loaded = false;
    crate::reminders::watch_while_main_is_gone(app);
}

/// Keeps `event` for the main window's page, which doesn't exist right now.
pub fn missed_by_main<R: Runtime>(app: &AppHandle<R>, event: &'static str, payload: Value) {
    let mut main = state(app).main();
    main.missed.push(Missed { event, payload });
    let extra = main.missed.len().saturating_sub(MOST_MISSED);
    main.missed.drain(..extra);
}

/// Startup. `in_background`: NOVA was started with Windows and its window stays hidden.
pub fn init<R: Runtime>(app: &AppHandle<R>, in_background: bool) {
    // "Pair this phone?" is answered in the main window: bring it up (it may not
    // even exist), and keep the question for a page that wasn't there to hear it.
    let handle = app.clone();
    app.listen(crate::companion::EVENT_PAIR_REQUEST, move |event| {
        let listening = state(&handle).main().loaded && handle.get_webview_window(MAIN_LABEL).is_some();
        if !listening {
            missed_by_main(&handle, crate::companion::EVENT_PAIR_REQUEST, serde_json::from_str(event.payload()).unwrap_or(Value::Null));
        }
        show_main_window(&handle);
    });
    if !in_background {
        return;
    }
    state(app).main().never_shown = true;
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(BACKGROUND_SETTLE);
        if !state(&app).main().never_shown {
            return;
        }
        // An update that was found is installed by the page's countdown: look again later.
        if crate::updates::waiting(&app) {
            continue;
        }
        if crate::performance::prefs(&app).release_main_window && stays_in_background(&app) {
            if let Some(window) = app.get_webview_window(MAIN_LABEL) {
                let _ = window.destroy();
            }
        }
        return;
    });
}

/// Tells WebView2 whether anyone can see the page. Hidden, it stops rendering,
/// animating and running timers at full pace (this also flips
/// `document.visibilityState`, which pauses NOVA's polling), and it is asked to
/// hold as little memory as it can: Windows may then page the rest out.
pub fn set_page_visible<R: Runtime>(window: &tauri::WebviewWindow<R>, visible: bool) {
    #[cfg(windows)]
    let _ = window.with_webview(move |webview| {
        use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL};
        use windows::core::Interface;
        let controller = webview.controller();
        // SAFETY: plain COM calls on this webview's own controller, on its UI thread.
        unsafe {
            let _ = controller.SetIsVisible(visible);
            // WebView2 before version 119 has no memory target: the cast fails and nothing changes.
            if let Ok(page) = controller.CoreWebView2().and_then(|core| core.cast::<ICoreWebView2_19>()) {
                let _ = page.SetMemoryUsageTargetLevel(if visible { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW });
            }
        }
    });
    #[cfg(not(windows))]
    let _ = (window, visible);
}

pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open NOVA", true, None::<&str>)?;
    let talk = crate::assistant::tray_item(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit NOVA", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &talk, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut builder = TrayIconBuilder::with_id("nova")
        .tooltip("NOVA")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(windows)]
mod autostart {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::System::Registry::{RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ};

    const RUN_KEY: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    const VALUE_NAME: PCWSTR = w!("NOVA");

    pub fn enabled() -> bool {
        // SAFETY: query-only call with null output buffers (existence check).
        unsafe { RegGetValueW(HKEY_CURRENT_USER, RUN_KEY, VALUE_NAME, RRF_RT_REG_SZ, None, None, None).is_ok() }
    }

    pub fn set(enabled: bool, command: &str) -> Result<(), String> {
        // SAFETY: the data buffer is a NUL-terminated UTF-16 string whose byte length is passed exactly.
        let result = unsafe {
            if enabled {
                let data = HSTRING::from(command);
                let bytes = (data.len() + 1) * 2;
                RegSetKeyValueW(HKEY_CURRENT_USER, RUN_KEY, VALUE_NAME, REG_SZ.0, Some(data.as_ptr() as *const _), bytes as u32)
            } else {
                RegDeleteKeyValueW(HKEY_CURRENT_USER, RUN_KEY, VALUE_NAME)
            }
        };
        if result.is_ok() || !enabled {
            Ok(())
        } else {
            Err(format!("Windows refused to change the startup entry ({})", result.0))
        }
    }
}

#[cfg(not(windows))]
mod autostart {
    pub fn enabled() -> bool {
        false
    }
    pub fn set(_: bool, _: &str) -> Result<(), String> {
        Err("Start with Windows is only available on Windows".into())
    }
}

#[tauri::command]
pub async fn desktop_set_close_to_tray(state: tauri::State<'_, DesktopState>, enabled: bool) -> CommandResult<()> {
    state.close_to_tray.store(enabled, Ordering::Relaxed);
    Ok(())
}

/// What the main window's page gets when it is up.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MainReady {
    /// Where to go, asked for while the page was loading.
    go_to: Option<Navigation>,
    /// What happened while no page was there to handle it, oldest first.
    missed: Vec<Missed>,
}

/// The main window's page is up and listens.
#[tauri::command]
pub async fn desktop_main_ready<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>) -> CommandResult<MainReady> {
    if window.label() != MAIN_LABEL {
        return Err("only the main window can do this".into());
    }
    let (ready, asked_at) = {
        let mut main = state(&app).main();
        main.loaded = true;
        (MainReady { go_to: main.go_to.take(), missed: std::mem::take(&mut main.missed) }, main.asked_at.take())
    };
    if let Some(asked_at) = asked_at {
        crate::performance::note_main_reopened(&app, asked_at.elapsed().as_millis() as u64);
    }
    Ok(ready)
}

#[tauri::command]
pub async fn autostart_get() -> CommandResult<bool> {
    Ok(autostart::enabled())
}

#[tauri::command]
pub async fn autostart_set(enabled: bool) -> CommandResult<bool> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    autostart::set(enabled, &format!("\"{}\" {BACKGROUND_FLAG}", exe.display()))?;
    Ok(autostart::enabled())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_quits_hides_or_releases() {
        // Nothing keeps NOVA running: closing the window ends it, whatever else is set.
        assert_eq!(close_action(false, true, false), CloseAction::Quit);
        assert_eq!(close_action(false, false, true), CloseAction::Quit);
        // In the tray: the page's memory goes back to Windows, unless the user keeps it …
        assert_eq!(close_action(true, true, false), CloseAction::Release);
        assert_eq!(close_action(true, false, false), CloseAction::Hide);
        // … or the page is counting down to an update it will install.
        assert_eq!(close_action(true, true, true), CloseAction::Hide);
    }

    #[test]
    fn a_window_that_comes_back_knows_where_to_open() {
        assert_eq!(opening_script(None), r#"window.__NOVA_OPENING__ = {"reopened":true,"route":null,"section":null};"#);
        let settings = Navigation { route: "settings", section: "assistant" };
        assert_eq!(opening_script(Some(&settings)), r#"window.__NOVA_OPENING__ = {"reopened":true,"route":"settings","section":"assistant"};"#);
        assert_eq!(serde_json::to_value(&settings).unwrap(), serde_json::json!({ "route": "settings", "section": "assistant" }));
    }
}
