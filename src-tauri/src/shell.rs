//! Thin wrappers over Windows shell APIs: opening items with their default
//! handler, revealing them in Explorer, and rendering their icons.
//!
//! Callers are responsible for only passing paths that came from a trusted
//! source (scanned Start menu entries, files the user picked or listed).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The same place again this soon is the same request: Explorer stays as it is.
const SAME_PLACE: Duration = Duration::from_secs(5);
/// Explorer windows NOVA opens within `WINDOW_SPAN`; whatever is asking for more
/// has gone wrong, and nobody can close a hundred windows.
const MOST_WINDOWS: usize = 6;
const WINDOW_SPAN: Duration = Duration::from_secs(30);

#[derive(Debug, PartialEq)]
enum Explorer {
    Open,
    AlreadyOpen,
    TooMany,
}

/// What this request for an Explorer window should do, given the recent ones.
fn explorer_request(recent: &mut Vec<(Instant, PathBuf)>, now: Instant, path: &Path) -> Explorer {
    recent.retain(|(at, _)| now.duration_since(*at) < WINDOW_SPAN);
    if recent.iter().any(|(at, place)| place == path && now.duration_since(*at) < SAME_PLACE) {
        return Explorer::AlreadyOpen;
    }
    if recent.len() >= MOST_WINDOWS {
        return Explorer::TooMany;
    }
    recent.push((now, path.to_path_buf()));
    Explorer::Open
}

/// False when the window shouldn't open (it just did); an error when too many did.
/// Every way NOVA opens Explorer goes through here.
fn explorer_allowed(path: &Path) -> Result<bool, String> {
    static RECENT: Mutex<Vec<(Instant, PathBuf)>> = Mutex::new(Vec::new());
    match explorer_request(&mut RECENT.lock().unwrap_or_else(|p| p.into_inner()), Instant::now(), path) {
        Explorer::Open => Ok(true),
        Explorer::AlreadyOpen => Ok(false),
        Explorer::TooMany => Err("File Explorer was opened several times just now, so NOVA isn't opening more windows".into()),
    }
}

/// A folder, or a shortcut to Explorer itself.
fn opens_explorer(path: &Path) -> bool {
    path.is_dir() || path.file_stem().is_some_and(|name| name.to_string_lossy().to_lowercase().contains("explorer"))
}

/// Runs `f` with COM initialized on the current (blocking-pool) thread.
#[cfg(windows)]
pub fn with_com<T>(apartment_threaded: bool, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_MULTITHREADED};
    // SAFETY: balanced with CoUninitialize below whenever initialization succeeded
    // (including S_FALSE, "already initialized on this thread").
    let hr = unsafe { CoInitializeEx(None, if apartment_threaded { COINIT_APARTMENTTHREADED } else { COINIT_MULTITHREADED }) };
    let result = f();
    if hr.is_ok() {
        unsafe { CoUninitialize() };
    }
    result
}

