//! Nova Island (1.12): a small, growing pill at the top of the screen for music, the
//! phone's notifications and calls, NOVA AI and, if wanted, the PC's load.
//! See docs/island/PLAN.md.
//!
//! The window has one fixed size, room for the largest pill at the largest size setting,
//! and never moves while the pill grows or shrinks inside it (resizing and moving a
//! window mid-animation made the pill jump for a frame). A change of look (Island
//! Studio) therefore never touches the window either; only the anchor, the offset and
//! the monitor move it. It ignores the mouse except while the pointer is over the
//! pill (`watch_pointer`), so the transparent rest never swallows clicks meant for the
//! desktop below. The page reports the pill's size with `island_resize`. Rust places
//! the window at the top of the chosen monitor's work area, from that monitor's scale.
//!
//! SECURITY: the island page gets media, system and its own commands only. What the
//! phone forwards (notifications, calls) is shown and forgotten; with "hide previews"
//! the text is removed here, before it reaches any webview.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::assistant::{Rect, Screen};
use crate::companion::protocol::{self, CallAction, CallState, PcMessage};
use crate::storage::Database;

mod prefs;
pub use prefs::{IslandAnchor, IslandMode, IslandPrefs, PreviewScene};

type CommandResult<T> = Result<T, String>;

pub const ISLAND_LABEL: &str = "island";
const PREFS_KEY: &str = "nova.island";
const EVENT_PREFS: &str = "island://prefs";
const EVENT_PHONE: &str = "island://phone";
const EVENT_LEVEL: &str = "island://level";
/// → island: the pointer entered (`true`) or left the pill. The page can't tell by
/// itself: while the pointer is elsewhere, the window doesn't get mouse events at all.
const EVENT_HOVER: &str = "island://hover";
/// → island: play this scene from Island Studio for a moment (`null` ends it).
const EVENT_PREVIEW: &str = "island://preview";
/// How often the pointer is compared with the pill (a cheap cursor query).
const POINTER_TICK: Duration = Duration::from_millis(50);
/// Transparent room around the pill for its shadow (logical px). The panel opens below it.
pub const PAD: f64 = 10.0;
/// Gap between the pill and the top of the work area (logical px).
const TOP_GAP: f64 = 6.0;
/// Gap to the screen's side for the left and right anchors (logical px).
const SIDE_GAP: f64 = 24.0;
/// What the page may ask for (logical px, pill only, before the size setting). The
/// largest is `MAX_PILL` in src/features/island/priority.ts.
const MIN_W: f64 = 40.0;
const MAX_W: f64 = 460.0;
const MIN_H: f64 = 22.0;
const MAX_H: f64 = 320.0;
/// The audio meter's pace: smooth enough for bars, cheap enough to forget.
const METER_TICK: Duration = Duration::from_millis(70);

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

pub fn load_prefs(db: &Database) -> IslandPrefs {
    db.with(|conn| crate::storage::kv_get(conn, PREFS_KEY))
        .ok()
        .flatten()
        .and_then(|raw| prefs::parse(&raw))
        .unwrap_or_default()
}

