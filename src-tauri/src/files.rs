//! File Hub: standard folders, user favorites, recent items and search.
//!
//! Access is scoped: listing, searching and opening only work inside the
//! standard user folders, folders the user added as favorites, or the Windows
//! "Recent" list. There are no write, move or delete operations.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::shell;
use crate::storage::Database;

type CommandResult<T> = Result<T, String>;

const MAX_LIST: usize = 500;
const MAX_RESULTS: usize = 100;
const MAX_VISITED_DIRS: usize = 4000;
const MAX_DEPTH: usize = 6;
pub(crate) const SKIPPED_DIRS: &[&str] = &["node_modules", ".git", "$recycle.bin", "appdata", "target", ".cache"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownFolder {
    pub(crate) id: &'static str,
    pub(crate) name: &'static str,
    pub(crate) path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) is_dir: bool,
    pub(crate) size: u64,
    pub(crate) modified_ms: u64,
}

#[derive(Debug, Deserialize)]
struct FilePreferences {
    #[serde(default)]
    favorites: Vec<FavoriteFolder>,
}

#[derive(Debug, Deserialize)]
struct FavoriteFolder {
    path: String,
}

#[cfg(windows)]
pub fn known_folders() -> Vec<KnownFolder> {
    use windows::core::GUID;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{
        FOLDERID_Desktop, FOLDERID_Documents, FOLDERID_Downloads, FOLDERID_Music, FOLDERID_Pictures, FOLDERID_Videos,
        SHGetKnownFolderPath, KNOWN_FOLDER_FLAG,
    };
    let folders: [(&'static str, &'static str, GUID); 6] = [
        ("desktop", "Desktop", FOLDERID_Desktop),
        ("documents", "Documents", FOLDERID_Documents),
        ("downloads", "Downloads", FOLDERID_Downloads),
        ("pictures", "Pictures", FOLDERID_Pictures),
        ("music", "Music", FOLDERID_Music),
        ("videos", "Videos", FOLDERID_Videos),
    ];
    folders
        .into_iter()
        .filter_map(|(id, name, guid)| {
            // SAFETY: the returned buffer is freed with CoTaskMemFree as documented.
            unsafe {
                let raw = SHGetKnownFolderPath(&guid, KNOWN_FOLDER_FLAG(0), None).ok()?;
                let path = raw.to_string().ok();
                CoTaskMemFree(Some(raw.0 as *const core::ffi::c_void));
                path.map(|path| KnownFolder { id, name, path })
            }
        })
        .filter(|f| Path::new(&f.path).is_dir())
        .collect()
}

#[cfg(not(windows))]
pub fn known_folders() -> Vec<KnownFolder> {
    Vec::new()
}

fn recent_dir() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("APPDATA")?).join("Microsoft").join("Windows").join("Recent"))
}

fn favorites(db: &Database) -> Vec<PathBuf> {
    db.with(|conn| crate::storage::kv_get(conn, "nova.files"))
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<FilePreferences>(&raw).ok())
        .map(|prefs| prefs.favorites.into_iter().map(|f| PathBuf::from(f.path)).filter(|p| p.is_dir() && !crate::agent::tools::is_system_place(&p.canonicalize().unwrap_or_else(|_| p.clone()))).collect())
        .unwrap_or_default()
}

pub(crate) fn allowed_roots(db: &Database) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = known_folders().into_iter().map(|f| PathBuf::from(f.path)).collect();
    roots.extend(favorites(db));
    roots.into_iter().filter_map(|p| p.canonicalize().ok()).collect()
}

/// True when `path` is inside one of `roots` (after resolving `..` and links).
pub fn is_within(path: &Path, roots: &[PathBuf]) -> bool {
    let Ok(canonical) = path.canonicalize() else { return false };
    roots.iter().any(|root| canonical.starts_with(root))
}

fn ensure_allowed(db: &Database, path: &Path) -> CommandResult<()> {
    let recent = recent_dir().and_then(|r| r.canonicalize().ok());
    if is_within(path, &allowed_roots(db)) || recent.is_some_and(|r| is_within(path, &[r])) {
        Ok(())
    } else {
        Err("NOVA can only open items in your standard folders, favorites or recent files".into())
    }
}

pub(crate) fn is_hidden(meta: &std::fs::Metadata, name: &str) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        if meta.file_attributes() & (HIDDEN | SYSTEM) != 0 {
            return true;
        }
    }
    let _ = meta;
    name.starts_with('.') || name.eq_ignore_ascii_case("desktop.ini")
}

/// A resolved path the way everyone else writes it: `canonicalize` adds `\\\\?\\`,
/// which Explorer and the shell don't take, and a share becomes `\\\\?\\UNC\\…`.
pub fn plain_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\UNC\") {
        Some(share) => format!(r"\\{share}"),
        None => text.strip_prefix(r"\\?\").unwrap_or(&text).to_string(),
    }
}

fn entry(path: PathBuf, meta: &std::fs::Metadata) -> FileEntry {
    FileEntry {
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        path: plain_path(&path),
        is_dir: meta.is_dir(),
        size: if meta.is_dir() { 0 } else { meta.len() },
        modified_ms: meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64),
    }
}

