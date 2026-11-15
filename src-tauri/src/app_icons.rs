//! App logos for Nova Island: the player that plays on this PC, and the app that
//! posted a phone notification.
//!
//! PC: Windows names the player by its AppUserModelId. Packaged (Store) apps and
//! Win32 apps with a registered id ("SpotifyAB.SpotifyMusic_…!Spotify", "Chrome",
//! "308046B0AF4A39CB") are found in the shell's Apps folder, which reads the
//! package's AppxManifest logo for us. Plain Win32 players are reported by their
//! exe name ("Spotify.exe"); their icon comes from the running program's file.
//! Results are cached as PNG data URLs.
//!
//! Phone: the icon is untrusted data. Only small PNG or WebP pictures pass, and
//! they reach the webview only as a `data:image/png|webp;base64,` URL.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;

/// Pixels of a PC player's logo (shown at 20–36 px, sharp on high-DPI screens).
const SOURCE_ICON_PX: i32 = 64;
/// A logo that couldn't be found is looked for again after this long (the player may have just started).
const RETRY_AFTER: Duration = Duration::from_secs(30);
const MOST_CACHED: usize = 64;

/// Decoded size a phone icon may have (the phone sends 48 px, at most ~10 KB).
pub const MAX_PHONE_ICON_BYTES: usize = 12 * 1024;
/// Width and height a phone icon may have.
const MAX_PHONE_ICON_PX: u32 = 256;

type Cache = HashMap<String, (Option<String>, Instant)>;

fn cache() -> &'static Mutex<Cache> {
    static CACHE: std::sync::OnceLock<Mutex<Cache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The logo of the player Windows names `aumid`, as a PNG data URL.
pub fn source_icon(aumid: &str) -> Option<String> {
    let aumid = aumid.trim();
    if !is_safe_source_id(aumid) {
        return None;
    }
    let key = aumid.to_lowercase();
    let known = cache().lock().ok()?.get(&key).cloned();
    if let Some((url, at)) = known {
        if url.is_some() || at.elapsed() < RETRY_AFTER {
            return url;
        }
    }
    let url = resolve_source_icon(aumid);
    if let Ok(mut cached) = cache().lock() {
        if cached.len() >= MOST_CACHED {
            cached.clear();
        }
        cached.insert(key, (url.clone(), Instant::now()));
    }
    url
}

/// An id Windows could have reported: printable, no parent steps, not absurdly long.
/// It comes from the media session, but it still ends up in a shell parsing name.
pub fn is_safe_source_id(aumid: &str) -> bool {
    (1..=512).contains(&aumid.len()) && !aumid.contains("..") && !aumid.chars().any(char::is_control)
}

/// "Spotify.exe", "C:\\…\\vlc.exe", "{GUID}\\VideoLAN\\VLC\\vlc.exe" → "spotify.exe" / "vlc.exe".
pub fn exe_name(aumid: &str) -> Option<String> {
    let last = aumid.rsplit(['\\', '/']).next()?.trim().to_lowercase();
    (last.len() > 4 && last.ends_with(".exe")).then_some(last)
}

#[cfg(windows)]
fn resolve_source_icon(aumid: &str) -> Option<String> {
    use std::path::{Path, PathBuf};
    // Registered ids: Store apps (their manifest logo) and Win32 apps with an explicit id.
    if let Ok(url) = crate::shell::icon_data_url(Path::new(&format!("shell:AppsFolder\\{aumid}")), SOURCE_ICON_PX) {
        return Some(url);
    }
    let exe = exe_name(aumid)?;
    // A full path Windows reported.
    let path = PathBuf::from(aumid);
    if path.is_absolute() && path.is_file() {
        return crate::shell::icon_data_url(&path, SOURCE_ICON_PX).ok();
    }
    // Just the exe's name: the program is running (it plays), so its file is known.
    let path = running_exe(&exe)?;
    crate::shell::icon_data_url(&path, SOURCE_ICON_PX).ok()
}

#[cfg(not(windows))]
fn resolve_source_icon(_aumid: &str) -> Option<String> {
    None
}

/// The file of a running program called `exe` (lower case, with ".exe").
#[cfg(windows)]
fn running_exe(exe: &str) -> Option<std::path::PathBuf> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut system = System::new().ok()?;
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet));
    system
        .processes()
        .values()
        .filter(|p| p.name().to_string_lossy().eq_ignore_ascii_case(exe))
        .find_map(|p| p.exe().filter(|path| path.is_file()).map(|path| path.to_path_buf()))
}