fn save_prefs<R: Runtime>(app: &AppHandle<R>, prefs: &IslandPrefs) -> CommandResult<()> {
    let json = serde_json::to_string(prefs).map_err(|e| e.to_string())?;
    app.state::<Database>().with(|conn| crate::storage::kv_set(conn, PREFS_KEY, &json))
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// A call the island shows; `device_id` stays here and never reaches the page.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneCallView {
    pub call_id: String,
    pub state: CallState,
    pub name: Option<String>,
    pub number: Option<String>,
    pub photo: Option<String>,
    pub can_answer: bool,
    pub can_decline: bool,
    #[serde(skip)]
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneNotice {
    pub notif_id: String,
    pub app: String,
    pub app_name: String,
    pub title: String,
    pub text: String,
    /// From the phone: base64 PNG/WebP. To the island: a `data:image/png|webp;base64,` URL, or `None`.
    pub icon: Option<String>,
    pub posted: u64,
}

#[derive(Default)]
struct Inner {
    prefs: IslandPrefs,
    /// Pill size the page asked for (logical px, before the size setting).
    size: (f64, f64),
    /// Where NOVA last put the window; a move to anywhere else came from Windows.
    placed_at: Option<PhysicalPosition<i32>>,
    /// The window's rectangle and its monitor's scale, as NOVA placed it.
    window: Option<(Rect, f64)>,
    /// Calls ringing or running on a phone.
    calls: Vec<PhoneCallView>,
    loaded: bool,
}

#[derive(Default)]
pub struct IslandState {
    inner: Mutex<Inner>,
    creating: AtomicBool,
    watching_fullscreen: AtomicBool,
    hidden_for_fullscreen: AtomicBool,
    meter_on: AtomicBool,
    meter_running: AtomicBool,
    watching_pointer: AtomicBool,
}

impl IslandState {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn state<R: Runtime>(app: &AppHandle<R>) -> &IslandState {
    app.state::<IslandState>().inner()
}

pub fn prefs<R: Runtime>(app: &AppHandle<R>) -> IslandPrefs {
    state(app).lock().prefs.clone()
}

pub fn enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    state(app).lock().prefs.enabled
}

/// "Island only": the dot's own window stays away and the island carries the dot.
pub fn replaces_dot<R: Runtime>(app: &AppHandle<R>) -> bool {
    let inner = state(app).lock();
    inner.prefs.enabled && inner.prefs.mode == IslandMode::IslandOnly
}

/// Where the panel should open from while the island carries the dot: the pill with
/// `PAD` of room around it, as the panel's placement expects from the dot's window.
pub fn dot_anchor<R: Runtime>(app: &AppHandle<R>) -> Option<(Screen, Rect)> {
    if !replaces_dot(app) || app.get_webview_window(ISLAND_LABEL).is_none() {
        return None;
    }
    let pill = pill_now(app)?;
    let scale = state(app).lock().window?.1;
    let room = px(PAD, scale);
    let rect = Rect { x: pill.x - room, y: pill.y - room, w: pill.w + 2 * room, h: pill.h + 2 * room };
    let screen = crate::assistant::nearest_screen(&crate::assistant::all_screens(app), (rect.x + rect.w / 2, rect.y + rect.h / 2))?;
    Some((screen, rect))
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

fn px(logical: f64, scale: f64) -> i32 {
    (logical * scale).round() as i32
}

/// The monitor the island belongs on: the chosen one while it is connected, else the primary one.
fn target_screen<R: Runtime>(app: &AppHandle<R>, prefs: &IslandPrefs) -> Option<Screen> {
    let monitors = app.available_monitors().ok()?;
    let chosen = prefs.monitor.as_deref().and_then(|name| monitors.iter().find(|m| m.name().is_some_and(|n| n == name)));
    let monitor = match chosen {
        Some(monitor) => Some(monitor.clone()),
        None => app.primary_monitor().ok().flatten().or_else(|| monitors.first().cloned()),
    }?;
    Some(crate::assistant::screen_of(&monitor))
}

/// Room for the largest pill at the largest size setting (logical px, pill only).
fn window_size() -> (f64, f64) {
    let most = f64::from(prefs::SCALE_MAX) / 100.0;
    (MAX_W * most, MAX_H * most)
}

/// The window's rectangle for a pill of `size` (logical px) on `screen`, shifted by
/// `offset` (logical px) from its anchor as far as the screen has room.
pub fn island_rect(screen: Screen, anchor: IslandAnchor, offset: i32, (w, h): (f64, f64)) -> Rect {
    let s = screen.scale;
    let work = screen.work;
    let (width, height) = (px(w + 2.0 * PAD, s).min(work.w), px(h + 2.0 * PAD, s).min(work.h));
    let anchored = match anchor {
        IslandAnchor::Center => work.x + (work.w - width) / 2,
        IslandAnchor::Left => work.x + px(SIDE_GAP - PAD, s).max(0),
        IslandAnchor::Right => work.x + work.w - width - px(SIDE_GAP - PAD, s).max(0),
    };
    // Never off the monitor it belongs to, however far the offset asks.
    let x = (anchored + px(f64::from(offset), s)).clamp(work.x, work.x + work.w - width);
    let y = work.y + px((TOP_GAP - PAD).max(0.0), s);
    Rect { x, y, w: width, h: height }
}

/// The pill's rectangle inside the window (physical px): `PAD` from the top, and
/// centered or at the anchor's side, like `.island-stage` in island.css.
pub fn pill_in(window: Rect, dpi: f64, anchor: IslandAnchor, (w, h): (f64, f64)) -> Rect {
    let (pad, width, height) = (px(PAD, dpi), px(w, dpi).min(window.w), px(h, dpi).min(window.h));
    let x = match anchor {
        IslandAnchor::Center => window.x + (window.w - width) / 2,
        IslandAnchor::Left => window.x + pad,
        IslandAnchor::Right => window.x + window.w - pad - width,
    };
    Rect { x, y: window.y + pad, w: width, h: height }
}

/// The pill on screen right now, from the size the page last reported.
fn pill_now<R: Runtime>(app: &AppHandle<R>) -> Option<Rect> {
    let inner = state(app).lock();
    let (window, dpi) = inner.window?;
    let scale = inner.prefs.scale();
    Some(pill_in(window, dpi, inner.prefs.anchor, (inner.size.0 * scale, inner.size.1 * scale)))
}

/// Room for the largest pill; the window keeps this size whatever the pill does.
fn place<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    let prefs = state(app).lock().prefs.clone();
    let Some(screen) = target_screen(app, &prefs) else { return };
    let rect = island_rect(screen, prefs.anchor, prefs.offset, window_size());
    let pos = PhysicalPosition::new(rect.x, rect.y);
    // Nothing to do while it already sits there: most changes from Island Studio are
    // looks, and those must not touch the window at all.
    if state(app).lock().window == Some((rect, screen.scale)) && window.outer_position().is_ok_and(|at| at == pos) {
        return;
    }
    {
        let mut inner = state(app).lock();
        inner.placed_at = Some(pos);
        inner.window = Some((rect, screen.scale));
    }
    // Moving first lets a DPI change between monitors happen before sizing; then pin the position again.
    let _ = window.set_position(pos);
    let _ = window.set_size(PhysicalSize::new(rect.w as u32, rect.h as u32));
    let _ = window.set_position(pos);
}

/// Windows moved the island (a monitor went away, the resolution changed): put it back.
pub fn on_moved<R: Runtime>(app: &AppHandle<R>, pos: PhysicalPosition<i32>) {
    let placed = state(app).lock().placed_at;
    if placed.is_some_and(|p| (p.x - pos.x).abs() <= 2 && (p.y - pos.y).abs() <= 2) {
        return;
    }
    if let Some(window) = app.get_webview_window(ISLAND_LABEL) {
        place(app, &window);
    }
}

/// The scale changed (moved between monitors, display settings): size it for the new scale.
pub fn on_rescaled<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    // Not inside the event handler: resizing there can re-enter it.
    std::thread::spawn(move || {
        if let Some(window) = app.get_webview_window(ISLAND_LABEL) {
            place(&app, &window);
        }
    });
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/// Created hidden; its page shows it with `island_ready`. Must not run on the main
/// thread's event handlers (WebView2 deadlocks there).
fn create<R: Runtime>(app: &AppHandle<R>) {
    if app.get_webview_window(ISLAND_LABEL).is_some() || state(app).creating.swap(true, Ordering::SeqCst) {
        return;
    }
    {
        let mut inner = state(app).lock();
        inner.size = (200.0, 36.0);
        inner.loaded = false;
        inner.window = None;
    }
    let (width, height) = window_size();
    let built = WebviewWindowBuilder::new(app, ISLAND_LABEL, WebviewUrl::App("island.html".into()))
        .title("Nova Island")
        .inner_size(width + 2.0 * PAD, height + 2.0 * PAD)
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
        .build();
    state(app).creating.store(false, Ordering::SeqCst);
    match built {
        Ok(window) => {
            crate::assistant::disable_animations(&window);
            // Clicks go through until the pointer is over the pill.
            let _ = window.set_ignore_cursor_events(true);
            place(app, &window);
            watch_pointer(app);
        }
        Err(error) => eprintln!("[NOVA] Nova Island unavailable: {error}"),
    }
}

fn destroy<R: Runtime>(app: &AppHandle<R>) {
    state(app).meter_on.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(ISLAND_LABEL) {
        let _ = window.destroy();
    }
}

/// Startup, after the assistant: the island's preferences were set before the dot was made.
pub fn init<R: Runtime>(app: &AppHandle<R>, prefs: IslandPrefs) {
    state(app).lock().prefs = prefs;
}

pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let prefs = prefs(app);
    if prefs.enabled {
        create(app);
        if prefs.hide_in_fullscreen {
            watch_fullscreen(app);
        }
    }
}

