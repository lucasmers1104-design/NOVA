//! NOVA AI desktop assistant: the floating dot, the panel that expands from
//! it, their placement across monitors, and the global shortcut.
//!
//! The dot and the panel are two small transparent always-on-top windows, so
//! the dot never covers more of the desktop than itself and the panel can
//! animate without resizing a window. Nothing in this module records audio or
//! captures the screen.

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut};
use tauri_plugin_notification::NotificationExt;

use crate::storage::Database;

type CommandResult<T> = Result<T, String>;

pub const DOT_LABEL: &str = "dot";
pub const PANEL_LABEL: &str = "assistant";
/// Ctrl+Alt+Space is often taken by other assistants; AltGr+N types nothing on common layouts.
pub const DEFAULT_SHORTCUT: &str = "Ctrl+Alt+N";
const PREFS_KEY: &str = "nova.assistant";
const SETTINGS_KEY: &str = "nova.settings";
const MAX_SHORTCUT_LEN: usize = 40;

/// Transparent room around the dot for hover growth and activity rings (logical px).
const DOT_ROOM: f64 = 8.0;
/// Extra room when the dot glows.
const GLOW_ROOM: f64 = 10.0;
/// Visible gap between the dot and the notification area when it sits in the taskbar.
const TRAY_GAP: f64 = 8.0;
/// Transparent room around the panel for its shadow.
const PANEL_PAD: f64 = 16.0;
/// Visible gap between the dot and the panel; at least `PANEL_PAD`, so the
/// panel's shadow room never covers the dot and swallows its clicks.
const PANEL_GAP: f64 = 18.0;
const PANEL_WIDTH: f64 = 460.0;
const PANEL_MAX_HEIGHT: f64 = 620.0;
const PANEL_MIN_HEIGHT: f64 = 340.0;
/// How long a dragged dot has to rest (button released) before it is saved.
const DRAG_SETTLE: Duration = Duration::from_millis(250);
/// The panel hides by itself if its exit animation never reports back.
const COLLAPSE_FALLBACK: Duration = Duration::from_millis(600);

const EVENT_EXPAND: &str = "assistant://expand";
const EVENT_COLLAPSE: &str = "assistant://collapse";
const EVENT_PANEL: &str = "assistant://panel";
const EVENT_DOT: &str = "assistant://dot";
const EVENT_PREFS: &str = "assistant://prefs";
const EVENT_NAVIGATE: &str = "nova://navigate";
const EVENT_WAKE: &str = "assistant://wake";

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Corner {
    #[default]
    BottomRight,
    BottomLeft,
    TopRight,
    TopLeft,
}

/// Where the dot lives until the user drags it somewhere else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Placement {
    /// In the taskbar, just left of the notification area.
    #[default]
    Taskbar,
    /// In a corner of the desktop (`corner`).
    Corner,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DotStyle {
    /// A frosted-glass bead tinted with the dot's color.
    #[default]
    Glass,
    /// The glossy NOVA orb.
    Orb,
    /// A flat dot of color.
    Solid,
    /// A thin ring.
    Ring,
}

/// How the dot looks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DotLook {
    pub style: DotStyle,
    /// Logical px, 16–56.
    pub diameter: u8,
    /// Opacity at rest in percent (25–100); hovering or activity shows it fully.
    pub idle_opacity: u8,
    /// "accent", "white" or "#rrggbb".
    pub color: String,
    /// A soft glow around it.
    pub glow: bool,
    /// Breathes briefly now and then while idle.
    pub breathe: bool,
    /// The sparkle inside.
    pub icon: bool,
    /// Rings and colors while NOVA listens, thinks or works.
    pub activity: bool,
    /// Gap to the screen edges in a corner (logical px, 0–48).
    pub edge_gap: u8,
}

impl Default for DotLook {
    fn default() -> Self {
        Self { style: DotStyle::Glass, diameter: 24, idle_opacity: 70, color: "accent".into(), glow: false, breathe: false, icon: true, activity: true, edge_gap: 12 }
    }
}

fn valid_color(color: &str) -> bool {
    color == "accent" || color == "white" || (color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit()))
}

impl DotLook {
    /// The same look with every value limited to what the dot can show.
    fn sanitized(mut self) -> Self {
        self.diameter = self.diameter.clamp(16, 56);
        self.idle_opacity = self.idle_opacity.clamp(25, 100);
        self.edge_gap = self.edge_gap.min(48);
        if !valid_color(&self.color) {
            self.color = "accent".into();
        }
        self
    }

    /// Transparent room around the dot (logical px).
    fn room(&self) -> f64 {
        if self.glow {
            DOT_ROOM + GLOW_ROOM
        } else {
            DOT_ROOM
        }
    }

    /// Logical side of the dot window, room included.
    fn window_side(&self) -> f64 {
        self.diameter as f64 + 2.0 * self.room()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AssistantPrefs {
    /// Show the floating dot.
    pub enabled: bool,
    pub placement: Placement,
    pub corner: Corner,
    pub look: DotLook,
    /// Global shortcut that opens and closes the panel; empty means none.
    pub shortcut: String,
    /// Keep NOVA running with the assistant when the main window is closed.
    pub background: bool,
    /// Hide the dot while a fullscreen app, game or presentation is in front.
    pub hide_in_fullscreen: bool,
    /// Where the user dragged the dot (physical top-left of its window). Overrides `corner`.
    pub position: Option<Point>,
    /// Where the user dragged the panel (physical top-left of its window); beside the dot without one.
    pub panel_position: Option<Point>,
    /// The panel stays where it is, and stays open when NOVA's main window comes up.
    pub panel_pinned: bool,
}

impl Default for AssistantPrefs {
    fn default() -> Self {
        Self {
            enabled: true,
            placement: Placement::default(),
            corner: Corner::default(),
            look: DotLook::default(),
            shortcut: DEFAULT_SHORTCUT.into(),
            background: false,
            hide_in_fullscreen: false,
            position: None,
            panel_position: None,
            panel_pinned: false,
        }
    }
}

/// Reads the stored preferences; anything malformed falls back to defaults.
pub fn load_prefs(db: &Database) -> AssistantPrefs {
    db.with(|conn| crate::storage::kv_get(conn, PREFS_KEY))
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<AssistantPrefs>(&raw).ok())
        .map(|mut prefs| {
            if prefs.shortcut.len() > MAX_SHORTCUT_LEN || parse_shortcut(&prefs.shortcut).is_err() {
                prefs.shortcut = DEFAULT_SHORTCUT.into();
            }
            prefs.look = prefs.look.sanitized();
            prefs
        })
        .unwrap_or_default()
}

fn save_prefs<R: Runtime>(app: &AppHandle<R>, prefs: &AssistantPrefs) {
    let Ok(json) = serde_json::to_string(prefs) else { return };
    if let Err(error) = app.state::<Database>().with(|conn| crate::storage::kv_set(conn, PREFS_KEY, &json)) {
        eprintln!("[NOVA] could not save assistant preferences: {error}");
    }
}

/// Validates a shortcut such as `Ctrl+Alt+Space`. It needs Ctrl, Alt or Win,
/// so ordinary typing (letters, Shift+letter) is never intercepted.
pub fn parse_shortcut(raw: &str) -> Result<Option<Shortcut>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    if raw.len() > MAX_SHORTCUT_LEN {
        return Err("That shortcut is too long.".into());
    }
    let shortcut: Shortcut = raw.parse().map_err(|_| format!("“{raw}” isn't a shortcut NOVA understands."))?;
    if !shortcut.mods.intersects(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER) {
        return Err("Combine a key with Ctrl, Alt or Win, so normal typing isn't intercepted.".into());
    }
    Ok(Some(shortcut))
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Inner {
    prefs: AssistantPrefs,
    registered: Option<Shortcut>,
    shortcut_error: Option<String>,
    /// Where NOVA last put the dot; a move to anywhere else is a user drag.
    placed_at: Option<PhysicalPosition<i32>>,
    /// Latest dragged position, saved once the drag settles.
    dragged_to: Option<PhysicalPosition<i32>>,
    /// The panel is shown, or will be as soon as its page has loaded.
    panel_open: bool,
    /// Its exit animation is playing: it still counts as open, but is on its way out.
    collapsing: bool,
    panel_loaded: bool,
    panel_creating: bool,
    /// The panel corner nearest the dot; the panel grows out of it.
    panel_origin: Corner,
    /// "Hey NOVA" or a double clap opened the panel; handed to it when it shows.
    pending_wake: Option<WakeCall>,
    /// Where NOVA last put the panel; a move to anywhere else is a user drag.
    panel_placed_at: Option<PhysicalPosition<i32>>,
    /// Latest dragged position of the panel, saved once the drag settles.
    panel_dragged_to: Option<PhysicalPosition<i32>>,
}

#[derive(Default)]
pub struct AssistantState {
    inner: Mutex<Inner>,
    settling: AtomicBool,
    drag_generation: AtomicU64,
    panel_settling: AtomicBool,
    panel_drag_generation: AtomicU64,
    collapse_generation: AtomicU64,
    watching_fullscreen: AtomicBool,
    watching_taskbar: AtomicBool,
}

/// The dot's window handle while it sits in the taskbar (0 otherwise); the
/// foreground hook lifts it back over the taskbar after clicks there.
static TASKBAR_DOT: AtomicIsize = AtomicIsize::new(0);

impl AssistantState {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panic elsewhere must not take the assistant down with it.
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn state<R: Runtime>(app: &AppHandle<R>) -> &AssistantState {
    app.state::<AssistantState>().inner()
}

/// Whether closing the main window should keep NOVA running for the assistant.
/// The dot stays on the desktop after the window closes; quit from the tray or the dot's menu.
pub fn runs_in_background<R: Runtime>(app: &AppHandle<R>) -> bool {
    let inner = state(app).lock();
    inner.prefs.background || inner.prefs.enabled
}

// ---------------------------------------------------------------------------
// Geometry (physical pixels on the virtual desktop)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    fn right(self) -> i32 {
        self.x + self.w
    }
    fn bottom(self) -> i32 {
        self.y + self.h
    }
    fn center(self) -> (i32, i32) {
        (self.x + self.w / 2, self.y + self.h / 2)
    }
    fn contains(self, (x, y): (i32, i32)) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }
}

