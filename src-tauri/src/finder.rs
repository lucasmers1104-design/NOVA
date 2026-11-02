//! NOVA Finder: an incremental index of folders the user chose, searchable by
//! name, folder, type, date and (for text files) content.
//!
//! Nothing is indexed until the user adds a folder. The indexer runs on a
//! background thread at low CPU and disk priority, skips hidden and system
//! items, and only re-reads files whose size or modification time changed.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_dialog::DialogExt;

use crate::storage::file_index::{self, FileHit, IndexedFile, Query};
use crate::storage::Database;

type CommandResult<T> = Result<T, String>;

const PREFS_KEY: &str = "nova.finder";
const EVENT_PROGRESS: &str = "finder://progress";
const MAX_FOLDERS: usize = 20;
const MAX_FILES_PER_ROOT: usize = 250_000;
const MAX_DEPTH: usize = 16;
/// Text files larger than this are indexed by name only.
const MAX_TEXT_FILE: u64 = 1024 * 1024;
/// How much of a text file's beginning goes into the index.
const MAX_TEXT_CHARS: usize = 16_000;
const BATCH: usize = 400;
/// A search triggers a quiet refresh when the last pass is older than this.
const STALE_AFTER: Duration = Duration::from_secs(60 * 60);

/// Folders that never contain the user's own files, or are huge caches.
const SKIPPED_DIRS: &[&str] = &[
    "node_modules", ".git", ".svn", ".hg", "$recycle.bin", "appdata", "target", ".cache", "__pycache__", ".venv", "venv",
    ".gradle", ".idea", ".vs", "windows", "program files", "program files (x86)", "programdata", "system volume information",
];

const TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "csv", "tsv", "json", "xml", "html", "htm", "css", "js", "ts", "tsx", "jsx", "py", "rs", "java", "c", "cpp",
    "h", "hpp", "cs", "go", "rb", "php", "sql", "yaml", "yml", "toml", "ini", "cfg", "log", "bat", "ps1", "sh", "tex", "srt",
];

/// Coarse type of a file from its extension; "folder" for directories.
pub fn kind_of(ext: &str) -> &'static str {
    match ext {
        "pdf" => "pdf",
        "doc" | "docx" | "odt" | "rtf" | "txt" | "md" | "markdown" | "pages" | "tex" => "document",
        "xls" | "xlsx" | "xlsm" | "ods" | "csv" | "tsv" | "numbers" => "spreadsheet",
        "ppt" | "pptx" | "odp" | "key" => "presentation",
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "heic" | "svg" | "tif" | "tiff" | "ico" | "raw" | "cr2" | "nef" | "psd" => "image",
        "mp4" | "mov" | "avi" | "mkv" | "webm" | "wmv" | "m4v" => "video",
        "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a" | "wma" => "audio",
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" => "archive",
        "stl" | "obj" | "3mf" | "gcode" | "blend" | "fbx" | "step" | "stp" | "3ds" | "ply" | "lxf" | "io" | "ldr" => "3d",
        "exe" | "msi" | "bat" | "cmd" | "ps1" | "lnk" | "appref-ms" => "program",
        "rs" | "js" | "ts" | "tsx" | "jsx" | "py" | "java" | "c" | "cpp" | "h" | "hpp" | "cs" | "go" | "rb" | "php" | "sql" | "html"
        | "htm" | "css" | "json" | "xml" | "yaml" | "yml" | "toml" | "sh" => "code",
        _ => "other",
    }
}