/// Brings the window in line with changed preferences, and the dot with the mode.
fn apply<R: Runtime>(app: &AppHandle<R>, previous: &IslandPrefs, prefs: &IslandPrefs) {
    if prefs.enabled {
        match app.get_webview_window(ISLAND_LABEL) {
            Some(window) => place(app, &window),
            None => create(app),
        }
        if prefs.hide_in_fullscreen {
            watch_fullscreen(app);
        } else if state(app).hidden_for_fullscreen.swap(false, Ordering::SeqCst) {
            show(app);
        }
    } else {
        destroy(app);
    }
    let _ = app.emit_to(ISLAND_LABEL, EVENT_PREFS, prefs.clone());
    let replaced = |p: &IslandPrefs| p.enabled && p.mode == IslandMode::IslandOnly;
    if replaced(previous) != replaced(prefs) {
        crate::assistant::refresh_dot(app);
    }
}

fn show<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(ISLAND_LABEL) {
        let _ = window.show();
        crate::desktop::set_page_visible(&window, true);
    }
}

fn hide<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(ISLAND_LABEL) {
        let _ = window.hide();
        crate::desktop::set_page_visible(&window, false);
    }
}

fn ringing<R: Runtime>(app: &AppHandle<R>) -> bool {
    state(app).lock().calls.iter().any(|c| c.state == CallState::Ringing)
}

