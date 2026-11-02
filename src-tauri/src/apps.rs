//! Application discovery and launching.
//!
//! Apps come from Start menu shortcuts (all users + current user) and from
//! shortcuts the user added explicitly. Launch requests carry only an app id;
//! the path is resolved here, so the webview can never launch arbitrary paths.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use crate::shell;
use crate::storage::{self, Database};

type CommandResult<T> = Result<T, String>;

const MAX_DEPTH: usize = 4;
/// Shortcuts that are clearly not apps (uninstallers, manuals, websites).
const NOISE: &[&str] = &[
    "uninstall", "deinstall", "readme", "read me", "release notes", "documentation", "license", "website", "what's new",
    "help", "support", "manual", "changelog",
];
pub const LAUNCHABLE_EXTENSIONS: &[&str] = &["exe", "lnk", "url", "appref-ms", "msc"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    pub id: String,
    pub name: String,
    pub category: String,
    pub source: &'static str,
}

/// Scanned entries plus id → launch path.
type Catalog = (Vec<AppEntry>, HashMap<String, PathBuf>);

#[derive(Default)]
pub struct AppCatalog {
    scanned: Mutex<Option<Catalog>>,
}

/// Stable 64-bit FNV-1a hash, used to derive ids that survive restarts.
pub fn stable_id(prefix: &str, value: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in value.to_lowercase().bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{prefix}-{hash:016x}")
}

fn is_noise(name: &str) -> bool {
    let lower = name.to_lowercase();
    NOISE.iter().any(|n| lower.contains(n))
}

pub fn has_launchable_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| LAUNCHABLE_EXTENSIONS.iter().any(|allowed| ext.eq_ignore_ascii_case(allowed)))
}

fn start_menu_roots() -> Vec<PathBuf> {
    let programs = |base: Option<std::ffi::OsString>| {
        base.map(|b| PathBuf::from(b).join("Microsoft").join("Windows").join("Start Menu").join("Programs"))
    };
    [programs(std::env::var_os("APPDATA")), programs(std::env::var_os("ProgramData"))]
        .into_iter()
        .flatten()
        .filter(|p| p.is_dir())
        .collect()
}

fn scan_dir(root: &Path, dir: &Path, depth: usize, out: &mut Vec<(AppEntry, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth < MAX_DEPTH {
                scan_dir(root, &path, depth + 1, out);
            }
            continue;
        }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
        if !matches!(ext.as_str(), "lnk" | "url" | "appref-ms") {
            continue;
        }
        let Some(name) = path.file_stem().map(|s| s.to_string_lossy().trim().to_string()) else { continue };
        if name.is_empty() || is_noise(&name) {
            continue;
        }
        let category = path
            .parent()
            .and_then(|parent| parent.strip_prefix(root).ok())
            .and_then(|rel| rel.components().next())
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .unwrap_or_else(|| "Apps".to_string());
        let id = stable_id("sm", &path.to_string_lossy());
        out.push((AppEntry { id, name, category, source: "start-menu" }, path));
    }
}

pub fn scan_start_menu() -> Catalog {
    let mut found = Vec::new();
    for root in start_menu_roots() {
        scan_dir(&root, &root, 0, &mut found);
    }
    // The same app often has a shortcut in both roots; keep one per name.
    let mut seen = std::collections::HashSet::new();
    found.retain(|(entry, _)| seen.insert(entry.name.to_lowercase()));
    found.sort_by_key(|(entry, _)| entry.name.to_lowercase());
    let paths = found.iter().map(|(e, p)| (e.id.clone(), p.clone())).collect();
    (found.into_iter().map(|(e, _)| e).collect(), paths)
}

impl AppCatalog {
    pub(crate) fn scanned(&self, refresh: bool) -> CommandResult<Catalog> {
        let mut guard = self.scanned.lock().map_err(|_| "app catalog lock poisoned".to_string())?;
        if refresh || guard.is_none() {
            *guard = Some(scan_start_menu());
        }
        Ok(guard.clone().unwrap_or_default())
    }