/// A monitor's work area (the desktop without the taskbar) and its scale.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Screen {
    pub work: Rect,
    pub scale: f64,
}

fn px(logical: f64, scale: f64) -> i32 {
    (logical * scale).round() as i32
}

/// `value` limited to `lo..=hi`; `lo` wins if the range is empty.
fn fit(value: i32, lo: i32, hi: i32) -> i32 {
    value.min(hi).max(lo)
}

fn dot_side(screen: Screen, look: &DotLook) -> i32 {
    px(look.window_side(), screen.scale)
}

/// Top-left of the dot window in `corner` of the screen's work area.
pub fn corner_position(screen: Screen, corner: Corner, look: &DotLook) -> (i32, i32) {
    let side = dot_side(screen, look);
    let inset = px(look.edge_gap as f64 - look.room(), screen.scale);
    let work = screen.work;
    let (left, right) = (work.x + inset, work.right() - side - inset);
    let (top, bottom) = (work.y + inset, work.bottom() - side - inset);
    match corner {
        Corner::BottomRight => (right, bottom),
        Corner::BottomLeft => (left, bottom),
        Corner::TopRight => (right, top),
        Corner::TopLeft => (left, top),
    }
}

/// Keeps a dragged dot on screen: its room may overhang the work area, the dot may not.
pub fn clamp_dot(screen: Screen, look: &DotLook, (x, y): (i32, i32)) -> (i32, i32) {
    let side = dot_side(screen, look);
    let margin = px(look.room(), screen.scale);
    let work = screen.work;
    (fit(x, work.x - margin, work.right() - side + margin), fit(y, work.y - margin, work.bottom() - side + margin))
}

/// The taskbar (physical px) and the first thing after its app buttons: a
/// widget such as "News and interests", or else the notification area.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Taskbar {
    pub bar: Rect,
    pub next: Rect,
}

/// Top-left of the dot window in the taskbar: at the end of the app buttons,
/// just before `next`, centred across the bar (taskbars on the left or right
/// included). `gap` is the space between the window and `next`.
pub fn taskbar_position(taskbar: Taskbar, side: i32, gap: i32) -> (i32, i32) {
    let Taskbar { bar, next } = taskbar;
    if bar.w >= bar.h {
        (next.x - gap - side, bar.y + (bar.h - side) / 2)
    } else {
        (bar.x + (bar.w - side) / 2, next.y - gap - side)
    }
}

/// Of the taskbar's parts, the first one that starts after the app buttons.
pub fn first_after(buttons: Rect, parts: &[Rect], horizontal: bool) -> Option<Rect> {
    let start = |r: &Rect| if horizontal { r.x } else { r.y };
    let end = if horizontal { buttons.right() } else { buttons.bottom() };
    parts.iter().copied().filter(|r| r.w > 0 && r.h > 0 && start(r) >= end - 2).min_by_key(start)
}

/// The primary taskbar, unless it hides itself (then the dot uses a corner).
#[cfg(windows)]
fn find_taskbar() -> Option<Taskbar> {
    use windows::core::w;
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::Shell::{SHAppBarMessage, ABM_GETSTATE, ABS_AUTOHIDE, APPBARDATA};
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, FindWindowW, GetWindow, GetWindowRect, IsWindowVisible, GW_CHILD, GW_HWNDNEXT};
    let rect = |r: RECT| Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
    // SAFETY: read-only queries of the shell's own windows; the structs are sized for the calls.
    unsafe {
        let bar = FindWindowW(w!("Shell_TrayWnd"), None).ok()?;
        let mut data = APPBARDATA { cbSize: size_of::<APPBARDATA>() as u32, hWnd: bar, ..Default::default() };
        if SHAppBarMessage(ABM_GETSTATE, &mut data) as u32 & ABS_AUTOHIDE != 0 {
            return None;
        }
        let window_rect = |hwnd| {
            let mut r = RECT::default();
            GetWindowRect(hwnd, &mut r).ok().map(|()| rect(r))
        };
        let bar_rect = window_rect(bar)?;
        let tray = window_rect(FindWindowExW(Some(bar), None, w!("TrayNotifyWnd"), None).ok()?)?;
        let buttons = FindWindowExW(Some(bar), None, w!("ReBarWindow32"), None).ok().and_then(window_rect);
        // Everything visible directly on the taskbar: widgets sit between the app buttons and the tray.
        let mut parts = Vec::new();
        let mut child = GetWindow(bar, GW_CHILD);
        while let Ok(part) = child {
            if IsWindowVisible(part).as_bool() {
                parts.extend(window_rect(part));
            }
            child = GetWindow(part, GW_HWNDNEXT);
        }
        let horizontal = bar_rect.w >= bar_rect.h;
        let next = buttons.and_then(|b| first_after(b, &parts, horizontal)).unwrap_or(tray);
        (bar_rect.w > 0 && bar_rect.h > 0).then_some(Taskbar { bar: bar_rect, next })
    }
}

#[cfg(not(windows))]
fn find_taskbar() -> Option<Taskbar> {
    None
}

/// Keeps a topmost window above the others (the taskbar rises over the dot when clicked).
#[cfg(windows)]
fn raise_window(raw: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE};
    // SAFETY: z-order change of NOVA's own dot window; no activation, size or position change.
    let _ = unsafe { SetWindowPos(HWND(raw as *mut _), Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER) };
}

/// Whether the taskbar is above `window` in the z-order (only topmost windows
/// are above the dot, so the walk is short).
#[cfg(windows)]
fn taskbar_above(window: isize) -> bool {
    use windows::core::w;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, GetWindow, GW_HWNDPREV};
    // SAFETY: read-only z-order queries.
    unsafe {
        let Ok(taskbar) = FindWindowW(w!("Shell_TrayWnd"), None) else { return false };
        let mut above = GetWindow(HWND(window as *mut _), GW_HWNDPREV);
        for _ in 0..256 {
            match above {
                Ok(hwnd) if hwnd == taskbar => return true,
                Ok(hwnd) => above = GetWindow(hwnd, GW_HWNDPREV),
                Err(_) => return false,
            }
        }
        false
    }
}

/// The foreground hook's report: a click on the taskbar lifts it over a
/// docked dot, so lift the dot back up.
#[cfg(windows)]
pub fn on_foreground(window: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;
    let dot = TASKBAR_DOT.load(Ordering::SeqCst);
    if dot == 0 || window == 0 {
        return;
    }
    let mut class = [0u16; 32];
    // SAFETY: the buffer outlives the call and its length is passed.
    let len = unsafe { GetClassNameW(HWND(window as *mut _), &mut class) } as usize;
    let class = String::from_utf16_lossy(&class[..len.min(class.len())]);
    if class == "Shell_TrayWnd" || class == "Shell_SecondaryTrayWnd" {
        raise_window(dot);
    }
}

fn screen_containing(screens: &[Screen], point: (i32, i32)) -> Option<Screen> {
    screens.iter().copied().find(|s| s.work.contains(point))
}