/// Opens a file, folder, shortcut or app with its registered handler.
#[cfg(windows)]
pub fn open_path(path: &Path) -> Result<(), String> {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    if !path.exists() {
        return Err(format!("{} no longer exists", path.display()));
    }
    if opens_explorer(path) && !explorer_allowed(path)? {
        return Ok(());
    }
    with_com(true, || {
        let target = HSTRING::from(path.as_os_str());
        // SAFETY: all string arguments are valid NUL-terminated wide strings for the call's duration.
        let result = unsafe { ShellExecuteW(None, w!("open"), &target, PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
        let code = result.0 as isize;
        if code > 32 {
            Ok(())
        } else {
            Err(format!("Windows could not open “{}” (error {code})", path.display()))
        }
    })
}

/// Opens an already validated http(s) URL in the default browser.
#[cfg(windows)]
pub fn open_url(url: &str) -> Result<(), String> {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only web links can be opened".into());
    }
    with_com(true, || {
        // SAFETY: valid NUL-terminated wide strings for the duration of the call.
        let result = unsafe { ShellExecuteW(None, w!("open"), &HSTRING::from(url), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
        if result.0 as isize > 32 {
            Ok(())
        } else {
            Err("Windows could not open the link".into())
        }
    })
}

#[cfg(not(windows))]
pub fn open_url(_url: &str) -> Result<(), String> {
    Err("Opening links requires Windows".into())
}

/// Opens one of Windows' own pages by its fixed link (never one that came from outside).
#[cfg(windows)]
pub fn open_system_link(link: &'static str) -> Result<(), String> {
    run_program(link, "")
}

#[cfg(not(windows))]
pub fn open_system_link(_link: &'static str) -> Result<(), String> {
    Err("This requires Windows".into())
}

/// Starts a program the way Explorer would, so one that needs administrator
/// rights gets Windows' prompt. Doesn't wait for it.
#[cfg(windows)]
pub fn run_program(program: &str, arguments: &str) -> Result<(), String> {
    use windows::core::{w, HSTRING};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    with_com(true, || {
        // SAFETY: valid NUL-terminated wide strings for the duration of the call.
        let result = unsafe { ShellExecuteW(None, w!("open"), &HSTRING::from(program), &HSTRING::from(arguments), None, SW_SHOWNORMAL) };
        if result.0 as isize > 32 {
            Ok(())
        } else {
            Err(format!("Windows couldn't start it (error {})", result.0 as isize))
        }
    })
}

#[cfg(not(windows))]
pub fn run_program(_program: &str, _arguments: &str) -> Result<(), String> {
    Err("This requires Windows".into())
}

/// Percent-encodes a search so it stays one harmless part of a link.
pub fn encode_query(query: &str) -> String {
    url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>().replace('+', "%20")
}

/// Opens Spotify's search in the app, or on the web when the app isn't installed.
/// Returns whether the app took it.
#[cfg(windows)]
pub fn open_spotify_search(query: &str) -> Result<bool, String> {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let encoded = encode_query(query);
    let link = format!("spotify:search:{encoded}");
    let opened = with_com(true, || {
        // SAFETY: valid NUL-terminated wide strings for the duration of the call.
        let result = unsafe { ShellExecuteW(None, w!("open"), &HSTRING::from(link.as_str()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
        Ok(result.0 as isize > 32)
    })?;
    if !opened {
        open_url(&format!("https://open.spotify.com/search/{encoded}"))?;
    }
    Ok(opened)
}

#[cfg(not(windows))]
pub fn open_spotify_search(_query: &str) -> Result<bool, String> {
    Err("Opening Spotify requires Windows".into())
}

/// Opens Explorer with the item selected.
#[cfg(windows)]
pub fn reveal_path(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("{} no longer exists", path.display()));
    }
    if !explorer_allowed(path)? {
        return Ok(());
    }
    // Explorer is invoked directly (no shell), with the path as a single argument.
    std::process::Command::new("explorer.exe")
        .arg(format!("/select,{}", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open Explorer: {e}"))
}

/// Renders the shell icon of any file system item as a PNG data URL.
#[cfg(windows)]
pub fn icon_data_url(path: &Path, size: i32) -> Result<String, String> {
    use base64::Engine;
    use windows::core::HSTRING;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::DeleteObject;
    use windows::Win32::UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_ICONONLY};

    let (width, height, rgba) = with_com(true, || {
        // SAFETY: COM is initialized; the HBITMAP returned by GetImage is owned by us and deleted below.
        unsafe {
            let factory: IShellItemImageFactory =
                SHCreateItemFromParsingName(&HSTRING::from(path.as_os_str()), None).map_err(|e| e.message().to_string())?;
            let bitmap = factory
                .GetImage(SIZE { cx: size, cy: size }, SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK)
                .map_err(|e| e.message().to_string())?;
            let pixels = read_bitmap(bitmap);
            let _ = DeleteObject(bitmap.into());
            pixels
        }
    })?;
    let png = encode_png(width, height, &rgba)?;
    Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
}

/// Copies a 32-bit HBITMAP into straight-alpha RGBA bytes.
#[cfg(windows)]
unsafe fn read_bitmap(bitmap: windows::Win32::Graphics::Gdi::HBITMAP) -> Result<(u32, u32, Vec<u8>), String> {
    use std::ffi::c_void;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };

    let mut info_bitmap = BITMAP::default();
    let read = GetObjectW(bitmap.into(), size_of::<BITMAP>() as i32, Some(&mut info_bitmap as *mut BITMAP as *mut c_void));
    if read == 0 {
        return Err("Could not read icon bitmap".into());
    }
    let width = info_bitmap.bmWidth;
    let height = info_bitmap.bmHeight.abs();
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height, // top-down rows
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut pixels = vec![0u8; (width * height * 4) as usize];
    let dc = CreateCompatibleDC(None);
    let lines = GetDIBits(dc, bitmap, 0, height as u32, Some(pixels.as_mut_ptr() as *mut c_void), &mut info, DIB_RGB_COLORS);
    let _ = DeleteDC(dc);
    if lines == 0 {
        return Err("Could not copy icon pixels".into());
    }
    bgra_premultiplied_to_rgba(&mut pixels);
    Ok((width as u32, height as u32, pixels))
}

/// Converts premultiplied BGRA to straight RGBA in place. Legacy icons
/// without an alpha channel (all alpha bytes zero) are treated as opaque.
pub fn bgra_premultiplied_to_rgba(pixels: &mut [u8]) {
    let has_alpha = pixels.as_chunks::<4>().0.iter().any(|px| px[3] != 0);
    for px in pixels.as_chunks_mut::<4>().0 {
        let (b, g, r) = (px[0] as u32, px[1] as u32, px[2] as u32);
        let a = if has_alpha { px[3] as u32 } else { 255 };
        let unpremultiply = |c: u32| if a == 0 || a == 255 { c } else { ((c * 255 + a / 2) / a).min(255) };
        px[0] = unpremultiply(r) as u8;
        px[1] = unpremultiply(g) as u8;
        px[2] = unpremultiply(b) as u8;
        px[3] = a as u8;
    }
}

pub fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

#[cfg(not(windows))]
pub fn open_path(_path: &Path) -> Result<(), String> {
    Err("Opening items requires Windows".into())
}

#[cfg(not(windows))]
pub fn reveal_path(_path: &Path) -> Result<(), String> {
    Err("Revealing items requires Windows".into())
}

#[cfg(not(windows))]
pub fn icon_data_url(_path: &Path, _size: i32) -> Result<String, String> {
    Err("Icons require Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explorer_opens_once_per_place_and_only_so_often() {
        let start = Instant::now();
        let mut recent = Vec::new();
        let place = Path::new(r"C:\Users\me\Downloads");
        // The same request a hundred times in a row: one window.
        assert_eq!(explorer_request(&mut recent, start, place), Explorer::Open);
        for _ in 0..100 {
            assert_eq!(explorer_request(&mut recent, start, place), Explorer::AlreadyOpen);
        }
        // Asked for again later, it opens.
        let later = start + SAME_PLACE + Duration::from_millis(1);
        assert_eq!(explorer_request(&mut recent, later, place), Explorer::Open);
        // Different places, too many at once.
        for i in 2..MOST_WINDOWS {
            assert_eq!(explorer_request(&mut recent, later, Path::new(&format!(r"C:\{i}"))), Explorer::Open);
        }
        assert_eq!(explorer_request(&mut recent, later, Path::new(r"C:\one-more")), Explorer::TooMany);
        // And it recovers.
        assert_eq!(explorer_request(&mut recent, later + WINDOW_SPAN, Path::new(r"C:\one-more")), Explorer::Open);
    }

    #[test]
    fn knows_what_opens_explorer() {
        let dir = std::env::temp_dir();
        assert!(opens_explorer(&dir));
        assert!(opens_explorer(Path::new(r"C:\ProgramData\Start Menu\File Explorer.lnk")));
        assert!(!opens_explorer(Path::new(r"C:\Users\me\notes.txt")));
    }

    #[test]
    fn converts_premultiplied_bgra() {
        // Half-transparent pure red (premultiplied: r = 128) and an opaque blue pixel.
        let mut pixels = vec![0, 0, 128, 128, 255, 0, 0, 255];
        bgra_premultiplied_to_rgba(&mut pixels);
        assert_eq!(&pixels[..4], &[255, 0, 0, 128]);
        assert_eq!(&pixels[4..], &[0, 0, 255, 255]);
    }

    #[test]
    fn legacy_icons_without_alpha_become_opaque() {
        let mut pixels = vec![10, 20, 30, 0, 40, 50, 60, 0];
        bgra_premultiplied_to_rgba(&mut pixels);
        assert_eq!(pixels, vec![30, 20, 10, 255, 60, 50, 40, 255]);
    }

    #[test]
    fn encodes_valid_png() {
        let png = encode_png(2, 1, &[255, 0, 0, 255, 0, 255, 0, 255]).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }

    #[cfg(windows)]
    #[test]
    fn renders_icons_for_system_files() {
        let notepad = std::path::PathBuf::from(std::env::var("WINDIR").unwrap()).join("notepad.exe");
        let url = icon_data_url(&notepad, 48).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
    }
}