    pub(crate) fn resolve(&self, db: &Database, id: &str) -> CommandResult<PathBuf> {
        if let Some(path) = self.scanned(false)?.1.get(id) {
            return Ok(path.clone());
        }
        let shortcut = db.with(|conn| storage::shortcuts::get(conn, id))?.ok_or_else(|| "Unknown app".to_string())?;
        Ok(PathBuf::from(shortcut.path))
    }
}

#[tauri::command]
pub async fn apps_list(
    catalog: tauri::State<'_, AppCatalog>,
    db: tauri::State<'_, Database>,
    refresh: bool,
) -> CommandResult<Vec<AppEntry>> {
    // A Start menu scan reads a few hundred directory entries (milliseconds);
    // async commands already run off the UI thread.
    let (mut apps, _) = catalog.scanned(refresh)?;
    // Custom shortcuts are listed even if storage is degraded for scanning.
    if let Ok(custom) = db.with(storage::shortcuts::list) {
        apps.extend(custom.into_iter().map(|s| AppEntry { id: s.id, name: s.name, category: "Custom".into(), source: "custom" }));
    }
    Ok(apps)
}

#[tauri::command]
pub async fn app_icon(
    catalog: tauri::State<'_, AppCatalog>,
    db: tauri::State<'_, Database>,
    id: String,
) -> CommandResult<Option<String>> {
    let path = catalog.resolve(&db, &id)?;
    let result = tauri::async_runtime::spawn_blocking(move || shell::icon_data_url(&path, 48)).await.map_err(|e| e.to_string())?;
    // A missing icon is not an error for the UI; it falls back to a monogram.
    Ok(result.ok())
}

#[tauri::command]
pub async fn app_launch(catalog: tauri::State<'_, AppCatalog>, db: tauri::State<'_, Database>, id: String) -> CommandResult<()> {
    let path = catalog.resolve(&db, &id)?;
    tauri::async_runtime::spawn_blocking(move || shell::open_path(&path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn app_shortcut_add(db: tauri::State<'_, Database>, name: String, path: String) -> CommandResult<AppEntry> {
    let path_buf = PathBuf::from(&path);
    if !path_buf.is_file() {
        return Err("The selected file does not exist".into());
    }
    if !has_launchable_extension(&path_buf) {
        return Err(format!("Only {} files can be added as apps", LAUNCHABLE_EXTENSIONS.join(", ")));
    }
    let name = if name.trim().is_empty() {
        path_buf.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "App".into())
    } else {
        name
    };
    let shortcut = db.with(|conn| storage::shortcuts::insert(conn, &name, &path))?;
    Ok(AppEntry { id: shortcut.id, name: shortcut.name, category: "Custom".into(), source: "custom" })
}

#[tauri::command]
pub async fn app_shortcut_remove(db: tauri::State<'_, Database>, id: String) -> CommandResult<()> {
    db.with(|conn| storage::shortcuts::delete(conn, &id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_stable_and_case_insensitive() {
        assert_eq!(stable_id("sm", "C:\\A\\b.lnk"), stable_id("sm", "c:\\a\\B.LNK"));
        assert_ne!(stable_id("sm", "a"), stable_id("sm", "b"));
    }

    #[test]
    fn filters_non_app_shortcuts() {
        assert!(is_noise("Uninstall Foo"));
        assert!(is_noise("Foo Website"));
        assert!(!is_noise("Visual Studio Code"));
    }

    #[test]
    fn only_launchable_extensions_are_accepted() {
        assert!(has_launchable_extension(Path::new("C:\\x\\app.EXE")));
        assert!(has_launchable_extension(Path::new("C:\\x\\app.lnk")));
        assert!(!has_launchable_extension(Path::new("C:\\x\\script.bat")));
        assert!(!has_launchable_extension(Path::new("C:\\x\\script.ps1")));
        assert!(!has_launchable_extension(Path::new("C:\\x\\noext")));
    }

    #[test]
    fn scan_finds_unique_named_apps() {
        let (apps, paths) = scan_start_menu();
        let mut names: Vec<_> = apps.iter().map(|a| a.name.to_lowercase()).collect();
        let total = names.len();
        names.dedup();
        assert_eq!(names.len(), total, "duplicate names");
        assert!(apps.iter().all(|a| paths.contains_key(&a.id)));
    }
}