/// What kind of picture `bytes` are, by their first bytes; only PNG and WebP count.
pub fn picture_kind(bytes: &[u8]) -> Option<&'static str> {
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";
    if bytes.starts_with(PNG) {
        // The first chunk must be IHDR: width and height as big-endian u32 after it.
        if bytes.len() < 24 || &bytes[12..16] != b"IHDR" {
            return None;
        }
        let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
        let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
        return ((1..=MAX_PHONE_ICON_PX).contains(&width) && (1..=MAX_PHONE_ICON_PX).contains(&height)).then_some("png");
    }
    if bytes.len() >= 16 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    None
}

/// A phone's app icon (base64 PNG or WebP) as a data URL the island may show; `None` for
/// anything else. The bytes are re-encoded, so nothing but base64 follows the prefix.
pub fn phone_icon_url(base64: &str) -> Option<String> {
    let engine = base64::engine::general_purpose::STANDARD;
    if base64.len() > MAX_PHONE_ICON_BYTES * 4 / 3 + 4 {
        return None;
    }
    let bytes = engine.decode(base64.trim()).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_PHONE_ICON_BYTES {
        return None;
    }
    let kind = picture_kind(&bytes)?;
    Some(format!("data:image/{kind};base64,{}", engine.encode(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        crate::shell::encode_png(width, height, &vec![200u8; (width * height * 4) as usize]).unwrap()
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn phone_png_icons_become_png_data_urls() {
        let icon = b64(&png(48, 48));
        assert_eq!(phone_icon_url(&icon), Some(format!("data:image/png;base64,{icon}")));
    }

    #[test]
    fn phone_webp_icons_are_named_webp() {
        let mut webp = b"RIFF\x20\x00\x00\x00WEBPVP8L".to_vec();
        webp.extend_from_slice(&[0u8; 24]);
        assert!(phone_icon_url(&b64(&webp)).unwrap().starts_with("data:image/webp;base64,"));
    }

    #[test]
    fn phone_icons_of_other_kinds_or_sizes_are_dropped() {
        // SVG could carry script; JPEG and GIF aren't what the phone sends.
        assert_eq!(phone_icon_url(&b64(b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")), None);
        assert_eq!(phone_icon_url(&b64(b"\xff\xd8\xff\xe0\x00\x10JFIF\x00")), None);
        assert_eq!(phone_icon_url(&b64(b"GIF89a\x01\x00\x01\x00")), None);
        assert_eq!(phone_icon_url("not base64 at all!"), None);
        assert_eq!(phone_icon_url(""), None);
        // A PNG header claiming a huge picture.
        assert_eq!(phone_icon_url(&b64(&png(300, 4))), None);
        // Too many bytes, even if they start like a PNG.
        let mut big = png(48, 48);
        big.resize(MAX_PHONE_ICON_BYTES + 1, 0);
        assert_eq!(phone_icon_url(&b64(&big)), None);
        // A PNG signature without IHDR.
        assert_eq!(phone_icon_url(&b64(b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIDAT\x00\x00\x00\x30\x00\x00\x00\x30")), None);
    }

    #[test]
    fn exe_names_come_from_any_form_of_id() {
        assert_eq!(exe_name("Spotify.exe").as_deref(), Some("spotify.exe"));
        assert_eq!(exe_name(r"{6D809377-6AF0-444B-8957-A3773F02200E}\VideoLAN\VLC\vlc.exe").as_deref(), Some("vlc.exe"));
        assert_eq!(exe_name(r"C:\Program Files\Foobar2000\foobar2000.EXE").as_deref(), Some("foobar2000.exe"));
        assert_eq!(exe_name("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"), None);
        assert_eq!(exe_name("Chrome"), None);
        assert_eq!(exe_name(".exe"), None);
    }

    /// Needs a real Windows desktop: `cargo test --lib app_icons -- --ignored`.
    #[test]
    #[ignore]
    #[cfg(windows)]
    fn finds_logos_of_store_apps_and_running_programs() {
        let store = source_icon("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App");
        assert!(store.as_deref().is_some_and(|url| url.starts_with("data:image/png;base64,")), "Store app");
        let running = source_icon("explorer.exe");
        assert!(running.as_deref().is_some_and(|url| url.starts_with("data:image/png;base64,")), "running exe");
        assert_eq!(source_icon("surely-not-running-nova-test.exe"), None);
    }

    #[test]
    fn odd_source_ids_are_not_looked_up() {
        assert!(is_safe_source_id("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"));
        assert!(is_safe_source_id("Spotify.exe"));
        assert!(!is_safe_source_id(""));
        assert!(!is_safe_source_id(r"..\..\Windows\System32\cmd.exe"));
        assert!(!is_safe_source_id("a\nb"));
        assert!(!is_safe_source_id(&"x".repeat(600)));
        assert_eq!(source_icon(r"..\evil.exe"), None);
    }
}
