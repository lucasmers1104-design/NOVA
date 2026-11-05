//! NOVA Vision's screenshots. Only taken when the user asks: the panel's
//! screen button, a confirmed `look_at_screen` request, or a spoken "look at
//! my screen". NOVA's own dot and panel are excluded from every capture, and
//! images stay in memory for the conversation only.

use std::sync::atomic::{AtomicIsize, Ordering};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

type CommandResult<T> = Result<T, String>;

/// Longest image edge sent to vision models; larger screenshots are scaled down.
pub const MAX_EDGE: u32 = 1568;

/// The window the user was in before opening NOVA AI (raw HWND, 0 = none).
static PREVIOUS_WINDOW: AtomicIsize = AtomicIsize::new(0);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    /// A display by its index in `targets().screens`.
    Screen { index: usize },
    /// The window the user was working in before opening NOVA AI.
    Window,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenInfo {
    index: usize,
    label: String,
    primary: bool,
    width: u32,
    height: u32,
    /// The screen the user's window (or the dot) is on.
    current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Targets {
    screens: Vec<ScreenInfo>,
    window: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Screenshot {
    pub label: String,
    pub png_base64: String,
    pub width: u32,
    pub height: u32,
}

/// Averages blocks of pixels so the longest edge is at most `max_edge`.
pub fn downscale(rgba: &[u8], width: u32, height: u32, max_edge: u32) -> (Vec<u8>, u32, u32) {
    let longest = width.max(height);
    if longest <= max_edge || width == 0 || height == 0 {
        return (rgba.to_vec(), width, height);
    }
    let scale = max_edge as f64 / longest as f64;
    let (dw, dh) = (((width as f64 * scale).round() as u32).max(1), ((height as f64 * scale).round() as u32).max(1));
    let mut out = vec![0u8; (dw * dh * 4) as usize];
    for dy in 0..dh {
        let y0 = (dy as u64 * height as u64 / dh as u64) as u32;
        let y1 = (((dy + 1) as u64 * height as u64 / dh as u64) as u32).max(y0 + 1).min(height);
        for dx in 0..dw {
            let x0 = (dx as u64 * width as u64 / dw as u64) as u32;
            let x1 = (((dx + 1) as u64 * width as u64 / dw as u64) as u32).max(x0 + 1).min(width);
            let mut sum = [0u32; 4];
            for y in y0..y1 {
                let row = (y * width) as usize * 4;
                for x in x0..x1 {
                    let i = row + x as usize * 4;
                    for c in 0..4 {
                        sum[c] += rgba[i + c] as u32;
                    }
                }
            }
            let n = (y1 - y0) * (x1 - x0);
            let o = ((dy * dw + dx) * 4) as usize;
            for c in 0..4 {
                out[o + c] = (sum[c] / n) as u8;
            }
        }
    }
    (out, dw, dh)
}

#[cfg(windows)]
mod win {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HDC, SRCCOPY,
    };
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible,
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    };

    pub fn hwnd(raw: isize) -> HWND {
        HWND(raw as *mut core::ffi::c_void)
    }

    /// The foreground window, unless it belongs to NOVA itself.
    pub fn foreign_foreground() -> Option<isize> {
        // SAFETY: plain queries on window handles.
        unsafe {
            let window = GetForegroundWindow();
            if window.0.is_null() {
                return None;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(window, Some(&mut pid));
            (pid != std::process::id()).then_some(window.0 as isize)
        }
    }

    pub fn window_title(raw: isize) -> Option<String> {
        let window = hwnd(raw);
        // SAFETY: the buffer outlives the call; the handle is checked first.
        unsafe {
            if !IsWindow(Some(window)).as_bool() || !IsWindowVisible(window).as_bool() {
                return None;
            }
            let mut buffer = [0u16; 256];
            let len = GetWindowTextW(window, &mut buffer);
            let title = String::from_utf16_lossy(&buffer[..len.max(0) as usize]);
            (!title.trim().is_empty()).then_some(title)
        }
    }

    pub fn window_center(raw: isize) -> Option<(i32, i32)> {
        let mut rect = RECT::default();
        // SAFETY: valid out pointer.
        unsafe { GetWindowRect(hwnd(raw), &mut rect).ok()? };
        Some(((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2))
    }

    pub fn exclude_from_capture(windows: &[isize], exclude: bool) {
        for &raw in windows {
            // SAFETY: changes only how NOVA's own windows appear in captures.
            let _ = unsafe { SetWindowDisplayAffinity(hwnd(raw), if exclude { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE }) };
        }
    }

    /// Reads a GDI bitmap as top-down BGRA.
    unsafe fn read_bitmap(dc: HDC, bitmap: windows::Win32::Graphics::Gdi::HBITMAP, width: i32, height: i32) -> Result<Vec<u8>, String> {
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (width * height * 4) as usize];
        // SAFETY: the buffer holds exactly width × height 32-bit pixels.
        let lines = unsafe { GetDIBits(dc, bitmap, 0, height as u32, Some(pixels.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS) };
        if lines != height {
            return Err("Windows didn't return the screenshot pixels".into());
        }
        Ok(pixels)
    }

    /// BGRA (alpha ignored) → opaque RGBA.
    fn to_rgba(mut bgra: Vec<u8>) -> Vec<u8> {
        for px in bgra.as_chunks_mut::<4>().0 {
            px.swap(0, 2);
            px[3] = 255;
        }
        bgra
    }

    /// Copies a rectangle of the desktop (physical pixels).
    pub fn capture_rect(x: i32, y: i32, width: i32, height: i32) -> Result<Vec<u8>, String> {
        if width <= 0 || height <= 0 {
            return Err("That display has no size".into());
        }
        // SAFETY: every GDI object created here is released before returning.
        unsafe {
            let screen = GetDC(None);
            let memory = CreateCompatibleDC(Some(screen));
            let bitmap = CreateCompatibleBitmap(screen, width, height);
            let previous = SelectObject(memory, bitmap.into());
            let copied = BitBlt(memory, 0, 0, width, height, Some(screen), x, y, SRCCOPY | CAPTUREBLT);
            let pixels = copied.map_err(|e| format!("Couldn't copy the screen: {e}")).and_then(|_| read_bitmap(memory, bitmap, width, height));
            SelectObject(memory, previous);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(memory);
            ReleaseDC(None, screen);
            pixels.map(to_rgba)
        }
    }

    /// Renders one window, even if it's partly covered (not when minimized).
    pub fn capture_window(raw: isize) -> Result<(Vec<u8>, u32, u32), String> {
        let window = hwnd(raw);
        // SAFETY: GDI objects are released before returning; out pointers are valid.
        unsafe {
            if !IsWindow(Some(window)).as_bool() {
                return Err("That window was closed".into());
            }
            if IsIconic(window).as_bool() {
                return Err("That window is minimized. Restore it and try again.".into());
            }
            let mut outer = RECT::default();
            GetWindowRect(window, &mut outer).map_err(|e| e.to_string())?;
            // The visible frame, without the invisible resize borders.
            let mut frame = outer;
            let _ = DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, (&mut frame as *mut RECT).cast(), size_of::<RECT>() as u32);
            let (width, height) = (outer.right - outer.left, outer.bottom - outer.top);
            if width <= 0 || height <= 0 {
                return Err("That window has no size".into());
            }
            let screen = GetDC(None);
            let memory = CreateCompatibleDC(Some(screen));
            let bitmap = CreateCompatibleBitmap(screen, width, height);
            let previous = SelectObject(memory, bitmap.into());
            // PW_RENDERFULLCONTENT: includes DirectComposition content such as browsers.
            let printed = PrintWindow(window, memory, PRINT_WINDOW_FLAGS(2)).as_bool();
            let pixels = if printed { read_bitmap(memory, bitmap, width, height) } else { Err("Windows couldn't render that window".into()) };
            SelectObject(memory, previous);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(memory);
            ReleaseDC(None, screen);
            let pixels = to_rgba(pixels?);
            // Crop to the visible frame.
            let (cx, cy) = ((frame.left - outer.left).max(0), (frame.top - outer.top).max(0));
            let (cw, ch) = ((frame.right - frame.left).clamp(1, width - cx), (frame.bottom - frame.top).clamp(1, height - cy));
            let mut cropped = Vec::with_capacity((cw * ch * 4) as usize);
            for row in cy..cy + ch {
                let start = ((row * width + cx) * 4) as usize;
                cropped.extend_from_slice(&pixels[start..start + (cw * 4) as usize]);
            }
            Ok((cropped, cw as u32, ch as u32))
        }
    }
}

/// Remembers the last window of another app that had focus, so "this window"
/// means the one the user was in, even after clicking the dot. Event-driven
/// (no polling); must be called on a thread with a message loop (setup).
#[cfg(windows)]
pub fn watch_foreground() {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, EVENT_SYSTEM_FOREGROUND, WINEVENT_OUTOFCONTEXT};

    unsafe extern "system" fn on_foreground(_: HWINEVENTHOOK, _: u32, window: HWND, _: i32, _: i32, _: u32, _: u32) {
        if window.0.is_null() {
            return;
        }
        crate::assistant::on_foreground(window.0 as isize);
        let mut pid = 0u32;
        // SAFETY: queries the owner of a window handle Windows just reported.
        unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
        if pid != std::process::id() {
            PREVIOUS_WINDOW.store(window.0 as isize, Ordering::SeqCst);
        }
    }

    if let Some(window) = win::foreign_foreground() {
        PREVIOUS_WINDOW.store(window, Ordering::SeqCst);
    }
    // SAFETY: an out-of-context hook with a plain callback; it lives for the app's lifetime.
    unsafe {
        SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, None, Some(on_foreground), 0, 0, WINEVENT_OUTOFCONTEXT);
    }
}