/// The screen showing `point`, or the closest one (e.g. for a dot dropped on the taskbar).
pub fn nearest_screen(screens: &[Screen], point: (i32, i32)) -> Option<Screen> {
    screen_containing(screens, point).or_else(|| {
        screens.iter().copied().min_by_key(|s| {
            let dx = (s.work.x - point.0).max(point.0 - s.work.right()).max(0) as i64;
            let dy = (s.work.y - point.1).max(point.1 - s.work.bottom()).max(0) as i64;
            dx * dx + dy * dy
        })
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PanelPlacement {
    /// The panel window, shadow room included.
    pub window: Rect,
    /// The panel corner nearest the dot.
    pub origin: Corner,
}

/// Opens the panel beside the dot: above it when the dot sits in the lower
/// half of the screen, aligned with the dot's outer edge, always inside the
/// work area.
pub fn panel_placement(screen: Screen, dot_window: Rect, room: f64) -> PanelPlacement {
    let s = screen.scale;
    let work = screen.work;
    let margin = px(room, s);
    let dot = Rect { x: dot_window.x + margin, y: dot_window.y + margin, w: dot_window.w - 2 * margin, h: dot_window.h - 2 * margin };
    let (pad, gap) = (px(PANEL_PAD, s), px(PANEL_GAP, s));
    let (dot_x, dot_y) = dot.center();
    let (mid_x, mid_y) = work.center();
    let opens_down = dot_y < mid_y;
    let aligns_left = dot_x < mid_x;

    let width = px(PANEL_WIDTH, s).min(work.w - 2 * pad);
    let room = if opens_down { work.bottom() - pad - (dot.bottom() + gap) } else { dot.y - gap - (work.y + pad) };
    let height = px(PANEL_MAX_HEIGHT, s).min(room).max(px(PANEL_MIN_HEIGHT, s).min(work.h - 2 * pad));

    let x = if aligns_left { dot.x } else { dot.right() - width };
    let y = if opens_down { dot.bottom() + gap } else { dot.y - gap - height };
    let x = fit(x, work.x + pad, work.right() - pad - width);
    let y = fit(y, work.y + pad, work.bottom() - pad - height);

    let origin = match (opens_down, aligns_left) {
        (true, true) => Corner::TopLeft,
        (true, false) => Corner::TopRight,
        (false, true) => Corner::BottomLeft,
        (false, false) => Corner::BottomRight,
    };
    PanelPlacement { window: Rect { x: x - pad, y: y - pad, w: width + 2 * pad, h: height + 2 * pad }, origin }
}

/// The panel where the user put it, fully on `screen`. It grows out of the corner
/// nearest the screen's edge, like beside the dot.
pub fn panel_at(screen: Screen, (x, y): (i32, i32)) -> PanelPlacement {
    let s = screen.scale;
    let work = screen.work;
    let pad = px(PANEL_PAD, s);
    let width = px(PANEL_WIDTH, s).min(work.w - 2 * pad) + 2 * pad;
    let height = px(PANEL_MAX_HEIGHT, s).min(work.h - 2 * pad) + 2 * pad;
    let window = Rect { x: fit(x, work.x, work.right() - width), y: fit(y, work.y, work.bottom() - height), w: width, h: height };
    let (mid_x, mid_y) = work.center();
    let (x, y) = window.center();
    let origin = match (y < mid_y, x < mid_x) {
        (true, true) => Corner::TopLeft,
        (true, false) => Corner::TopRight,
        (false, true) => Corner::BottomLeft,
        (false, false) => Corner::BottomRight,
    };
    PanelPlacement { window, origin }
}

fn screen_of(monitor: &Monitor) -> Screen {
    let area = monitor.work_area();
    Screen {
        work: Rect { x: area.position.x, y: area.position.y, w: area.size.width as i32, h: area.size.height as i32 },
        scale: monitor.scale_factor(),
    }
}

fn screens<R: Runtime>(app: &AppHandle<R>) -> Vec<Screen> {
    app.available_monitors().map(|monitors| monitors.iter().map(screen_of).collect()).unwrap_or_default()
}

fn primary_screen<R: Runtime>(app: &AppHandle<R>) -> Option<Screen> {
    app.primary_monitor().ok().flatten().map(|m| screen_of(&m)).or_else(|| screens(app).into_iter().next())
}

/// Where the dot belongs: its dragged position while that is still on a
/// connected screen, otherwise the chosen corner of the primary screen.
fn dot_target<R: Runtime>(app: &AppHandle<R>, prefs: &AssistantPrefs) -> Option<(Screen, Rect)> {
    let all = screens(app);
    let look = &prefs.look;
    let dragged = prefs.position.and_then(|p| {
        // The center in physical pixels: at 200 % a dot at the screen's edge would otherwise count as off it.
        let on_screen = all.iter().copied().find(|s| {
            let half = dot_side(*s, look) / 2;
            s.work.contains((p.x + half, p.y + half))
        })?;
        Some((on_screen, clamp_dot(on_screen, look, (p.x, p.y))))
    });
    let docked = || {
        let taskbar = find_taskbar()?;
        let screen = nearest_screen(&all, taskbar.bar.center())?;
        let gap = px((TRAY_GAP - look.room()).max(0.0), screen.scale);
        Some((screen, taskbar_position(taskbar, dot_side(screen, look), gap)))
    };
    let (screen, (x, y)) = match dragged {
        Some(found) => found,
        None => match (prefs.placement == Placement::Taskbar).then(docked).flatten() {
            Some(found) => found,
            None => {
                let screen = primary_screen(app)?;
                (screen, corner_position(screen, prefs.corner, look))
            }
        },
    };
    let side = dot_side(screen, look);
    Some((screen, Rect { x, y, w: side, h: side }))
}

/// The dot's window rectangle: where it is, or where it would be while hidden.
fn dot_rect<R: Runtime>(app: &AppHandle<R>) -> Option<(Screen, Rect)> {
    if let Some(dot) = app.get_webview_window(DOT_LABEL) {
        if let (Ok(pos), Ok(size)) = (dot.outer_position(), dot.outer_size()) {
            let rect = Rect { x: pos.x, y: pos.y, w: size.width as i32, h: size.height as i32 };
            if let Some(screen) = nearest_screen(&screens(app), rect.center()) {
                return Some((screen, rect));
            }
        }
    }
    let prefs = state(app).lock().prefs.clone();
    dot_target(app, &prefs)
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/// The windows animate themselves; Windows' own show/hide animation would play on top.
#[cfg(windows)]
fn disable_system_animations<R: Runtime>(window: &WebviewWindow<R>) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
    if let Ok(hwnd) = window.hwnd() {
        let disabled: i32 = 1;
        // SAFETY: valid window handle; the attribute value is a BOOL (i32) whose size is passed exactly.
        let _ = unsafe {
            DwmSetWindowAttribute(HWND(hwnd.0), DWMWA_TRANSITIONS_FORCEDISABLED, &disabled as *const i32 as *const _, size_of::<i32>() as u32)
        };
    }
}

#[cfg(not(windows))]
fn disable_system_animations<R: Runtime>(_: &WebviewWindow<R>) {}

/// Creates the dot window, hidden until its page reports ready. Must not run
/// on the main thread's event handlers (WebView2 deadlocks there).
fn create_dot<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let side = state(app).lock().prefs.look.window_side();
    let window = WebviewWindowBuilder::new(app, DOT_LABEL, WebviewUrl::App("dot.html".into()))
        .title("NOVA AI")
        .inner_size(side, side)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()?;
    disable_system_animations(&window);
    place_dot(app, &window);
    Ok(())
}

fn place_dot<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    let prefs = state(app).lock().prefs.clone();
    let Some((_, rect)) = dot_target(app, &prefs) else { return };
    let pos = PhysicalPosition::new(rect.x, rect.y);
    state(app).lock().placed_at = Some(pos);
    // Moving first lets a DPI change between monitors happen before sizing; then pin the position again.
    let _ = window.set_position(pos);
    let _ = window.set_size(PhysicalSize::new(rect.w as u32, rect.h as u32));
    let _ = window.set_position(pos);
}

fn create_panel<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    let window = WebviewWindowBuilder::new(app, PANEL_LABEL, WebviewUrl::App("assistant.html".into()))
        .title("NOVA AI")
        .inner_size(PANEL_WIDTH + 2.0 * PANEL_PAD, PANEL_MAX_HEIGHT + 2.0 * PANEL_PAD)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()?;
    disable_system_animations(&window);
    Ok(window)
}

fn position_panel<R: Runtime>(app: &AppHandle<R>, panel: &WebviewWindow<R>) -> Corner {
    let (room, moved) = {
        let inner = state(app).lock();
        (inner.prefs.look.room(), inner.prefs.panel_position)
    };
    // Where the user put it, while that screen is still connected.
    let all = screens(app);
    let placement = match moved.and_then(|p| screen_containing(&all, (p.x + 40, p.y + 40)).map(|screen| panel_at(screen, (p.x, p.y)))) {
        Some(placement) => placement,
        None => {
            let Some((screen, dot)) = dot_rect(app) else { return Corner::default() };
            panel_placement(screen, dot, room)
        }
    };
    let rect = placement.window;
    let pos = PhysicalPosition::new(rect.x, rect.y);
    state(app).lock().panel_placed_at = Some(pos);
    let _ = panel.set_position(pos);
    let _ = panel.set_size(PhysicalSize::new(rect.w as u32, rect.h as u32));
    let _ = panel.set_position(pos);
    state(app).lock().panel_origin = placement.origin;
    placement.origin
}

