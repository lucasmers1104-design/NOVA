//! The user's own background picture. It lives in NOVA's data folder rather
//! than in the settings, which are small and get saved often.

use std::path::{Path, PathBuf};

use base64::Engine;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

type CommandResult<T> = Result<T, String>;

const LARGEST: u64 = 25 * 1024 * 1024;
const KINDS: &[(&str, &str)] = &[("png", "image/png"), ("jpg", "image/jpeg"), ("jpeg", "image/jpeg"), ("webp", "image/webp"), ("gif", "image/gif")];

fn folder<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map(|dir| dir.join("backgrounds")).map_err(|e| format!("No local data folder: {e}"))
}

fn media_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_string_lossy().to_lowercase();
    KINDS.iter().find(|(kind, _)| *kind == extension).map(|(_, media)| *media)
}

/// The picture NOVA has, if any.
fn current(dir: &Path) -> Option<PathBuf> {
    KINDS.iter().map(|(kind, _)| dir.join(format!("custom.{kind}"))).find(|file| file.is_file())
}

/// Copies `source` in as the one background picture.
fn adopt(source: &Path, dir: &Path) -> Result<(), String> {
    if media_type(source).is_none() {
        return Err("Pick a PNG, JPG, WebP or GIF picture".into());
    }
    if std::fs::metadata(source).map_err(|e| e.to_string())?.len() > LARGEST {
        return Err("The picture can be up to 25 MB".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    while let Some(old) = current(dir) {
        std::fs::remove_file(old).map_err(|e| e.to_string())?;
    }
    let extension = source.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    std::fs::copy(source, dir.join(format!("custom.{extension}"))).map(|_| ()).map_err(|e| format!("Couldn't copy the picture: {e}"))
}

/// Lets the user pick a picture. Returns a new token for the settings, or None if they cancelled.
#[tauri::command]
pub async fn backdrop_image_pick<R: Runtime>(app: AppHandle<R>) -> CommandResult<Option<String>> {
    let picked = app.dialog().file().set_title("Choose a background picture").add_filter("Pictures", &["png", "jpg", "jpeg", "webp", "gif"]).blocking_pick_file();
    let Some(path) = picked.map(|p| p.into_path()).transpose().map_err(|e| e.to_string())? else { return Ok(None) };
    adopt(&path, &folder(&app)?)?;
    Ok(Some(crate::storage::now_millis().to_string()))
}

/// The picture as a data URL for the page; None if it is gone.
#[tauri::command]
pub async fn backdrop_image_load<R: Runtime>(app: AppHandle<R>) -> CommandResult<Option<String>> {
    let dir = folder(&app)?;
    let Some(file) = current(&dir) else { return Ok(None) };
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    let media = media_type(&file).unwrap_or("image/png");
    Ok(Some(format!("data:{media};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_one_picture_of_an_allowed_kind() {
        let dir = std::env::temp_dir().join(format!("nova-backdrop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = dir.join("store");
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["a.PNG", "b.jpg", "c.exe"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        assert!(adopt(&dir.join("c.exe"), &store).is_err());
        assert_eq!(current(&store), None);
        adopt(&dir.join("a.PNG"), &store).unwrap();
        assert_eq!(current(&store), Some(store.join("custom.png")));
        adopt(&dir.join("b.jpg"), &store).unwrap();
        assert_eq!(current(&store), Some(store.join("custom.jpg")));
        assert!(!store.join("custom.png").exists());
        assert_eq!(media_type(&store.join("custom.jpg")), Some("image/jpeg"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