pub const KINDS: &[&str] = &[
    "folder", "pdf", "document", "spreadsheet", "presentation", "image", "video", "audio", "archive", "3d", "program", "code", "other",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FinderPrefs {
    pub folders: Vec<String>,
    /// Also index the beginning of text files.
    pub content: bool,
}

impl Default for FinderPrefs {
    fn default() -> Self {
        Self { folders: Vec::new(), content: true }
    }
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub running: bool,
    pub scanned: u64,
    pub indexed: u64,
    pub current: Option<String>,
    pub last_finished: Option<i64>,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct FinderState {
    prefs: Mutex<FinderPrefs>,
    progress: Mutex<Progress>,
    running: AtomicBool,
    restart: AtomicBool,
    last_pass: Mutex<Option<Instant>>,
}

fn state<R: Runtime>(app: &AppHandle<R>) -> &FinderState {
    app.state::<FinderState>().inner()
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn load_prefs(db: &Database) -> FinderPrefs {
    let mut prefs: FinderPrefs = db
        .with(|conn| crate::storage::kv_get(conn, PREFS_KEY))
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    prefs.folders.truncate(MAX_FOLDERS);
    prefs
}

fn save_prefs<R: Runtime>(app: &AppHandle<R>, prefs: &FinderPrefs) -> CommandResult<()> {
    let json = serde_json::to_string(prefs).map_err(|e| e.to_string())?;
    app.state::<Database>().with(|conn| crate::storage::kv_set(conn, PREFS_KEY, &json))
}

/// Startup: remember the folders and refresh the index quietly after a while.
pub fn init<R: Runtime>(app: &AppHandle<R>, prefs: FinderPrefs) {
    let has_folders = !prefs.folders.is_empty();
    *lock(&state(app).prefs) = prefs;
    if has_folders {
        let app = app.clone();
        std::thread::spawn(move || {
            // Let NOVA finish starting before touching the disk.
            std::thread::sleep(Duration::from_secs(45));
            start_indexing(&app);
        });
    }
}

pub fn indexed_folders<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    lock(&state(app).prefs).folders.clone()
}

/// Folders NOVA AI may read and change files in: the standard folders and
/// favorites NOVA already allows, the indexed folders, and NOVA's workspace.
pub fn allowed_roots<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    let db = app.state::<Database>();
    let mut roots = crate::files::allowed_roots(&db);
    roots.extend(lock(&state(app).prefs).folders.iter().filter_map(|f| PathBuf::from(f).canonicalize().ok()));
    if let Ok(workspace) = crate::documents::workspace().and_then(|w| w.canonicalize().map_err(|e| e.to_string())) {
        roots.push(workspace);
    }
    roots
}

fn millis(time: std::io::Result<std::time::SystemTime>) -> i64 {
    time.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64)
}

fn read_text_start(path: &Path, size: u64) -> Option<String> {
    if size == 0 || size > MAX_TEXT_FILE {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;
    let mut buffer = Vec::with_capacity((MAX_TEXT_CHARS * 2).min(size as usize));
    file.by_ref().take((MAX_TEXT_CHARS * 4) as u64).read_to_end(&mut buffer).ok()?;
    if buffer.contains(&0) {
        return None; // binary despite the extension
    }
    let text = String::from_utf8_lossy(&buffer);
    let text: String = text.chars().take(MAX_TEXT_CHARS).collect();
    (!text.trim().is_empty()).then_some(text)
}

/// Lower this thread's CPU and I/O priority for the duration of a pass.
#[cfg(windows)]
fn background_priority(on: bool) {
    use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN, THREAD_MODE_BACKGROUND_END};
    // SAFETY: changes only the calling thread's own scheduling priority.
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), if on { THREAD_MODE_BACKGROUND_BEGIN } else { THREAD_MODE_BACKGROUND_END });
    }
}

#[cfg(not(windows))]
fn background_priority(_: bool) {}

/// Starts an incremental pass unless one is running (then it restarts once it ends).
pub fn start_indexing<R: Runtime>(app: &AppHandle<R>) {
    let finder = state(app);
    if finder.running.swap(true, Ordering::SeqCst) {
        finder.restart.store(true, Ordering::SeqCst);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        background_priority(true);
        loop {
            state(&app).restart.store(false, Ordering::SeqCst);
            let result = index_all(&app);
            let finder = state(&app);
            {
                let mut progress = lock(&finder.progress);
                progress.running = false;
                progress.current = None;
                progress.error = result.err();
                progress.last_finished = Some(crate::storage::now_millis());
            }
            *lock(&finder.last_pass) = Some(Instant::now());
            if !finder.restart.load(Ordering::SeqCst) {
                break;
            }
        }
        background_priority(false);
        state(&app).running.store(false, Ordering::SeqCst);
        emit_progress(&app);
    });
}

fn emit_progress<R: Runtime>(app: &AppHandle<R>) {
    let progress = lock(&state(app).progress).clone();
    let _ = app.emit(EVENT_PROGRESS, progress);
}

fn index_all<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let prefs = lock(&state(app).prefs).clone();
    {
        let mut progress = lock(&state(app).progress);
        *progress = Progress { running: true, last_finished: progress.last_finished, ..Progress::default() };
    }
    emit_progress(app);
    let db = app.state::<Database>();
    let seen = crate::storage::now_millis();
    for root in &prefs.folders {
        lock(&state(app).progress).current = Some(root.clone());
        emit_progress(app);
        if Path::new(root).is_dir() {
            index_root(app, &db, root, prefs.content, seen)?;
        }
    }
    Ok(())
}