/// While "hide in fullscreen" is on, checks every two seconds (a cheap shell query).
/// A ringing call shows the island anyway. Stops when the option or the island is off.
fn watch_fullscreen<R: Runtime>(app: &AppHandle<R>) {
    let island = state(app);
    if island.watching_fullscreen.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            let (enabled, loaded) = {
                let inner = self::state(&app).lock();
                (inner.prefs.enabled && inner.prefs.hide_in_fullscreen, inner.loaded)
            };
            if !enabled {
                break;
            }
            let hide_now = loaded && !ringing(&app) && crate::assistant::fullscreen_in_front();
            let hidden = self::state(&app).hidden_for_fullscreen.load(Ordering::SeqCst);
            if loaded && hide_now != hidden {
                self::state(&app).hidden_for_fullscreen.store(hide_now, Ordering::SeqCst);
                if hide_now {
                    hide(&app);
                } else {
                    show(&app);
                }
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        let island = self::state(&app);
        island.watching_fullscreen.store(false, Ordering::SeqCst);
        if island.hidden_for_fullscreen.swap(false, Ordering::SeqCst) && island.lock().prefs.enabled {
            show(&app);
        }
    });
}

#[cfg(windows)]
fn cursor() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut point = POINT::default();
    // SAFETY: writes the cursor position into a valid POINT.
    unsafe { GetCursorPos(&mut point) }.ok()?;
    Some((point.x, point.y))
}

#[cfg(not(windows))]
fn cursor() -> Option<(i32, i32)> {
    None
}

fn contains(rect: Rect, (x, y): (i32, i32)) -> bool {
    x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h
}

/// While the island exists: lets the mouse through everywhere but the pill, and tells
/// the page when the pointer comes and goes. Stops with the window.
fn watch_pointer<R: Runtime>(app: &AppHandle<R>) {
    if state(app).watching_pointer.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut inside = None;
        while let Some(window) = app.get_webview_window(ISLAND_LABEL) {
            let now = match (pill_now(&app), cursor()) {
                (Some(pill), Some(point)) => contains(pill, point),
                _ => false,
            };
            if inside != Some(now) {
                let _ = window.set_ignore_cursor_events(!now);
                let _ = app.emit_to(ISLAND_LABEL, EVENT_HOVER, now);
                inside = Some(now);
            }
            std::thread::sleep(POINTER_TICK);
        }
        state(&app).watching_pointer.store(false, Ordering::SeqCst);
    });
}