pub fn list_dir(dir: &Path) -> CommandResult<Vec<FileEntry>> {
    let read = std::fs::read_dir(dir).map_err(|e| format!("Can't open this folder: {e}"))?;
    let mut entries: Vec<FileEntry> = read
        .map_while(Result::ok)
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let name = e.file_name().to_string_lossy().into_owned();
            (!is_hidden(&meta, &name)).then(|| entry(e.path(), &meta))
        })
        .collect();
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    // After sorting, so a full folder keeps its subfolders and its first names.
    entries.truncate(MAX_LIST);
    Ok(entries)
}

/// Breadth-first name search with hard limits on depth, directories visited and results.
pub fn search(roots: &[PathBuf], query: &str) -> Vec<FileEntry> {
    let needle = query.to_lowercase();
    let mut results = Vec::new();
    let mut queue: std::collections::VecDeque<(PathBuf, usize)> = roots.iter().map(|r| (r.clone(), 0)).collect();
    let mut visited = 0;
    while let Some((dir, depth)) = queue.pop_front() {
        visited += 1;
        if visited > MAX_VISITED_DIRS || results.len() >= MAX_RESULTS {
            break;
        }
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        for e in read.map_while(Result::ok) {
            let Ok(meta) = e.metadata() else { continue };
            let name = e.file_name().to_string_lossy().into_owned();
            if is_hidden(&meta, &name) {
                continue;
            }
            if name.to_lowercase().contains(&needle) {
                results.push(entry(e.path(), &meta));
                if results.len() >= MAX_RESULTS {
                    break;
                }
            }
            if meta.is_dir() && depth < MAX_DEPTH && !SKIPPED_DIRS.contains(&name.to_lowercase().as_str()) {
                queue.push_back((e.path(), depth + 1));
            }
        }
    }
    results
}

pub fn recent_items(limit: usize) -> Vec<FileEntry> {
    let Some(dir) = recent_dir() else { return Vec::new() };
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut items: Vec<FileEntry> = read
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("lnk")))
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let mut item = entry(e.path(), &meta);
            item.name = item.name.trim_end_matches(".lnk").to_string();
            Some(item)
        })
        .collect();
    items.sort_by_key(|item| std::cmp::Reverse(item.modified_ms));
    items.truncate(limit);
    items
}

#[tauri::command]
pub async fn files_known_folders() -> CommandResult<Vec<KnownFolder>> {
    tauri::async_runtime::spawn_blocking(known_folders).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn files_recent(limit: usize) -> CommandResult<Vec<FileEntry>> {
    let limit = limit.clamp(1, 100);
    tauri::async_runtime::spawn_blocking(move || recent_items(limit)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn files_list(db: tauri::State<'_, Database>, path: String) -> CommandResult<Vec<FileEntry>> {
    let path = PathBuf::from(path);
    ensure_allowed(&db, &path)?;
    tauri::async_runtime::spawn_blocking(move || list_dir(&path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn files_search(db: tauri::State<'_, Database>, query: String, root: Option<String>) -> CommandResult<Vec<FileEntry>> {
    let query = query.trim().to_string();
    if query.chars().count() < 2 {
        return Ok(Vec::new());
    }
    let roots = match root {
        Some(root) => {
            let root = PathBuf::from(root);
            ensure_allowed(&db, &root)?;
            vec![root]
        }
        None => allowed_roots(&db),
    };
    tauri::async_runtime::spawn_blocking(move || search(&roots, &query)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn files_open(db: tauri::State<'_, Database>, path: String) -> CommandResult<()> {
    let path = PathBuf::from(path);
    ensure_allowed(&db, &path)?;
    tauri::async_runtime::spawn_blocking(move || shell::open_path(&path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn files_reveal(db: tauri::State<'_, Database>, path: String) -> CommandResult<()> {
    let path = PathBuf::from(path);
    ensure_allowed(&db, &path)?;
    shell::reveal_path(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each test gets its own tree: tests run in parallel within one process.
    fn temp_tree(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("nova-files-{}-{name}", std::process::id()));
        std::fs::create_dir_all(root.join("Projects").join("deep")).unwrap();
        std::fs::create_dir_all(root.join("node_modules").join("pkg")).unwrap();
        std::fs::write(root.join("Projects").join("deep").join("Budget 2026.xlsx"), b"x").unwrap();
        std::fs::write(root.join("node_modules").join("pkg").join("budget.js"), b"x").unwrap();
        std::fs::write(root.join(".hidden-budget"), b"x").unwrap();
        root
    }

    #[test]
    fn search_finds_nested_files_and_skips_noise() {
        let root = temp_tree("search");
        let results = search(std::slice::from_ref(&root), "budget");
        let names: Vec<_> = results.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["Budget 2026.xlsx"]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn scope_check_rejects_paths_outside_roots() {
        let root = temp_tree("scope");
        let roots = vec![root.join("Projects").canonicalize().unwrap()];
        assert!(is_within(&root.join("Projects").join("deep"), &roots));
        assert!(is_within(&root.join("Projects").join("deep").join("..").join("deep"), &roots));
        assert!(!is_within(&root.join("Projects").join("..").join("node_modules"), &roots));
        assert!(!is_within(Path::new("C:\\Windows\\System32"), &roots));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn lists_directories_first_without_hidden_files() {
        let root = temp_tree("list");
        let names: Vec<_> = list_dir(&root).unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, ["node_modules", "Projects"]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn finds_standard_folders() {
        assert!(known_folders().iter().any(|f| f.id == "documents"));
    }
}