fn index_root<R: Runtime>(app: &AppHandle<R>, db: &Database, root: &str, content: bool, seen: i64) -> Result<(), String> {
    let known = db.with(|conn| file_index::known(conn, root))?;
    let mut unchanged: Vec<i64> = Vec::new();
    let mut changed: Vec<IndexedFile> = Vec::new();
    let mut queue: std::collections::VecDeque<(PathBuf, usize)> = [(PathBuf::from(root), 0)].into();
    let mut count = 0usize;
    let mut last_emit = Instant::now();

    let flush = |changed: &mut Vec<IndexedFile>, unchanged: &mut Vec<i64>| -> Result<(), String> {
        db.with(|conn| {
            let tx = conn.transaction()?;
            for file in changed.iter() {
                file_index::upsert(&tx, file, seen)?;
            }
            file_index::mark_seen(&tx, unchanged, seen)?;
            tx.commit()?;
            Ok(())
        })?;
        changed.clear();
        unchanged.clear();
        Ok(())
    };

    while let Some((dir, depth)) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            if crate::files::is_hidden(&meta, &name) {
                continue;
            }
            let path = entry.path();
            let is_dir = meta.is_dir();
            if is_dir && (depth >= MAX_DEPTH || SKIPPED_DIRS.contains(&name.to_lowercase().as_str())) {
                continue;
            }
            count += 1;
            if count > MAX_FILES_PER_ROOT {
                break;
            }
            let path_text = path.to_string_lossy().into_owned();
            let size = if is_dir { 0 } else { meta.len() as i64 };
            let modified = millis(meta.modified());
            match known.get(&path_text) {
                Some(&(id, old_size, old_modified)) if old_size == size && old_modified == modified => unchanged.push(id),
                _ => {
                    let ext = if is_dir { String::new() } else { path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default() };
                    let body = (content && !is_dir && TEXT_EXTENSIONS.contains(&ext.as_str()))
                        .then(|| read_text_start(&path, meta.len()))
                        .flatten();
                    changed.push(IndexedFile {
                        kind: if is_dir { "folder" } else { kind_of(&ext) },
                        folder: dir.to_string_lossy().into_owned(),
                        root: root.to_string(),
                        name,
                        ext,
                        size,
                        modified,
                        created: millis(meta.created()),
                        body,
                        path: path_text,
                    });
                }
            }
            if is_dir {
                queue.push_back((path, depth + 1));
            }
            if changed.len() + unchanged.len() >= BATCH {
                let indexed = changed.len() as u64;
                flush(&mut changed, &mut unchanged)?;
                let mut progress = lock(&state(app).progress);
                progress.scanned = progress.scanned.saturating_add(BATCH as u64);
                progress.indexed += indexed;
            }
            if last_emit.elapsed() > Duration::from_millis(800) {
                last_emit = Instant::now();
                emit_progress(app);
            }
        }
        if count > MAX_FILES_PER_ROOT {
            break;
        }
    }
    let indexed = changed.len() as u64;
    flush(&mut changed, &mut unchanged)?;
    {
        let mut progress = lock(&state(app).progress);
        progress.indexed += indexed;
        progress.scanned = progress.scanned.max(count as u64);
    }
    db.with(|conn| file_index::sweep(conn, root, seen))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FinderQuery {
    pub text: String,
    pub kind: Option<String>,
    pub extension: Option<String>,
    /// Only files changed within this many days.
    pub modified_within_days: Option<u32>,
    /// Only files changed more than this many days ago ("older versions").
    pub older_than_days: Option<u32>,
    pub folder: Option<String>,
    pub limit: Option<usize>,
}

const STOP_WORDS: &[&str] = &[
    "the", "a", "an", "my", "of", "about", "for", "with", "file", "files", "find", "show", "me", "der", "die", "das", "den", "dem", "des",
    "ein", "eine", "einen", "mein", "meine", "meinen", "meiner", "von", "über", "zu", "zum", "zur", "mit", "datei", "dateien", "finde",
    "such", "suche", "zeig", "zeige", "and", "und", "or", "oder", "in", "im", "on", "auf",
];

fn terms_of(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .map(str::to_lowercase)
        .filter(|w| !w.is_empty() && !STOP_WORDS.contains(&w.as_str()))
        .take(8)
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub hits: Vec<FileHit>,
    /// "index" when NOVA Finder answered, "live" for a name-only scan of the standard folders.
    pub source: &'static str,
    pub indexed_folders: usize,
}