/// Called for every move of the panel window: a drag is remembered once the mouse
/// button is up. NOVA's own moves and Windows' don't count.
pub fn on_panel_moved<R: Runtime>(app: &AppHandle<R>, pos: PhysicalPosition<i32>) {
    if is_parked(pos) || !mouse_button_down() {
        return;
    }
    let state = state(app);
    {
        let mut inner = state.lock();
        if !inner.panel_open || inner.panel_placed_at.is_some_and(|placed| (placed.x - pos.x).abs() <= 2 && (placed.y - pos.y).abs() <= 2) {
            return;
        }
        inner.panel_dragged_to = Some(pos);
    }
    state.panel_drag_generation.fetch_add(1, Ordering::SeqCst);
    if state.panel_settling.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let state = self::state(&app);
        loop {
            let seen = state.panel_drag_generation.load(Ordering::SeqCst);
            std::thread::sleep(DRAG_SETTLE);
            if state.panel_drag_generation.load(Ordering::SeqCst) == seen && !mouse_button_down() {
                break;
            }
        }
        state.panel_settling.store(false, Ordering::SeqCst);
        let prefs = {
            let mut inner = state.lock();
            let Some(pos) = inner.panel_dragged_to.take() else { return };
            inner.panel_placed_at = Some(pos);
            inner.prefs.panel_position = Some(Point { x: pos.x, y: pos.y });
            inner.prefs.clone()
        };
        save_prefs(&app, &prefs);
    });
}

/// A request needs the user's OK: the panel has to be up for them to give it.
pub fn ensure_open<R: Runtime>(app: &AppHandle<R>) {
    let open = {
        let inner = state(app).lock();
        inner.panel_open && !inner.collapsing
    };
    if !open {
        expand(app);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExpandEvent {
    origin: Corner,
    wake: Option<WakeCall>,
}

/// The panel opened by itself: what woke NOVA and what the panel should do.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeCall {
    source: crate::wake::Source,
    /// Start listening for a spoken request.
    listen: bool,
    /// Play the wake sound.
    chime: bool,
    /// A game fills the screen: answer by voice, without the panel.
    headless: bool,
    /// What was said right after the call: goes straight to NOVA AI, without a greeting.
    request: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CollapseEvent {
    generation: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PanelEvent {
    open: bool,
}

fn show_panel<R: Runtime>(app: &AppHandle<R>, panel: &WebviewWindow<R>, origin: Corner) {
    let _ = panel.show();
    crate::desktop::set_page_visible(panel, true);
    let _ = panel.set_focus();
    let wake = state(app).lock().pending_wake.take();
    let _ = app.emit_to(PANEL_LABEL, EVENT_EXPAND, ExpandEvent { origin, wake });
    // A question is likely next: warm the AI provider's cache (skipped while
    // it's still warm) and NOVA's voice.
    crate::tts::warm(app);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move { crate::agent::prewarm(&handle).await });
}

/// Opens the panel next to the dot (creating it on first use).
pub fn expand<R: Runtime>(app: &AppHandle<R>) {
    let state = state(app);
    state.collapse_generation.fetch_add(1, Ordering::SeqCst);
    let (loaded, creating) = {
        let mut inner = state.lock();
        inner.panel_open = true;
        inner.collapsing = false;
        (inner.panel_loaded, inner.panel_creating)
    };
    let _ = app.emit_to(DOT_LABEL, EVENT_PANEL, PanelEvent { open: true });
    if let Some(panel) = app.get_webview_window(PANEL_LABEL) {
        let origin = position_panel(app, &panel);
        if loaded {
            show_panel(app, &panel, origin);
        }
        return;
    }
    if creating {
        return;
    }
    state.lock().panel_creating = true;
    // Windows are created off the main thread (WebView2 deadlocks in event handlers).
    // The panel shows itself once its page is ready: see `assistant_panel_ready`.
    let app = app.clone();
    std::thread::spawn(move || {
        let created = create_panel(&app);
        self::state(&app).lock().panel_creating = false;
        match created {
            Ok(panel) => {
                position_panel(&app, &panel);
            }
            Err(error) => {
                eprintln!("[NOVA] assistant panel unavailable: {error}");
                self::state(&app).lock().panel_open = false;
                let _ = app.emit_to(DOT_LABEL, EVENT_PANEL, PanelEvent { open: false });
            }
        }
    });
}

/// Asks the panel to play its exit animation; it then reports back through
/// `assistant_panel_hidden`. Hides it anyway if it never does.
pub fn request_collapse<R: Runtime>(app: &AppHandle<R>) {
    let state = state(app);
    {
        let mut inner = state.lock();
        if !inner.panel_open {
            return;
        }
        inner.collapsing = true;
    }
    let generation = state.collapse_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit_to(PANEL_LABEL, EVENT_COLLAPSE, CollapseEvent { generation });
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(COLLAPSE_FALLBACK);
        hide_panel(&app, generation);
    });
}

/// Hides the panel unless it was reopened since `generation` was issued.
fn hide_panel<R: Runtime>(app: &AppHandle<R>, generation: u64) {
    let state = state(app);
    if state.collapse_generation.load(Ordering::SeqCst) != generation {
        return;
    }
    {
        let mut inner = state.lock();
        inner.panel_open = false;
        inner.collapsing = false;
        // A wake-up cancelled before the page loaded mustn't fire at the next opening.
        inner.pending_wake = None;
    }
    if let Some(panel) = app.get_webview_window(PANEL_LABEL) {
        let _ = panel.hide();
        crate::desktop::set_page_visible(&panel, false);
    }
    let _ = app.emit_to(DOT_LABEL, EVENT_PANEL, PanelEvent { open: false });
}

/// A game is in front and NOVA's window isn't open, so nobody can see or click anything of NOVA's.
pub fn in_game<R: Runtime>(app: &AppHandle<R>) -> bool {
    !state(app).lock().panel_open && fullscreen_in_front()
}

/// Wakes NOVA in the panel's page without showing its window or taking the
/// game's focus. The page counts as visible meanwhile, so its timers keep their pace.
fn wake_without_panel<R: Runtime>(app: &AppHandle<R>, call: WakeCall, loaded: bool) {
    if loaded {
        if let Some(panel) = app.get_webview_window(PANEL_LABEL) {
            crate::desktop::set_page_visible(&panel, true);
        }
        let _ = app.emit_to(PANEL_LABEL, EVENT_WAKE, call);
        return;
    }
    let creating = {
        let mut inner = state(app).lock();
        inner.pending_wake = Some(call);
        std::mem::replace(&mut inner.panel_creating, true)
    };
    if creating || app.get_webview_window(PANEL_LABEL).is_some() {
        state(app).lock().panel_creating = creating;
        return;
    }
    // The page picks the wake-up up when it reports ready: see `assistant_panel_ready`.
    let app = app.clone();
    std::thread::spawn(move || {
        let created = create_panel(&app);
        self::state(&app).lock().panel_creating = false;
        if let Err(error) = created {
            eprintln!("[NOVA] assistant panel unavailable: {error}");
        }
    });
}

/// The voice-only turn in a game is over.
#[tauri::command]
pub async fn assistant_headless_done<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>) -> CommandResult<()> {
    if !state(&app).lock().panel_open {
        crate::desktop::set_page_visible(&window, false);
    }
    Ok(())
}

/// "Hey NOVA" or a double clap: opens the panel, or asks an open one to listen.
pub fn wake<R: Runtime>(app: &AppHandle<R>, source: crate::wake::Source, listen: bool, chime: bool, request: Option<String>) {
    let headless = in_game(app);
    let call = WakeCall { source, listen, chime, headless, request };
    // While NOVA greets: get recognition, the voice and the AI provider's cache ready.
    if listen {
        if crate::speech::stt::use_local(app) {
            crate::speech::stt::warm(app);
        } else {
            crate::voice::prepare(app);
        }
    }
    crate::tts::warm(app);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move { crate::agent::prewarm(&handle).await });
    let (open, loaded) = {
        let inner = state(app).lock();
        (inner.panel_open && !inner.collapsing, inner.panel_loaded)
    };
    if headless {
        wake_without_panel(app, call, loaded);
        return;
    }
    if open && loaded {
        if let Some(panel) = app.get_webview_window(PANEL_LABEL) {
            let _ = panel.set_focus();
        }
        let _ = app.emit_to(PANEL_LABEL, EVENT_WAKE, call);
        return;
    }
    state(app).lock().pending_wake = Some(call);
    expand(app);
}