// ---------------------------------------------------------------------------
// The output's level, for the music visualizer
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn output_meter() -> CommandResult<windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation> {
    use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
    // SAFETY: called with COM initialized; interfaces are reference counted by the bindings.
    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).map_err(|_| "No audio output device".to_string())?;
        device.Activate(CLSCTX_ALL, None).map_err(|e| e.to_string())
    }
}

/// Sends the default output's peak level (0–1) to the island while the page wants it.
/// Windows' own meter: no audio is captured, recorded or analysed.
#[cfg(windows)]
fn run_meter<R: Runtime>(app: AppHandle<R>) {
    let island = state(&app);
    if island.meter_running.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let _ = crate::shell::with_com(false, || {
            let mut meter = None;
            let mut ticks = 0u32;
            while state(&app).meter_on.load(Ordering::SeqCst) && app.get_webview_window(ISLAND_LABEL).is_some() {
                // Again now and then: the default output may have changed.
                if meter.is_none() || ticks % 80 == 0 {
                    meter = output_meter().ok();
                }
                ticks = ticks.wrapping_add(1);
                // SAFETY: a valid interface from above.
                let level = meter.as_ref().and_then(|m| unsafe { m.GetPeakValue() }.ok()).unwrap_or(0.0);
                let _ = app.emit_to(ISLAND_LABEL, EVENT_LEVEL, level.clamp(0.0, 1.0));
                std::thread::sleep(METER_TICK);
            }
            Ok(())
        });
        state(&app).meter_running.store(false, Ordering::SeqCst);
    });
}

#[cfg(not(windows))]
fn run_meter<R: Runtime>(_app: AppHandle<R>) {}

// ---------------------------------------------------------------------------
// From the phone (companion/tasks.rs)
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum PhoneEvent {
    Notification(PhoneNotice),
    Call(PhoneCallView),
}

pub fn phone_notification<R: Runtime>(app: &AppHandle<R>, _device_id: &str, mut notice: PhoneNotice) {
    let prefs = prefs(app);
    if !prefs.enabled || !prefs.modules.notifications {
        return;
    }
    // SECURITY: with hidden previews the text never reaches a webview.
    if prefs.hide_previews {
        notice.title.clear();
        notice.text.clear();
    }
    // SECURITY: the icon is the phone's data. Only a small PNG or WebP passes, as a data URL.
    notice.icon = notice.icon.as_deref().and_then(crate::app_icons::phone_icon_url);
    let _ = app.emit_to(ISLAND_LABEL, EVENT_PHONE, PhoneEvent::Notification(notice));
}

pub fn phone_call<R: Runtime>(app: &AppHandle<R>, device_id: &str, mut call: PhoneCallView) {
    let prefs = prefs(app);
    if !prefs.enabled || !prefs.modules.calls {
        return;
    }
    call.device_id = device_id.to_string();
    if !prefs.show_caller_number {
        call.number = None;
    }
    {
        let mut inner = state(app).lock();
        inner.calls.retain(|c| c.call_id != call.call_id);
        if call.state != CallState::Ended {
            inner.calls.push(call.clone());
        }
        // A phone that went away mustn't leave a call ringing forever.
        inner.calls.truncate(4);
    }
    // A ringing call shows over a fullscreen app.
    if call.state == CallState::Ringing && state(app).hidden_for_fullscreen.load(Ordering::SeqCst) {
        state(app).hidden_for_fullscreen.store(false, Ordering::SeqCst);
        show(app);
    }
    let _ = app.emit_to(ISLAND_LABEL, EVENT_PHONE, PhoneEvent::Call(call));
}

/// Takes a phone's calls out of the list and returns them as ended.
fn end_calls_of(calls: &mut Vec<PhoneCallView>, device_id: &str) -> Vec<PhoneCallView> {
    let (mut gone, kept): (Vec<_>, Vec<_>) = std::mem::take(calls).into_iter().partition(|call| call.device_id == device_id);
    *calls = kept;
    for call in &mut gone {
        call.state = CallState::Ended;
    }
    gone
}

