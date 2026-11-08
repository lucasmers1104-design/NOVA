//! Local SQLite persistence (`%APPDATA%\dev.nova.commandcenter\nova.db`).
//!
//! If the database cannot be opened or migrated, NOVA keeps running: every
//! storage command reports the reason and the frontend falls back to
//! defaults. User data is never deleted to "recover".

pub(crate) mod actions;
pub(crate) mod conversations;
pub(crate) mod file_index;
mod kv;
mod layouts;
mod migrations;
pub(crate) mod productivity;
pub(crate) mod shortcuts;
pub(crate) mod usage;

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::Serialize;

pub use layouts::DashboardLayout;
use productivity::{Entity, Note, ProductivityData, Project, Task};

#[derive(Debug)]
pub enum StorageError {
    Sqlite(rusqlite::Error),
    Migration { version: i64, name: &'static str, source: rusqlite::Error },
    NewerSchema { found: i64, supported: i64 },
    Invalid(String),
    Unavailable(String),
}

impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(e) => write!(f, "database error: {e}"),
            Self::Migration { version, name, source } => {
                write!(f, "migration {version} ({name}) failed and was rolled back: {source}")
            }
            Self::NewerSchema { found, supported } => write!(
                f,
                "the database was created by a newer version of NOVA (schema {found}, this version supports {supported})"
            ),
            Self::Invalid(msg) => write!(f, "{msg}"),
            Self::Unavailable(msg) => write!(f, "storage is unavailable: {msg}"),
        }
    }
}

impl From<rusqlite::Error> for StorageError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sqlite(e)
    }
}

type CommandResult<T> = Result<T, String>;