#[cfg(not(windows))]
pub fn watch_foreground() {}

fn previous_window() -> Option<isize> {
    let raw = PREVIOUS_WINDOW.load(Ordering::SeqCst);
    (raw != 0).then_some(raw)
}

#[derive(Clone, Copy)]
struct Display {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    primary: bool,
}

fn displays<R: Runtime>(app: &AppHandle<R>) -> Vec<Display> {
    let primary = app.primary_monitor().ok().flatten().map(|m| *m.position());
    app.available_monitors()
        .map(|monitors| {
            monitors
                .iter()
                .map(|m| Display {
                    x: m.position().x,
                    y: m.position().y,
                    width: m.size().width,
                    height: m.size().height,
                    primary: primary == Some(*m.position()),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The display showing the user's previous window, else the dot, else the primary display.
fn current_display<R: Runtime>(app: &AppHandle<R>, all: &[Display]) -> usize {
    let point = {
        #[cfg(windows)]
        {
            previous_window().and_then(win::window_center)
        }
        #[cfg(not(windows))]
        {
            None
        }
    }
    .or_else(|| {
        let dot = app.get_webview_window(crate::assistant::DOT_LABEL)?;
        let (pos, size) = (dot.outer_position().ok()?, dot.outer_size().ok()?);
        Some((pos.x + size.width as i32 / 2, pos.y + size.height as i32 / 2))
    });
    point
        .and_then(|(x, y)| all.iter().position(|d| x >= d.x && x < d.x + d.width as i32 && y >= d.y && y < d.y + d.height as i32))
        .or_else(|| all.iter().position(|d| d.primary))
        .unwrap_or(0)
}

pub fn targets<R: Runtime>(app: &AppHandle<R>) -> Targets {
    let all = displays(app);
    let current = current_display(app, &all);
    let screens = all
        .iter()
        .enumerate()
        .map(|(index, d)| ScreenInfo {
            index,
            label: if all.len() == 1 { "Your screen".into() } else { format!("Display {}{}", index + 1, if d.primary { " (main)" } else { "" }) },
            primary: d.primary,
            width: d.width,
            height: d.height,
            current: index == current,
        })
        .collect();
    #[cfg(windows)]
    let window = previous_window().and_then(win::window_title);
    #[cfg(not(windows))]
    let window = None;
    Targets { screens, window }
}

/// The screen the user is looking at.
pub fn current_target<R: Runtime>(app: &AppHandle<R>) -> Target {
    let all = displays(app);
    Target::Screen { index: current_display(app, &all) }
}

fn own_windows<R: Runtime>(app: &AppHandle<R>) -> Vec<isize> {
    [crate::assistant::DOT_LABEL, crate::assistant::PANEL_LABEL]
        .iter()
        .filter_map(|label| app.get_webview_window(label))
        .filter_map(|w| w.hwnd().ok())
        .map(|h| h.0 as isize)
        .collect()
}

/// Takes the screenshot. Blocking (a few hundred milliseconds); call off the UI thread.
#[cfg(windows)]
pub fn capture<R: Runtime>(app: &AppHandle<R>, target: &Target) -> CommandResult<Screenshot> {
    let (rgba, width, height, label) = match target {
        Target::Screen { index } => {
            let all = displays(app);
            let display = *all.get(*index).ok_or("That display isn't connected anymore")?;
            let own = own_windows(app);
            win::exclude_from_capture(&own, true);
            let pixels = win::capture_rect(display.x, display.y, display.width as i32, display.height as i32);
            win::exclude_from_capture(&own, false);
            let label = if all.len() == 1 { "Your screen".to_string() } else { format!("Display {}", index + 1) };
            (pixels?, display.width, display.height, label)
        }
        Target::Window => {
            let raw = previous_window().ok_or("NOVA doesn't know which window you were using. Click it and open NOVA AI again.")?;
            let title = win::window_title(raw).unwrap_or_else(|| "Window".into());
            let (pixels, width, height) = win::capture_window(raw)?;
            (pixels, width, height, title)
        }
    };
    let (scaled, w, h) = downscale(&rgba, width, height, MAX_EDGE);
    let png = crate::shell::encode_png(w, h, &scaled)?;
    Ok(Screenshot { label, png_base64: base64::engine::general_purpose::STANDARD.encode(png), width: w, height: h })
}

#[cfg(not(windows))]
pub fn capture<R: Runtime>(_app: &AppHandle<R>, _target: &Target) -> CommandResult<Screenshot> {
    Err("Screenshots require Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downscales_to_the_longest_edge_by_averaging() {
        // 4×2 image: left half black, right half white.
        let mut rgba = Vec::new();
        for _ in 0..2 {
            for x in 0..4 {
                let v = if x < 2 { 0 } else { 255 };
                rgba.extend_from_slice(&[v, v, v, 255]);
            }
        }
        let (out, w, h) = downscale(&rgba, 4, 2, 2);
        assert_eq!((w, h), (2, 1));
        assert_eq!(&out[..4], &[0, 0, 0, 255]);
        assert_eq!(&out[4..8], &[255, 255, 255, 255]);
        let (same, w, h) = downscale(&rgba, 4, 2, 10);
        assert_eq!((w, h), (4, 2));
        assert_eq!(same, rgba);
    }

    #[test]
    fn keeps_aspect_ratio_of_wide_screens() {
        let rgba = vec![128u8; 3840 * 2160 * 4];
        let (out, w, h) = downscale(&rgba, 3840, 2160, MAX_EDGE);
        assert_eq!((w, h), (1568, 882));
        assert_eq!(out.len(), (w * h * 4) as usize);
        assert!(out.iter().all(|&v| v == 128));
    }

    #[test]
    fn targets_serialize_with_a_kind_tag() {
        assert_eq!(serde_json::to_value(Target::Screen { index: 1 }).unwrap(), serde_json::json!({ "kind": "screen", "index": 1 }));
        assert_eq!(serde_json::from_value::<Target>(serde_json::json!({ "kind": "window" })).unwrap(), Target::Window);
    }
}