/// A phone's last connection closed. Its calls can neither be answered nor seen ending
/// any more, so the island lets go of them instead of ringing for a phone that is gone.
/// The phone reports its calls again when it reconnects.
pub fn phone_gone<R: Runtime>(app: &AppHandle<R>, device_id: &str) {
    let ended = end_calls_of(&mut state(app).lock().calls, device_id);
    for call in ended {
        let _ = app.emit_to(ISLAND_LABEL, EVENT_PHONE, PhoneEvent::Call(call));
    }
}

// ---------------------------------------------------------------------------
// Commands for the island window
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandView {
    prefs: IslandPrefs,
    calls: Vec<PhoneCallView>,
}

fn only_island<R: Runtime>(window: &WebviewWindow<R>) -> CommandResult<()> {
    if window.label() == ISLAND_LABEL { Ok(()) } else { Err("only Nova Island can do this".into()) }
}

/// The island's page has loaded: show it (unless a fullscreen app is in front).
#[tauri::command]
pub async fn island_ready<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>) -> CommandResult<IslandView> {
    only_island(&window)?;
    let (prefs, calls) = {
        let mut inner = state(&app).lock();
        inner.loaded = true;
        (inner.prefs.clone(), inner.calls.clone())
    };
    place(&app, &window);
    if prefs.hide_in_fullscreen && crate::assistant::fullscreen_in_front() {
        state(&app).hidden_for_fullscreen.store(true, Ordering::SeqCst);
    } else {
        window.show().map_err(|e| e.to_string())?;
    }
    Ok(IslandView { prefs, calls })
}

/// The pill's new size (logical px, before the size setting): the window follows.
#[tauri::command]
pub async fn island_resize<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, width: f64, height: f64) -> CommandResult<()> {
    only_island(&window)?;
    if !width.is_finite() || !height.is_finite() {
        return Err("invalid size".into());
    }
    // Only the pill changes; the window stays where it is (see the module comment).
    state(&app).lock().size = (width.clamp(MIN_W, MAX_W), height.clamp(MIN_H, MAX_H));
    Ok(())
}

/// The music visualizer is on screen (`true`) or not.
#[tauri::command]
pub async fn island_meter<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, on: bool) -> CommandResult<()> {
    only_island(&window)?;
    state(&app).meter_on.store(on, Ordering::SeqCst);
    if on {
        run_meter(app);
    }
    Ok(())
}

/// Answer or decline a call on the phone it rings on.
/// SECURITY: only for a call that phone reported, and only what it said it can do.
#[tauri::command]
pub async fn island_call_action<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>, call_id: String, action: CallAction) -> CommandResult<()> {
    only_island(&window)?;
    // These three reach the island's page as they are, so they are in the user's language.
    let call = state(&app).lock().calls.iter().find(|c| c.call_id == call_id).cloned().ok_or("Der Anruf ist schon vorbei")?;
    let allowed = match action {
        CallAction::Accept => call.can_answer && call.state == CallState::Ringing,
        CallAction::Decline => call.can_decline,
    };
    if !allowed {
        return Err("Das kann dein Handy bei diesem Anruf nicht".into());
    }
    let message = PcMessage::CallAction { id: protocol::new_id(), ts: protocol::now(), call_id, action };
    if crate::companion::send_to(&app, &call.device_id, message) {
        Ok(())
    } else {
        Err("Dein Handy ist gerade nicht verbunden".into())
    }
}

