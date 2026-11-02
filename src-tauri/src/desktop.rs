//! Desktop integration: tray icon, optional close-to-tray, and optional start
//! with Windows. Background behaviors are off until the user enables them.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

type CommandResult<T> = Result<T, String>;

pub const BACKGROUND_FLAG: &str = "--background";
const PREFERENCES_KEY: &str = "nova.desktop";

#[derive(Default)]
pub struct DesktopState {
    pub close_to_tray: AtomicBool,
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

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        set_page_visible(&window, true);
    }
}

/// WebView2 keeps rendering, animating and running timers in minimized or
/// hidden windows unless told the page isn't visible. Telling it also flips
/// `document.visibilityState`, which pauses NOVA's polling and animations.
pub fn set_page_visible<R: Runtime>(window: &tauri::WebviewWindow<R>, visible: bool) {
    #[cfg(windows)]
    let _ = window.with_webview(move |webview| {
        // SAFETY: a plain COM call on this webview's own controller, on its UI thread.
        let _ = unsafe { webview.controller().SetIsVisible(visible) };
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
