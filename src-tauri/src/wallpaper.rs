//! Read-only access to the current desktop wallpaper for accent extraction.
//!
//! Neither command accepts a path: they can only ever read the file Windows
//! reports as the wallpaper, so this is not a general file-read channel.

use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// Wallpapers larger than this are not loaded (decoding happens in the webview).
const MAX_WALLPAPER_BYTES: u64 = 40 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperInfo {
    /// File name only; the full path is not needed by the UI.
    file_name: String,
    modified_ms: u64,
    size_bytes: u64,
}

#[cfg(windows)]
fn wallpaper_path() -> Option<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_GETDESKWALLPAPER};

    let mut buffer = [0u16; 1024];
    // SAFETY: the buffer is valid for `buffer.len()` UTF-16 units, which is the
    // size passed to the API; Windows writes a NUL-terminated path into it.
    let ok = unsafe { SystemParametersInfoW(SPI_GETDESKWALLPAPER, buffer.len() as u32, buffer.as_mut_ptr().cast(), 0) };
    if ok == 0 {
        return None;
    }
    let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    if len == 0 {
        // Solid-color background: there is no image to sample.
        return None;
    }
    let path = PathBuf::from(OsString::from_wide(&buffer[..len]));
    if path.is_file() {
        return Some(path);
    }
    // The original file was moved or deleted; Windows keeps a transcoded copy.
    let transcoded = PathBuf::from(std::env::var_os("APPDATA")?)
        .join("Microsoft")
        .join("Windows")
        .join("Themes")
        .join("TranscodedWallpaper");
    transcoded.is_file().then_some(transcoded)
}

#[cfg(not(windows))]
fn wallpaper_path() -> Option<PathBuf> {
    None
}

fn info() -> Result<Option<WallpaperInfo>, String> {
    let Some(path) = wallpaper_path() else { return Ok(None) };
    let meta = std::fs::metadata(&path).map_err(|e| format!("Unable to read wallpaper details: {e}"))?;
    Ok(Some(WallpaperInfo {
        file_name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        modified_ms: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64),
        size_bytes: meta.len(),
    }))
}

#[tauri::command]
pub async fn wallpaper_info() -> Result<Option<WallpaperInfo>, String> {
    tauri::async_runtime::spawn_blocking(info).await.map_err(|e| e.to_string())?
}

/// Raw bytes of the wallpaper image, sent over binary IPC.
#[tauri::command]
pub async fn wallpaper_image() -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(|| -> Result<Vec<u8>, String> {
        let path = wallpaper_path().ok_or("No wallpaper image is set")?;
        let len = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
        if len > MAX_WALLPAPER_BYTES {
            return Err(format!("Wallpaper is too large to analyze ({} MB)", len / 1024 / 1024));
        }
        std::fs::read(&path).map_err(|e| format!("Unable to read wallpaper: {e}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn info_is_consistent_with_the_reported_path() {
        // Environment-dependent: a solid-color desktop legitimately reports None.
        match info().unwrap() {
            Some(found) => {
                assert!(!found.file_name.is_empty());
                assert!(found.size_bytes > 0);
            }
            None => assert!(wallpaper_path().is_none()),
        }
    }
}