/// The island's microphone: NOVA listens, as after "Hey NOVA".
#[tauri::command]
pub async fn island_listen<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>) -> CommandResult<()> {
    only_island(&window)?;
    crate::assistant::wake(&app, crate::wake::Source::Phrase, true, true, None);
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands for Settings → Nova Island (main window)
// ---------------------------------------------------------------------------

/// A connected display, for Island Studio's little map of them.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    name: String,
    primary: bool,
    /// Position and size on the virtual desktop (physical px).
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IslandStatus {
    prefs: IslandPrefs,
    /// Connected monitors, the primary one first.
    monitors: Vec<MonitorInfo>,
    /// The island window exists and its page has loaded.
    running: bool,
}

fn status<R: Runtime>(app: &AppHandle<R>) -> IslandStatus {
    let primary = app.primary_monitor().ok().flatten().and_then(|m| m.name().cloned());
    let mut monitors: Vec<MonitorInfo> = app
        .available_monitors()
        .map(|all| {
            all.iter()
                .filter_map(|m| {
                    let name = m.name()?.clone();
                    Some(MonitorInfo { primary: Some(&name) == primary.as_ref(), name, x: m.position().x, y: m.position().y, width: m.size().width, height: m.size().height })
                })
                .collect()
        })
        .unwrap_or_default();
    monitors.sort_by_key(|monitor| !monitor.primary);
    let inner = state(app).lock();
    IslandStatus { prefs: inner.prefs.clone(), monitors, running: inner.loaded && app.get_webview_window(ISLAND_LABEL).is_some() }
}

#[tauri::command]
pub async fn island_status<R: Runtime>(app: AppHandle<R>) -> CommandResult<IslandStatus> {
    Ok(status(&app))
}

#[tauri::command]
pub async fn island_configure<R: Runtime>(app: AppHandle<R>, prefs: IslandPrefs) -> CommandResult<IslandStatus> {
    let prefs = prefs.sanitized();
    save_prefs(&app, &prefs)?;
    let previous = std::mem::replace(&mut state(&app).lock().prefs, prefs.clone());
    // Windows are made off the async runtime's worker, like the assistant's.
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || apply(&handle, &previous, &prefs)).await.map_err(|e| e.to_string())?;
    Ok(status(&app))
}