pub(crate) fn now_millis() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Unique, sortable id for rows created on the Rust side.
pub(crate) fn new_id(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{prefix}-{nanos:x}-{:x}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Reads a raw settings value for Rust-side consumers (desktop preferences, file favorites).
pub(crate) fn kv_get(conn: &mut Connection, key: &str) -> Result<Option<String>, StorageError> {
    kv::get(conn, key)
}

/// Writes a raw settings value owned by the Rust side (assistant preferences).
pub(crate) fn kv_set(conn: &mut Connection, key: &str, value: &str) -> Result<(), StorageError> {
    kv::set(conn, key, value)
}

/// `[A-Za-z0-9_-]{1,max_len}` — the shape of every id NOVA stores.
pub(crate) fn is_identifier(value: &str, max_len: usize) -> bool {
    !value.is_empty() && value.len() <= max_len && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn configure(conn: &Connection) -> Result<(), StorageError> {
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    // WAL is unavailable for in-memory databases; ignore the result there.
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(())
}

fn open_connection(path: &Path) -> Result<Connection, StorageError> {
    let mut conn = Connection::open(path)?;
    configure(&conn)?;
    migrations::migrate(&mut conn)?;
    Ok(conn)
}

pub struct Database {
    path: Option<PathBuf>,
    conn: Mutex<Result<Connection, String>>,
}

impl Database {
    pub fn open(path: PathBuf) -> Self {
        let conn = open_connection(&path).map_err(|e| e.to_string());
        if let Err(error) = &conn {
            eprintln!("[NOVA] storage disabled: {error}");
        }
        Self { path: Some(path), conn: Mutex::new(conn) }
    }

    pub fn unavailable(reason: String) -> Self {
        eprintln!("[NOVA] storage disabled: {reason}");
        Self { path: None, conn: Mutex::new(Err(reason)) }
    }

    pub(crate) fn with<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T, StorageError>) -> CommandResult<T> {
        let mut guard = self.conn.lock().map_err(|_| "storage lock poisoned".to_string())?;
        let conn = guard
            .as_mut()
            .map_err(|reason| StorageError::Unavailable(reason.clone()).to_string())?;
        f(conn).map_err(|e| e.to_string())
    }

    #[cfg(test)]
    pub(crate) fn in_memory_for_tests() -> Self {
        Self { path: None, conn: Mutex::new(Ok(test_connection())) }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatus {
    available: bool,
    path: Option<String>,
    schema_version: Option<i64>,
    error: Option<String>,
}

#[tauri::command]
pub async fn storage_status(db: tauri::State<'_, Database>) -> CommandResult<StorageStatus> {
    let guard = db.conn.lock().map_err(|_| "storage lock poisoned".to_string())?;
    let path = db.path.as_ref().map(|p| p.to_string_lossy().into_owned());
    Ok(match guard.as_ref() {
        Ok(conn) => StorageStatus {
            available: true,
            path,
            schema_version: migrations::schema_version(conn).ok(),
            error: None,
        },
        Err(reason) => StorageStatus { available: false, path, schema_version: None, error: Some(reason.clone()) },
    })
}

#[tauri::command]
pub async fn settings_get(db: tauri::State<'_, Database>, key: String) -> CommandResult<Option<String>> {
    db.with(|conn| kv::get(conn, &key))
}

/// What only NOVA's own checked code writes: auto mode, what routines do and what
/// NOVA remembers don't change through a page writing a setting directly.
fn rust_owned(key: &str) -> bool {
    // SECURITY: "nova.companion" holds the phone allowlist; only the checked companion commands change it.
    key.starts_with("nova.assistant") || matches!(key, "nova.finder" | "nova.automation" | "nova.memory" | "nova.played" | "nova.tidy.last" | "nova.telemetry" | "nova.companion")
}

#[tauri::command]
pub async fn settings_set(db: tauri::State<'_, Database>, key: String, value: String) -> CommandResult<()> {
    if rust_owned(&key) {
        return Err("That setting can't be written directly".into());
    }
    db.with(|conn| kv::set(conn, &key, &value))
}

#[tauri::command]
pub async fn settings_delete(db: tauri::State<'_, Database>, key: String) -> CommandResult<()> {
    if rust_owned(&key) {
        return Err("That setting can't be deleted directly".into());
    }
    db.with(|conn| kv::delete(conn, &key))
}

#[tauri::command]
pub async fn dashboard_layouts_list(db: tauri::State<'_, Database>) -> CommandResult<Vec<DashboardLayout>> {
    db.with(|conn| layouts::list(conn))
}

#[tauri::command]
pub async fn dashboard_layout_save(db: tauri::State<'_, Database>, layout: DashboardLayout) -> CommandResult<()> {
    db.with(|conn| layouts::save(conn, &layout))
}

#[tauri::command]
pub async fn dashboard_layout_delete(db: tauri::State<'_, Database>, id: String) -> CommandResult<()> {
    db.with(|conn| layouts::delete(conn, &id))
}

#[tauri::command]
pub async fn productivity_load(db: tauri::State<'_, Database>) -> CommandResult<ProductivityData> {
    db.with(productivity::load)
}

#[tauri::command]
pub async fn project_save(db: tauri::State<'_, Database>, project: Project) -> CommandResult<Project> {
    db.with(|conn| productivity::save_project(conn, &project))
}

#[tauri::command]
pub async fn task_save(db: tauri::State<'_, Database>, task: Task) -> CommandResult<Task> {
    db.with(|conn| productivity::save_task(conn, &task))
}

#[tauri::command]
pub async fn note_save(db: tauri::State<'_, Database>, note: Note) -> CommandResult<Note> {
    db.with(|conn| productivity::save_note(conn, &note))
}

#[tauri::command]
pub async fn productivity_delete(db: tauri::State<'_, Database>, entity: String, id: String) -> CommandResult<()> {
    let entity = match entity.as_str() {
        "project" => Entity::Project,
        "task" => Entity::Task,
        "note" => Entity::Note,
        other => return Err(format!("Unknown entity \"{other}\"")),
    };
    db.with(|conn| productivity::delete(conn, entity, &id))
}

#[tauri::command]
pub async fn ai_conversations_list(db: tauri::State<'_, Database>) -> CommandResult<Vec<conversations::Conversation>> {
    db.with(conversations::list)
}

#[tauri::command]
pub async fn ai_conversation_messages(
    db: tauri::State<'_, Database>,
    id: String,
) -> CommandResult<Vec<conversations::Message>> {
    db.with(|conn| conversations::messages(conn, &id))
}

#[tauri::command]
pub async fn ai_conversation_rename(db: tauri::State<'_, Database>, id: String, title: String) -> CommandResult<()> {
    db.with(|conn| conversations::rename(conn, &id, &title))
}

#[tauri::command]
pub async fn ai_conversation_delete(db: tauri::State<'_, Database>, id: String) -> CommandResult<()> {
    db.with(|conn| conversations::delete(conn, &id))
}

#[cfg(test)]
pub(crate) fn test_connection() -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    configure(&conn).unwrap();
    migrations::migrate(&mut conn).unwrap();
    conn
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_and_persists_across_reopen() {
        let dir = std::env::temp_dir().join(format!("nova-db-test-{}", now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("nova.db");

        let db = Database::open(path.clone());
        db.with(|conn| kv::set(conn, "nova.test", "42")).unwrap();
        drop(db);

        let reopened = Database::open(path);
        assert_eq!(reopened.with(|conn| kv::get(conn, "nova.test")).unwrap().as_deref(), Some("42"));
        drop(reopened);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unavailable_storage_reports_the_reason() {
        let db = Database::unavailable("disk is read-only".into());
        let err = db.with(|conn| kv::get(conn, "nova.settings")).unwrap_err();
        assert!(err.contains("disk is read-only"));
    }

    #[test]
    fn newer_database_is_not_modified() {
        let dir = std::env::temp_dir().join(format!("nova-db-newer-{}", now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("nova.db");
        Connection::open(&path).unwrap().pragma_update(None, "user_version", 500).unwrap();

        let db = Database::open(path.clone());
        assert!(db.with(|_| Ok(())).unwrap_err().contains("newer version"));
        drop(db);
        let version: i64 = Connection::open(&path)
            .unwrap()
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, 500);
        let _ = std::fs::remove_dir_all(dir);
    }
}