/// Dot click, tray menu, command palette.
pub fn toggle<R: Runtime>(app: &AppHandle<R>) {
    let open = {
        let inner = state(app).lock();
        inner.panel_open && !inner.collapsing
    };
    if open {
        request_collapse(app);
    } else {
        expand(app);
    }
}

/// Global shortcut: opens the panel, focuses it if it lost focus, closes it otherwise.
pub fn on_shortcut<R: Runtime>(app: &AppHandle<R>) {
    let open = {
        let inner = state(app).lock();
        inner.panel_open && !inner.collapsing
    };
    match app.get_webview_window(PANEL_LABEL) {
        Some(panel) if open && !panel.is_focused().unwrap_or(false) => {
            let _ = panel.set_focus();
        }
        _ => toggle(app),
    }
}

fn register_shortcut<R: Runtime>(app: &AppHandle<R>, shortcut: Option<Shortcut>) -> Result<(), String> {
    let shortcuts = app.global_shortcut();
    let previous = state(app).lock().registered.take();
    if let Some(previous) = previous {
        let _ = shortcuts.unregister(previous);
    }
    if let Some(shortcut) = shortcut {
        shortcuts.register(shortcut).map_err(|_| "This shortcut is already used by another app. Choose a different one.".to_string())?;
        state(app).lock().registered = Some(shortcut);
    }
    Ok(())
}

/// Startup: show the dot and register the shortcut according to the saved preferences.
pub fn init<R: Runtime>(app: &AppHandle<R>, prefs: AssistantPrefs) {
    let shortcut = parse_shortcut(&prefs.shortcut).ok().flatten();
    let enabled = prefs.enabled;
    state(app).lock().prefs = prefs;
    if enabled {
        if let Err(error) = create_dot(app) {
            eprintln!("[NOVA] assistant dot unavailable: {error}");
        }
    }
    let error = register_shortcut(app, shortcut).err();
    state(app).lock().shortcut_error = error;
    let (fullscreen, taskbar) = {
        let inner = state(app).lock();
        (inner.prefs.enabled && inner.prefs.hide_in_fullscreen && !docked(&inner.prefs), docked(&inner.prefs))
    };
    if fullscreen {
        watch_fullscreen(app);
    }
    if taskbar {
        watch_taskbar(app);
    }
}

/// Where Windows parks minimized windows.
fn is_parked(pos: PhysicalPosition<i32>) -> bool {
    pos.x <= -30_000 || pos.y <= -30_000
}

/// The dot sits in the taskbar (shown, not dragged elsewhere).
fn docked(prefs: &AssistantPrefs) -> bool {
    prefs.enabled && prefs.position.is_none() && prefs.placement == Placement::Taskbar
}

/// While the dot sits in the taskbar, once a second: keeps it next to the
/// notification area as icons come and go, keeps it above the taskbar, and
/// hides it with the taskbar while a fullscreen app is in front. Stops when
/// the dot leaves the taskbar.
fn watch_taskbar<R: Runtime>(app: &AppHandle<R>) {
    let assistant = state(app);
    if assistant.watching_taskbar.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut hidden = false;
        loop {
            let (prefs, open) = {
                let inner = self::state(&app).lock();
                (inner.prefs.clone(), inner.panel_open)
            };
            let Some(dot) = app.get_webview_window(DOT_LABEL).filter(|_| docked(&prefs)) else { break };
            #[cfg(windows)]
            if let Ok(hwnd) = dot.hwnd() {
                TASKBAR_DOT.store(hwnd.0 as isize, Ordering::SeqCst);
            }
            let hide = !open && fullscreen_in_front();
            if hide != hidden {
                let _ = if hide { dot.hide() } else { dot.show() };
                hidden = hide;
            }
            if !hide {
                let moved = match (dot_target(&app, &prefs), dot.outer_position()) {
                    (Some((_, target)), Ok(now)) => (target.x - now.x).abs() > 1 || (target.y - now.y).abs() > 1,
                    _ => false,
                };
                if moved {
                    place_dot(&app, &dot);
                }
                // Only when the taskbar covers it: lifting it every time would also put it over its own menu.
                #[cfg(windows)]
                if taskbar_above(TASKBAR_DOT.load(Ordering::SeqCst)) {
                    raise_window(TASKBAR_DOT.load(Ordering::SeqCst));
                }
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        TASKBAR_DOT.store(0, Ordering::SeqCst);
        if hidden {
            if let Some(dot) = app.get_webview_window(DOT_LABEL) {
                let _ = dot.show();
            }
        }
        self::state(&app).watching_taskbar.store(false, Ordering::SeqCst);
    });
}

/// Whether Windows reports a fullscreen app, game or presentation in front.
#[cfg(windows)]
pub(crate) fn fullscreen_in_front() -> bool {
    use windows::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN};
    // SAFETY: a read-only query of the shell's notification state.
    matches!(unsafe { SHQueryUserNotificationState() }, Ok(s) if s == QUNS_BUSY || s == QUNS_RUNNING_D3D_FULL_SCREEN || s == QUNS_PRESENTATION_MODE)
}

#[cfg(not(windows))]
pub(crate) fn fullscreen_in_front() -> bool {
    false
}

/// Whether a presentation is running: nobody wants NOVA answering a clap then.
#[cfg(windows)]
pub(crate) fn presenting() -> bool {
    use windows::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_PRESENTATION_MODE};
    // SAFETY: a read-only query of the shell's notification state.
    matches!(unsafe { SHQueryUserNotificationState() }, Ok(s) if s == QUNS_PRESENTATION_MODE)
}

#[cfg(not(windows))]
pub(crate) fn presenting() -> bool {
    false
}

/// While "hide in fullscreen" is on, checks every two seconds (a cheap shell
/// query) and hides or shows the dot. Stops when the option is turned off.
fn watch_fullscreen<R: Runtime>(app: &AppHandle<R>) {
    let assistant = state(app);
    if assistant.watching_fullscreen.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut hidden = false;
        loop {
            let (enabled, open) = {
                let inner = self::state(&app).lock();
                (inner.prefs.enabled && inner.prefs.hide_in_fullscreen && !docked(&inner.prefs), inner.panel_open)
            };
            let hide = enabled && !open && fullscreen_in_front();
            if hide != hidden {
                if let Some(dot) = app.get_webview_window(DOT_LABEL) {
                    let _ = if hide { dot.hide() } else { dot.show() };
                }
                hidden = hide;
            }
            if !enabled {
                break;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        self::state(&app).watching_fullscreen.store(false, Ordering::SeqCst);
    });
}

/// Brings the windows in line with changed preferences.
fn apply<R: Runtime>(app: &AppHandle<R>, previous: &AssistantPrefs, prefs: &AssistantPrefs) {
    if prefs.hide_in_fullscreen && prefs.enabled && !docked(prefs) {
        watch_fullscreen(app);
    }
    match (prefs.enabled, app.get_webview_window(DOT_LABEL)) {
        (true, Some(dot)) => {
            place_dot(app, &dot);
            if previous.look != prefs.look {
                let _ = app.emit_to(DOT_LABEL, EVENT_DOT, dot_view(app));
            }
        }
        (true, None) => {
            if let Err(error) = create_dot(app) {
                eprintln!("[NOVA] assistant dot unavailable: {error}");
            }
        }
        (false, Some(dot)) => {
            let _ = dot.destroy();
        }
        (false, None) => {}
    }
    if docked(prefs) {
        watch_taskbar(app);
    }
    if state(app).lock().panel_open {
        if let Some(panel) = app.get_webview_window(PANEL_LABEL) {
            position_panel(app, &panel);
        }
    }
}

/// Called for every move of the dot window. Moves NOVA made itself are
/// ignored; a drag is saved once the mouse button is up and the dot rests.
pub fn on_dot_moved<R: Runtime>(app: &AppHandle<R>, pos: PhysicalPosition<i32>) {
    // Minimizing (Win+M, other tools) parks windows at -32000: not a drag. Bring the dot back.
    if is_parked(pos) {
        if let Some(dot) = app.get_webview_window(DOT_LABEL) {
            let _ = dot.unminimize();
            place_dot(app, &dot);
        }
        return;
    }
    let state = state(app);
    {
        let mut inner = state.lock();
        if inner.placed_at.is_some_and(|placed| (placed.x - pos.x).abs() <= 2 && (placed.y - pos.y).abs() <= 2) {
            inner.dragged_to = None;
            return;
        }
        // No button down and no drag going on: Windows moved it (a monitor went
        // away, the resolution changed). That isn't the user's new spot for it.
        if !mouse_button_down() && !state.settling.load(Ordering::SeqCst) {
            drop(inner);
            if let Some(dot) = app.get_webview_window(DOT_LABEL) {
                place_dot(app, &dot);
            }
            return;
        }
        inner.dragged_to = Some(pos);
    }
    state.drag_generation.fetch_add(1, Ordering::SeqCst);
    if state.settling.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let state = self::state(&app);
        loop {
            let seen = state.drag_generation.load(Ordering::SeqCst);
            std::thread::sleep(DRAG_SETTLE);
            if state.drag_generation.load(Ordering::SeqCst) == seen && !mouse_button_down() {
                break;
            }
        }
        state.settling.store(false, Ordering::SeqCst);
        settle_drag(&app);
    });
}