pub fn search<R: Runtime>(app: &AppHandle<R>, query: &FinderQuery) -> CommandResult<SearchResult> {
    let finder = state(app);
    let folders = lock(&finder.prefs).folders.len();
    let day = 24 * 60 * 60 * 1000;
    let now = crate::storage::now_millis();
    let kind = query.kind.as_ref().map(|k| k.to_lowercase()).filter(|k| KINDS.contains(&k.as_str()));
    let ext = query.extension.as_ref().map(|e| e.trim_start_matches('.').to_lowercase()).filter(|e| !e.is_empty() && e.len() <= 10);
    let limit = query.limit.unwrap_or(12).clamp(1, 50);

    if folders == 0 {
        // Nothing indexed yet: a bounded, name-only scan of the standard folders.
        let roots = crate::files::allowed_roots(&app.state::<Database>());
        let needle = terms_of(&query.text).into_iter().max_by_key(|t| t.len()).unwrap_or_default();
        if needle.is_empty() {
            return Ok(SearchResult { hits: Vec::new(), source: "live", indexed_folders: 0 });
        }
        let hits = crate::files::search(&roots, &needle)
            .into_iter()
            .map(|e| {
                let ext = Path::new(&e.path).extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
                FileHit {
                    folder: Path::new(&e.path).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
                    kind: if e.is_dir { "folder".into() } else { kind_of(&ext).into() },
                    name: e.name,
                    path: e.path,
                    ext,
                    size: e.size as i64,
                    modified: e.modified_ms as i64,
                    snippet: None,
                }
            })
            .filter(|h| kind.as_ref().is_none_or(|k| &h.kind == k) && ext.as_ref().is_none_or(|x| &h.ext == x))
            .take(limit)
            .collect();
        return Ok(SearchResult { hits, source: "live", indexed_folders: 0 });
    }

    if lock(&finder.last_pass).is_none_or(|t| t.elapsed() > STALE_AFTER) && !finder.running.load(Ordering::SeqCst) {
        start_indexing(app);
    }
    let q = Query {
        terms: terms_of(&query.text),
        kind,
        ext,
        modified_after: query.modified_within_days.map(|d| now - d as i64 * day),
        modified_before: query.older_than_days.map(|d| now - d as i64 * day),
        folder: query.folder.clone().filter(|f| !f.trim().is_empty()),
        limit,
    };
    let hits = app.state::<Database>().with(|conn| file_index::search(conn, &q))?;
    Ok(SearchResult { hits, source: "index", indexed_folders: folders })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderStatus {
    path: String,
    files: i64,
    exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinderStatus {
    folders: Vec<FolderStatus>,
    content: bool,
    progress: Progress,
}

fn status<R: Runtime>(app: &AppHandle<R>) -> CommandResult<FinderStatus> {
    let prefs = lock(&state(app).prefs).clone();
    let counts = app.state::<Database>().with(|c| file_index::count_by_root(c)).unwrap_or_default();
    Ok(FinderStatus {
        folders: prefs
            .folders
            .iter()
            .map(|f| FolderStatus { files: counts.get(f).copied().unwrap_or(0), exists: Path::new(f).is_dir(), path: f.clone() })
            .collect(),
        content: prefs.content,
        progress: lock(&state(app).progress).clone(),
    })
}

fn add_folders<R: Runtime>(app: &AppHandle<R>, paths: Vec<PathBuf>) -> CommandResult<FinderStatus> {
    let prefs = {
        let mut prefs = lock(&state(app).prefs);
        let mut existing: HashSet<String> = prefs.folders.iter().map(|f| f.to_lowercase()).collect();
        for path in paths {
            let Ok(canonical) = path.canonicalize() else { continue };
            // `canonicalize` adds the \\?\ prefix on Windows; keep the familiar form.
            let text = canonical.to_string_lossy().trim_start_matches(r"\\?\").to_string();
            let lower = text.to_lowercase();
            // A folder inside an indexed one is already covered.
            if prefs.folders.iter().any(|f| lower.starts_with(&format!("{}\\", f.to_lowercase()))) || !existing.insert(lower) {
                continue;
            }
            if prefs.folders.len() >= MAX_FOLDERS {
                return Err(format!("NOVA Finder indexes up to {MAX_FOLDERS} folders"));
            }
            prefs.folders.push(text);
        }
        prefs.clone()
    };
    save_prefs(app, &prefs)?;
    start_indexing(app);
    status(app)
}

#[tauri::command]
pub async fn finder_status<R: Runtime>(app: AppHandle<R>) -> CommandResult<FinderStatus> {
    status(&app)
}

/// Lets the user pick a folder in the native dialog; the path never comes from the webview.
#[tauri::command]
pub async fn finder_pick_folder<R: Runtime>(app: AppHandle<R>) -> CommandResult<FinderStatus> {
    let picked = app.dialog().file().set_title("Choose a folder for NOVA Finder").blocking_pick_folder();
    match picked.map(|p| p.into_path()) {
        Some(Ok(path)) => add_folders(&app, vec![path]),
        Some(Err(e)) => Err(e.to_string()),
        None => status(&app),
    }
}

/// Documents, Desktop, Downloads, Pictures, Music and Videos.
#[tauri::command]
pub async fn finder_add_standard_folders<R: Runtime>(app: AppHandle<R>) -> CommandResult<FinderStatus> {
    let folders = crate::files::known_folders().into_iter().map(|f| PathBuf::from(f.path)).collect();
    add_folders(&app, folders)
}

#[tauri::command]
pub async fn finder_remove_folder<R: Runtime>(app: AppHandle<R>, path: String) -> CommandResult<FinderStatus> {
    let prefs = {
        let mut prefs = lock(&state(&app).prefs);
        let before = prefs.folders.len();
        prefs.folders.retain(|f| f != &path);
        if prefs.folders.len() == before {
            return Err("That folder isn't indexed".into());
        }
        prefs.clone()
    };
    save_prefs(&app, &prefs)?;
    app.state::<Database>().with(|conn| file_index::remove_root(conn, &path))?;
    status(&app)
}

#[tauri::command]
pub async fn finder_set_content<R: Runtime>(app: AppHandle<R>, enabled: bool) -> CommandResult<FinderStatus> {
    let prefs = {
        let mut prefs = lock(&state(&app).prefs);
        prefs.content = enabled;
        prefs.clone()
    };
    save_prefs(&app, &prefs)?;
    if !enabled {
        // Forget stored text right away instead of on the next change.
        app.state::<Database>().with(|conn| {
            conn.execute("UPDATE file_index_fts SET body = '' WHERE body <> ''", [])?;
            conn.execute("UPDATE file_index SET has_text = 0, size = -1 WHERE has_text = 1", [])?;
            Ok(())
        })?;
    }
    start_indexing(&app);
    status(&app)
}

#[tauri::command]
pub async fn finder_reindex<R: Runtime>(app: AppHandle<R>) -> CommandResult<FinderStatus> {
    start_indexing(&app);
    status(&app)
}

#[tauri::command]
pub async fn finder_search<R: Runtime>(app: AppHandle<R>, query: FinderQuery) -> CommandResult<SearchResult> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || search(&app2, &query)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_extensions() {
        assert_eq!(kind_of("pdf"), "pdf");
        assert_eq!(kind_of("xlsx"), "spreadsheet");
        assert_eq!(kind_of("stl"), "3d");
        assert_eq!(kind_of("pptx"), "presentation");
        assert_eq!(kind_of("weird"), "other");
        for ext in ["pdf", "docx", "csv", "key", "png", "mkv", "flac", "7z", "3mf", "msi", "rs", "zzz"] {
            assert!(KINDS.contains(&kind_of(ext)), "{ext} maps to an unknown kind");
        }
    }

    #[test]
    fn extracts_search_terms_in_english_and_german() {
        assert_eq!(terms_of("Find the PDF about my 3D printer"), ["pdf", "3d", "printer"]);
        assert_eq!(terms_of("finde meine LEGO-Berechnung"), ["lego", "berechnung"]);
        assert!(terms_of("the of my").is_empty());
    }

    #[test]
    fn reads_only_text_beginnings() {
        let dir = std::env::temp_dir().join(format!("nova-finder-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let text = dir.join("a.txt");
        std::fs::write(&text, "Hallo Welt").unwrap();
        assert_eq!(read_text_start(&text, 10).as_deref(), Some("Hallo Welt"));
        let binary = dir.join("b.txt");
        std::fs::write(&binary, [0u8, 1, 2, 3]).unwrap();
        assert_eq!(read_text_start(&binary, 4), None);
        assert_eq!(read_text_start(&text, MAX_TEXT_FILE + 1), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