/// Island Studio's "show on the desktop": the real island plays a scene for a moment.
/// The page ends it by itself after ten seconds, so a Studio that never says `None`
/// (closed, crashed) can't leave a made-up call on the screen.
#[tauri::command]
pub async fn island_preview<R: Runtime>(app: AppHandle<R>, scene: Option<PreviewScene>) -> CommandResult<()> {
    if app.get_webview_window(ISLAND_LABEL).is_none() || !state(&app).lock().loaded {
        // Ending a preview on an island that is gone is fine; starting one isn't possible.
        return if scene.is_none() { Ok(()) } else { Err("Nova Island ist ausgeschaltet".into()) };
    }
    app.emit_to(ISLAND_LABEL, EVENT_PREVIEW, scene).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HD: Screen = Screen { work: Rect { x: 0, y: 0, w: 1920, h: 1040 }, scale: 1.0 };
    /// A second monitor left of the primary one, at 150 %.
    const LEFT_4K: Screen = Screen { work: Rect { x: -3840, y: 0, w: 3840, h: 2100 }, scale: 1.5 };

    #[test]
    fn the_island_sits_centered_at_the_top() {
        let rect = island_rect(HD, IslandAnchor::Center, 0, (200.0, 36.0));
        assert_eq!((rect.w, rect.h), (220, 56));
        assert_eq!(rect.x, (1920 - 220) / 2);
        assert_eq!(rect.y, 0);
    }

    #[test]
    fn it_follows_the_monitor_and_its_scale() {
        let rect = island_rect(LEFT_4K, IslandAnchor::Center, 0, (200.0, 36.0));
        assert_eq!((rect.w, rect.h), (330, 84));
        assert_eq!(rect.x, -3840 + (3840 - 330) / 2);
        let right = island_rect(LEFT_4K, IslandAnchor::Right, 0, (200.0, 36.0));
        assert_eq!(right.x + right.w, -px(SIDE_GAP - PAD, 1.5));
        let left = island_rect(LEFT_4K, IslandAnchor::Left, 0, (200.0, 36.0));
        assert_eq!(left.x, -3840 + px(SIDE_GAP - PAD, 1.5));
    }

    #[test]
    fn an_offset_shifts_it_along_the_top_but_never_off_its_monitor() {
        let centered = island_rect(HD, IslandAnchor::Center, 0, (200.0, 36.0));
        assert_eq!(island_rect(HD, IslandAnchor::Center, 120, (200.0, 36.0)).x, centered.x + 120);
        assert_eq!(island_rect(HD, IslandAnchor::Center, -120, (200.0, 36.0)).x, centered.x - 120);
        // The offset is in logical px, like everything the page knows.
        let scaled = island_rect(LEFT_4K, IslandAnchor::Center, 0, (200.0, 36.0));
        assert_eq!(island_rect(LEFT_4K, IslandAnchor::Center, 100, (200.0, 36.0)).x, scaled.x + 150);
        // However far it asks, the window stays on the monitor it belongs to.
        let far_right = island_rect(HD, IslandAnchor::Right, 600, (200.0, 36.0));
        assert_eq!(far_right.x + far_right.w, 1920);
        assert_eq!(island_rect(LEFT_4K, IslandAnchor::Left, -600, (200.0, 36.0)).x, -3840);
        assert_eq!(island_rect(LEFT_4K, IslandAnchor::Center, 5000, (200.0, 36.0)).x + 330, 0);
        assert_eq!(island_rect(HD, IslandAnchor::Center, 60, (200.0, 36.0)).y, centered.y);
    }

    #[test]
    fn the_window_has_room_for_the_largest_pill_at_the_largest_size() {
        let (width, height) = window_size();
        let most = f64::from(prefs::SCALE_MAX) / 100.0;
        assert!(width >= MAX_W * most && height >= MAX_H * most);
        // A change of size setting leaves the window alone: the pill only takes more of it.
        let window = island_rect(HD, IslandAnchor::Center, 0, window_size());
        let small = pill_in(window, 1.0, IslandAnchor::Center, (MAX_W * 0.8, MAX_H * 0.8));
        let large = pill_in(window, 1.0, IslandAnchor::Center, (MAX_W * most, MAX_H * most));
        assert!(large.w > small.w && large.x >= window.x && large.x + large.w <= window.x + window.w && large.y + large.h <= window.y + window.h);
    }

    #[test]
    fn the_pill_sits_in_the_window_like_the_page_draws_it() {
        let window = island_rect(HD, IslandAnchor::Center, 0, (MAX_W, MAX_H));
        let pill = pill_in(window, 1.0, IslandAnchor::Center, (200.0, 36.0));
        assert_eq!((pill.w, pill.h, pill.y), (200, 36, window.y + 10));
        assert_eq!(pill.x + pill.w / 2, window.x + window.w / 2);
        let left = pill_in(window, 1.5, IslandAnchor::Left, (200.0, 36.0));
        assert_eq!((left.x, left.w), (window.x + 15, 300));
        let right = pill_in(window, 1.0, IslandAnchor::Right, (200.0, 36.0));
        assert_eq!(right.x + right.w, window.x + window.w - 10);
        assert!(contains(pill, (pill.x, pill.y)) && !contains(pill, (pill.x + pill.w, pill.y)));
    }

    #[test]
    fn a_phone_that_is_gone_takes_its_calls_along() {
        let call = |id: &str, device: &str| PhoneCallView { call_id: id.into(), state: CallState::Ringing, name: None, number: None, photo: None, can_answer: true, can_decline: true, device_id: device.into() };
        let mut calls = vec![call("a", "pixel"), call("b", "tablet"), call("c", "pixel")];
        let ended = end_calls_of(&mut calls, "pixel");
        assert_eq!(ended.iter().map(|c| c.call_id.as_str()).collect::<Vec<_>>(), ["a", "c"]);
        assert!(ended.iter().all(|c| c.state == CallState::Ended));
        assert_eq!(calls.iter().map(|c| c.call_id.as_str()).collect::<Vec<_>>(), ["b"]);
        assert!(end_calls_of(&mut calls, "pixel").is_empty());
    }

    #[test]
    fn it_never_grows_past_the_screen() {
        let tiny = Screen { work: Rect { x: 0, y: 0, w: 300, h: 200 }, scale: 1.0 };
        let rect = island_rect(tiny, IslandAnchor::Center, 400, window_size());
        assert!(rect.w <= 300 && rect.h <= 200 && rect.x >= 0 && rect.x + rect.w <= 300);
    }
}