fn settle_drag<R: Runtime>(app: &AppHandle<R>) {
    let (dragged, look) = {
        let mut inner = state(app).lock();
        (inner.dragged_to.take(), inner.prefs.look.clone())
    };
    let Some(pos) = dragged else { return };
    let all = screens(app);
    let half = px(look.window_side(), 1.0) / 2;
    let Some(screen) = nearest_screen(&all, (pos.x + half, pos.y + half)) else { return };
    let (x, y) = clamp_dot(screen, &look, (pos.x, pos.y));
    let prefs = {
        let mut inner = state(app).lock();
        inner.prefs.position = Some(Point { x, y });
        inner.prefs.clone()
    };
    save_prefs(app, &prefs);
    if let Some(dot) = app.get_webview_window(DOT_LABEL) {
        place_dot(app, &dot);
    }
    // Out of the taskbar: only this watcher still hides the dot in fullscreen apps.
    if prefs.hide_in_fullscreen && prefs.enabled && !docked(&prefs) {
        watch_fullscreen(app);
    }
    if state(app).lock().panel_open {
        if let Some(panel) = app.get_webview_window(PANEL_LABEL) {
            position_panel(app, &panel);
        }
    }
    let _ = app.emit(EVENT_PREFS, status(app));
}

#[cfg(windows)]
fn mouse_button_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    // Both buttons: GetAsyncKeyState reports physical buttons, and left-handed setups swap them.
    // SAFETY: reads global key state; no pointers involved.
    unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0 || GetAsyncKeyState(VK_RBUTTON.0 as i32) < 0 }
}

#[cfg(not(windows))]
fn mouse_button_down() -> bool {
    false
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

const MENU_TALK: &str = "assistant-talk";
const MENU_OPEN: &str = "assistant-open";
const MENU_SETTINGS: &str = "assistant-settings";
const MENU_HIDE: &str = "assistant-hide";
const MENU_QUIT: &str = "assistant-quit";
const MENU_LISTEN: &str = "assistant-listen";

/// Handles the assistant's items in the tray and dot menus.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        MENU_TALK => toggle(app),
        MENU_OPEN => open_main(app, None),
        MENU_SETTINGS => open_main(app, Some("assistant")),
        MENU_HIDE => {
            // Off the main thread: hiding destroys the window that owns this menu.
            let app = app.clone();
            std::thread::spawn(move || hide_dot(&app));
        }
        MENU_QUIT => app.exit(0),
        MENU_LISTEN => crate::wake::toggle_muted(app),
        _ => {}
    }
}

/// The tray's "Talk to NOVA" item.
pub fn tray_item<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, MENU_TALK, "Talk to NOVA", true, None::<&str>)
}

fn hide_dot<R: Runtime>(app: &AppHandle<R>) {
    let (previous, prefs) = {
        let mut inner = state(app).lock();
        let previous = inner.prefs.clone();
        inner.prefs.enabled = false;
        (previous, inner.prefs.clone())
    };
    save_prefs(app, &prefs);
    apply(app, &previous, &prefs);
    let _ = app.emit(EVENT_PREFS, status(app));
    let active = state(app).lock().registered.is_some();
    let body = if active {
        format!("Press {} to talk to NOVA, or turn the dot back on in Settings → Assistant.", prefs.shortcut)
    } else {
        "Turn it back on in Settings → Assistant.".to_string()
    };
    let _ = app.notification().builder().title("NOVA dot hidden").body(body).show();
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NavigateEvent {
    route: &'static str,
    section: &'static str,
}

fn open_main<R: Runtime>(app: &AppHandle<R>, section: Option<&'static str>) {
    // The always-on-top panel would cover the window it opens; a pinned one stays on purpose.
    if !state(app).lock().prefs.panel_pinned {
        request_collapse(app);
    }
    crate::desktop::show_main_window(app);
    if let Some(section) = section {
        let _ = app.emit_to("main", EVENT_NAVIGATE, NavigateEvent { route: "settings", section });
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantStatus {
    enabled: bool,
    placement: Placement,
    corner: Corner,
    look: DotLook,
    /// The taskbar can host the dot (it doesn't hide itself).
    taskbar_available: bool,
    shortcut: String,
    background: bool,
    hide_in_fullscreen: bool,
    /// The dot sits where the user dragged it instead of in `corner`.
    custom_position: bool,
    /// Why the saved shortcut couldn't be registered at startup.
    shortcut_error: Option<String>,
    default_shortcut: &'static str,
    panel_open: bool,
    panel_pinned: bool,
}

fn status<R: Runtime>(app: &AppHandle<R>) -> AssistantStatus {
    let inner = state(app).lock();
    AssistantStatus {
        enabled: inner.prefs.enabled,
        placement: inner.prefs.placement,
        corner: inner.prefs.corner,
        look: inner.prefs.look.clone(),
        taskbar_available: find_taskbar().is_some(),
        shortcut: inner.prefs.shortcut.clone(),
        background: inner.prefs.background,
        hide_in_fullscreen: inner.prefs.hide_in_fullscreen,
        custom_position: inner.prefs.position.is_some(),
        shortcut_error: inner.shortcut_error.clone(),
        default_shortcut: DEFAULT_SHORTCUT,
        panel_open: inner.panel_open,
        panel_pinned: inner.prefs.panel_pinned,
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrefsUpdate {
    enabled: bool,
    placement: Placement,
    corner: Corner,
    look: DotLook,
    shortcut: String,
    background: bool,
    #[serde(default)]
    hide_in_fullscreen: bool,
}

#[tauri::command]
pub async fn assistant_status<R: Runtime>(app: AppHandle<R>) -> CommandResult<AssistantStatus> {
    Ok(status(&app))
}

/// Applies new preferences. A shortcut that can't be registered is rejected
/// and nothing changes; the previous shortcut stays active.
#[tauri::command]
pub async fn assistant_configure<R: Runtime>(app: AppHandle<R>, update: PrefsUpdate) -> CommandResult<AssistantStatus> {
    let shortcut_text = update.shortcut.trim().to_string();
    let shortcut = parse_shortcut(&shortcut_text)?;
    let previous = state(&app).lock().prefs.clone();

    if shortcut_text != previous.shortcut || state(&app).lock().shortcut_error.is_some() {
        if let Err(error) = register_shortcut(&app, shortcut) {
            let restored = register_shortcut(&app, parse_shortcut(&previous.shortcut).ok().flatten()).err();
            state(&app).lock().shortcut_error = restored;
            return Err(error);
        }
        state(&app).lock().shortcut_error = None;
    }

    let prefs = {
        let mut inner = state(&app).lock();
        let prefs = &mut inner.prefs;
        // Picking a place moves a dragged dot back into it.
        if update.corner != prefs.corner || update.placement != prefs.placement {
            prefs.position = None;
        }
        prefs.enabled = update.enabled;
        prefs.placement = update.placement;
        prefs.corner = update.corner;
        prefs.look = update.look.sanitized();
        prefs.shortcut = shortcut_text;
        prefs.background = update.background;
        prefs.hide_in_fullscreen = update.hide_in_fullscreen;
        prefs.clone()
    };
    save_prefs(&app, &prefs);
    apply(&app, &previous, &prefs);
    let status = status(&app);
    let _ = app.emit(EVENT_PREFS, status.clone());
    Ok(status)
}

/// Moves a dragged dot back into its corner.
#[tauri::command]
pub async fn assistant_reset_position<R: Runtime>(app: AppHandle<R>) -> CommandResult<AssistantStatus> {
    let prefs = {
        let mut inner = state(&app).lock();
        inner.prefs.position = None;
        inner.prefs.clone()
    };
    save_prefs(&app, &prefs);
    apply(&app, &prefs, &prefs);
    let status = status(&app);
    let _ = app.emit(EVENT_PREFS, status.clone());
    Ok(status)
}

/// Pins the panel where it is, or lets it be moved again.
#[tauri::command]
pub async fn assistant_panel_pin<R: Runtime>(app: AppHandle<R>, pinned: bool) -> CommandResult<AssistantStatus> {
    let prefs = {
        let mut inner = state(&app).lock();
        inner.prefs.panel_pinned = pinned;
        inner.prefs.clone()
    };
    save_prefs(&app, &prefs);
    let status = status(&app);
    let _ = app.emit(EVENT_PREFS, status.clone());
    Ok(status)
}

/// Puts the panel back beside the dot.
#[tauri::command]
pub async fn assistant_panel_unmove<R: Runtime>(app: AppHandle<R>) -> CommandResult<AssistantStatus> {
    let prefs = {
        let mut inner = state(&app).lock();
        inner.prefs.panel_position = None;
        inner.prefs.panel_pinned = false;
        inner.prefs.clone()
    };
    save_prefs(&app, &prefs);
    if let Some(panel) = app.get_webview_window(PANEL_LABEL) {
        let origin = position_panel(&app, &panel);
        state(&app).lock().panel_origin = origin;
    }
    let status = status(&app);
    let _ = app.emit(EVENT_PREFS, status.clone());
    Ok(status)
}

#[tauri::command]
pub async fn assistant_toggle<R: Runtime>(app: AppHandle<R>) -> CommandResult<()> {
    toggle(&app);
    Ok(())
}

#[tauri::command]
pub async fn assistant_collapse<R: Runtime>(app: AppHandle<R>) -> CommandResult<()> {
    request_collapse(&app);
    Ok(())
}

/// The panel finished its exit animation for `generation`.
#[tauri::command]
pub async fn assistant_panel_hidden<R: Runtime>(app: AppHandle<R>, generation: u64) -> CommandResult<()> {
    hide_panel(&app, generation);
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DotView {
    look: DotLook,
    panel_open: bool,
}

fn dot_view<R: Runtime>(app: &AppHandle<R>) -> DotView {
    let inner = state(app).lock();
    DotView { look: inner.prefs.look.clone(), panel_open: inner.panel_open }
}

/// The dot's page has loaded: show the window.
#[tauri::command]
pub async fn assistant_dot_ready<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>) -> CommandResult<DotView> {
    if window.label() != DOT_LABEL {
        return Err("only the dot window can do this".into());
    }
    // A fullscreen app in front (NOVA started with Windows or after an update): the watcher shows it later.
    let hidden = {
        let inner = state(&app).lock();
        (docked(&inner.prefs) || inner.prefs.hide_in_fullscreen) && !inner.panel_open
    } && fullscreen_in_front();
    if !hidden {
        window.show().map_err(|e| e.to_string())?;
    }
    Ok(dot_view(&app))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelView {
    open: bool,
    origin: Corner,
    wake: Option<WakeCall>,
}

/// The panel's page has loaded: show it if it was requested meanwhile.
#[tauri::command]
pub async fn assistant_panel_ready<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>) -> CommandResult<PanelView> {
    if window.label() != PANEL_LABEL {
        return Err("only the assistant panel can do this".into());
    }
    let (open, origin, wake) = {
        let mut inner = state(&app).lock();
        inner.panel_loaded = true;
        let waiting = inner.pending_wake.as_ref().is_some_and(|call| call.headless);
        let wake = if inner.panel_open || waiting { inner.pending_wake.take() } else { None };
        (inner.panel_open, inner.panel_origin, wake)
    };
    if open {
        // Closed and reopened during the first load: the page may have been marked hidden.
        crate::desktop::set_page_visible(&window, true);
        let _ = window.show();
        let _ = window.set_focus();
    } else if wake.is_some() {
        crate::desktop::set_page_visible(&window, true);
    }
    Ok(PanelView { open, origin, wake })
}

/// The dot's right-click menu. Synchronous so the menu runs on the main thread.
#[tauri::command]
pub fn assistant_dot_menu<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>) -> CommandResult<()> {
    let open = state(&app).lock().panel_open;
    let build = || -> tauri::Result<Menu<R>> {
        let talk = MenuItem::with_id(&app, MENU_TALK, if open { "Close NOVA AI" } else { "Talk to NOVA" }, true, None::<&str>)?;
        let main = MenuItem::with_id(&app, MENU_OPEN, "Open NOVA", true, None::<&str>)?;
        let settings = MenuItem::with_id(&app, MENU_SETTINGS, "Assistant settings…", true, None::<&str>)?;
        let hide = MenuItem::with_id(&app, MENU_HIDE, "Hide the dot", true, None::<&str>)?;
        let quit = MenuItem::with_id(&app, MENU_QUIT, "Quit NOVA", true, None::<&str>)?;
        let separator = PredefinedMenuItem::separator(&app)?;
        match crate::wake::listening(&app) {
            Some(on) => {
                let listen = MenuItem::with_id(&app, MENU_LISTEN, if on { "Pause listening" } else { "Resume listening" }, true, None::<&str>)?;
                Menu::with_items(&app, &[&talk, &listen, &main, &settings, &separator, &hide, &quit])
            }
            None => Menu::with_items(&app, &[&talk, &main, &settings, &separator, &hide, &quit]),
        }
    };
    let menu = build().map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn assistant_open_main<R: Runtime>(app: AppHandle<R>, section: Option<String>) -> CommandResult<()> {
    if section.as_deref() == Some("productivity") {
        open_main(&app, None);
        let _ = app.emit_to("main", EVENT_NAVIGATE, NavigateEvent { route: "productivity", section: "" });
        return Ok(());
    }
    let section = match section.as_deref() {
        None => None,
        Some("assistant") => Some("assistant"),
        Some("ai") => Some("ai"),
        Some(other) => return Err(format!("unknown settings section \"{other}\"")),
    };
    open_main(&app, section);
    Ok(())
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Appearance {
    accent: Option<Value>,
    transparency: Option<bool>,
    motion: Option<String>,
    display_name: Option<String>,
    backdrop_gradient: Option<Value>,
    ui_font: Option<String>,
}

/// The appearance subset of the persisted settings document ({ state, version }).
fn appearance_from(document: &Value) -> Appearance {
    let settings = document.get("state").unwrap_or(document);
    Appearance {
        accent: settings.get("accent").filter(|v| v.is_object()).cloned(),
        transparency: settings.get("transparency").and_then(Value::as_bool),
        motion: settings.get("motion").and_then(Value::as_str).map(|m| m.chars().take(16).collect()),
        display_name: settings.get("displayName").and_then(Value::as_str).map(|n| n.chars().take(40).collect()),
        backdrop_gradient: settings.get("backdropGradient").filter(|v| v.is_object()).cloned(),
        ui_font: settings.get("uiFont").and_then(Value::as_str).map(|f| f.chars().take(16).collect()),
    }
}

/// Accent, motion and name for the assistant windows, which don't get the
/// full settings document.
#[tauri::command]
pub async fn assistant_appearance(db: tauri::State<'_, Database>) -> CommandResult<Appearance> {
    let raw = db.with(|conn| crate::storage::kv_get(conn, SETTINGS_KEY))?;
    Ok(raw.and_then(|r| serde_json::from_str::<Value>(&r).ok()).map(|doc| appearance_from(&doc)).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HD: Screen = Screen { work: Rect { x: 0, y: 0, w: 1920, h: 1040 }, scale: 1.0 };
    /// 1366×768 laptop at 125 % with a 40 px taskbar.
    const LAPTOP: Screen = Screen { work: Rect { x: 0, y: 0, w: 1366, h: 728 }, scale: 1.25 };

    /// A 52 px glowing dot: 52 + 2×18 px room = 88 px window.
    fn big() -> DotLook {
        DotLook { diameter: 52, glow: true, edge_gap: 18, ..DotLook::default() }
    }

    #[test]
    fn corners_keep_the_dot_inside_the_work_area() {
        // Visible gap 18 px = room 18 px, so the window touches the work area's edge.
        assert_eq!(corner_position(HD, Corner::BottomRight, &big()), (1920 - 88, 1040 - 88));
        assert_eq!(corner_position(HD, Corner::TopLeft, &big()), (0, 0));
        // Default: 24 px dot + 2×8 px room = 40 px window, 12 px gap → 4 px inset.
        let look = DotLook::default();
        assert_eq!(corner_position(HD, Corner::BottomLeft, &look), (4, 1040 - 40 - 4));
        // Scaled: 40 × 1.25 = 50 px window, inset 5 px.
        assert_eq!(corner_position(LAPTOP, Corner::TopRight, &look), (1366 - 50 - 5, 5));
        let second = Screen { work: Rect { x: 1920, y: -200, w: 1280, h: 984 }, scale: 1.0 };
        assert_eq!(corner_position(second, Corner::TopLeft, &look), (1924, -196));
        // No gap: the transparent room overhangs the work area.
        let flush = DotLook { edge_gap: 0, ..DotLook::default() };
        assert_eq!(corner_position(HD, Corner::BottomRight, &flush), (1920 - 40 + 8, 1040 - 40 + 8));
    }

    #[test]
    fn dragged_dots_stay_on_screen() {
        assert_eq!(clamp_dot(HD, &big(), (500, 400)), (500, 400));
        // The room may overhang by 18 px, the dot itself may not.
        assert_eq!(clamp_dot(HD, &big(), (-60, 2000)), (-18, 1040 - 88 + 18));
    }

    #[test]
    fn the_dot_sits_in_the_taskbar_after_the_app_buttons() {
        // 1920×1080 with a 40 px taskbar; the next part starts at x = 1650.
        let bottom = Taskbar { bar: Rect { x: 0, y: 1040, w: 1920, h: 40 }, next: Rect { x: 1650, y: 1040, w: 270, h: 40 } };
        assert_eq!(taskbar_position(bottom, 40, 0), (1610, 1040));
        assert_eq!(taskbar_position(bottom, 30, 4), (1616, 1045));
        // A taskbar on the right: the tray sits at its bottom.
        let right = Taskbar { bar: Rect { x: 1860, y: 0, w: 60, h: 1080 }, next: Rect { x: 1860, y: 900, w: 60, h: 180 } };
        assert_eq!(taskbar_position(right, 40, 0), (1870, 860));
    }

    #[test]
    fn a_minimized_dot_is_not_a_drag() {
        assert!(is_parked(PhysicalPosition::new(-32000, -32000)));
        assert!(!is_parked(PhysicalPosition::new(-10, -10)));
        assert!(!is_parked(PhysicalPosition::new(1610, 1040)));
    }

    #[test]
    fn widgets_after_the_app_buttons_come_first() {
        // As measured on Windows 10: Start, search, Task View, app buttons, "News and interests", tray.
        let row = |x: i32, w: i32| Rect { x, y: 1030, w, h: 50 };
        let buttons = row(548, 750);
        let parts = [row(0, 60), row(60, 430), row(490, 60), buttons, row(1298, 250), row(1558, 362)];
        assert_eq!(first_after(buttons, &parts, true), Some(row(1298, 250)));
        // Without the widget, the tray.
        assert_eq!(first_after(buttons, &[row(0, 60), buttons, row(1558, 362), row(0, 0)], true), Some(row(1558, 362)));
        assert_eq!(first_after(buttons, &[row(0, 60)], true), None);
    }

    #[test]
    fn looks_are_kept_within_limits() {
        let wild = DotLook { diameter: 200, idle_opacity: 3, edge_gap: 99, color: "url(javascript:alert(1))".into(), ..DotLook::default() }.sanitized();
        assert_eq!((wild.diameter, wild.idle_opacity, wild.edge_gap, wild.color.as_str()), (56, 25, 48, "accent"));
        assert_eq!(DotLook { color: "#A1b2C3".into(), ..DotLook::default() }.sanitized().color, "#A1b2C3");
        assert_eq!(DotLook { color: "#12345".into(), ..DotLook::default() }.sanitized().color, "accent");
        assert_eq!(DotLook { color: "white".into(), ..DotLook::default() }.sanitized().color, "white");
    }

    #[test]
    fn finds_the_screen_under_a_point() {
        let right = Screen { work: Rect { x: 1920, y: 0, w: 1920, h: 1040 }, scale: 1.5 };
        let all = [HD, right];
        assert_eq!(nearest_screen(&all, (2500, 300)), Some(right));
        // Dropped on the taskbar below the left screen's work area.
        assert_eq!(nearest_screen(&all, (300, 1060)), Some(HD));
        assert_eq!(nearest_screen(&[], (0, 0)), None);
    }

    #[test]
    fn panel_opens_above_a_bottom_right_dot() {
        let look = big();
        let (x, y) = corner_position(HD, Corner::BottomRight, &look);
        let dot = Rect { x, y, w: 88, h: 88 };
        let placement = panel_placement(HD, dot, look.room());
        let panel = placement.window;
        assert_eq!(placement.origin, Corner::BottomRight);
        assert_eq!((panel.w, panel.h), (PANEL_WIDTH as i32 + 32, PANEL_MAX_HEIGHT as i32 + 32));
        // Visible panel: right edge flush with the dot, 18 px above the dot.
        assert_eq!(panel.right() - 16, dot.right() - 18);
        assert_eq!(panel.bottom() - 16, dot.y + 18 - 18);
        // Its shadow room never reaches the dot itself.
        assert!(panel.bottom() <= dot.y + 18);
    }

    #[test]
    fn panel_opens_below_a_top_left_dot() {
        let dot = Rect { x: 4, y: 4, w: 88, h: 88 };
        let placement = panel_placement(HD, dot, 18.0);
        assert_eq!(placement.origin, Corner::TopLeft);
        assert_eq!(placement.window.x + 16, dot.x + 18);
        assert_eq!(placement.window.y + 16, dot.bottom() - 18 + 18);
    }

    #[test]
    fn panel_opens_above_a_dot_in_the_taskbar() {
        // The dot window sits on the taskbar, below the work area.
        let dot = Rect { x: 1610, y: 1040, w: 40, h: 40 };
        let placement = panel_placement(HD, dot, DOT_ROOM);
        let panel = placement.window;
        assert_eq!(placement.origin, Corner::BottomRight);
        assert!(panel.bottom() - 16 <= HD.work.bottom() - 16, "stays inside the work area");
        assert_eq!(panel.right() - 16, dot.right() - 8);
    }

    #[test]
    fn a_dragged_panel_stays_fully_on_screen() {
        let inside = panel_at(HD, (300, 100));
        assert_eq!((inside.window.x, inside.window.y), (300, 100));
        assert_eq!(inside.origin, Corner::TopLeft);
        let over = panel_at(HD, (5000, -300));
        assert_eq!(over.window.right(), HD.work.right());
        assert_eq!(over.window.y, 0);
        assert_eq!(over.origin, Corner::TopRight);
        // On a laptop the panel is as tall as the screen allows.
        let small = panel_at(LAPTOP, (100, 900));
        assert!(small.window.y >= 0 && small.window.bottom() <= LAPTOP.work.bottom());
    }

    #[test]
    fn panel_shrinks_to_fit_small_screens() {
        let look = big();
        let (x, y) = corner_position(LAPTOP, Corner::BottomRight, &look);
        let dot = Rect { x, y, w: 110, h: 110 };
        let panel = panel_placement(LAPTOP, dot, look.room()).window;
        assert!(panel.y >= LAPTOP.work.y && panel.bottom() <= LAPTOP.work.bottom());
        assert!(panel.x >= 0 && panel.right() <= LAPTOP.work.right());
        assert!(panel.h < px(PANEL_MAX_HEIGHT + 2.0 * PANEL_PAD, 1.25));
    }

    #[test]
    fn validates_shortcuts() {
        assert!(parse_shortcut("Ctrl+Alt+Space").unwrap().is_some());
        assert!(parse_shortcut("Super+Shift+N").unwrap().is_some());
        assert_eq!(parse_shortcut("  ").unwrap(), None);
        assert!(parse_shortcut("Shift+A").is_err());
        assert!(parse_shortcut("A").is_err());
        assert!(parse_shortcut("Ctrl+Nope").is_err());
        assert!(parse_shortcut(&"Ctrl+".repeat(20)).is_err());
    }

    #[test]
    fn preferences_fill_in_defaults() {
        let prefs: AssistantPrefs = serde_json::from_str(r#"{"corner":"topLeft","position":{"x":-10,"y":20}}"#).unwrap();
        assert_eq!(prefs.corner, Corner::TopLeft);
        assert_eq!(prefs.position, Some(Point { x: -10, y: 20 }));
        assert!(prefs.enabled && !prefs.background);
        assert_eq!(prefs.shortcut, DEFAULT_SHORTCUT);
        // The 1.2 "size" setting is ignored: the new, quieter look applies.
        let old: AssistantPrefs = serde_json::from_str(r#"{"corner":"bottomRight","size":"large"}"#).unwrap();
        assert_eq!(old.look, DotLook::default());
        assert_eq!(old.placement, Placement::Taskbar);
        assert!(serde_json::from_str::<PrefsUpdate>(r#"{"enabled":true,"placement":"corner","corner":"topLeft","look":{},"shortcut":"","background":false,"position":{"x":0,"y":0}}"#).is_err());
    }

    #[test]
    fn appearance_reads_only_its_fields() {
        let doc = serde_json::json!({
            "state": { "accent": { "kind": "preset", "id": "blue" }, "motion": "reduced", "transparency": false, "displayName": "Luca", "weatherPlace": { "name": "Berlin" } },
            "version": 1
        });
        let appearance = appearance_from(&doc);
        assert_eq!(appearance.accent, Some(serde_json::json!({ "kind": "preset", "id": "blue" })));
        assert_eq!(appearance.motion.as_deref(), Some("reduced"));
        assert_eq!(appearance.transparency, Some(false));
        assert_eq!(appearance.display_name.as_deref(), Some("Luca"));
        assert_eq!(appearance_from(&serde_json::json!("garbage")), Appearance::default());
    }
}
