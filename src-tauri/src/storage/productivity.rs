//! Projects, tasks and notes.

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

use super::{is_identifier, now_millis, StorageError};

const MAX_TITLE: usize = 200;
const MAX_TASK_NOTES: usize = 20_000;
const MAX_NOTE_BODY: usize = 200_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub notes: String,
    pub project_id: Option<String>,
    #[serde(default)]
    pub priority: u8,
    /// Local calendar date, `YYYY-MM-DD`.
    pub due_date: Option<String>,
    /// Local time, `HH:MM`; only meaningful with a due date.
    pub due_time: Option<String>,
    #[serde(default)]
    pub remind: bool,
    pub completed_at: Option<i64>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub project_id: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductivityData {
    pub projects: Vec<Project>,
    pub tasks: Vec<Task>,
    pub notes: Vec<Note>,
}

fn invalid<T>(message: impl Into<String>) -> Result<T, StorageError> {
    Err(StorageError::Invalid(message.into()))
}

pub fn is_valid_date(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    let [y, m, d] = parts.as_slice() else { return false };
    if y.len() != 4 || m.len() != 2 || d.len() != 2 {
        return false;
    }
    let (Ok(year), Ok(month), Ok(day)) = (y.parse::<u32>(), m.parse::<u32>(), d.parse::<u32>()) else { return false };
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1900..=2999).contains(&year) && (1..=days).contains(&day)
}

pub fn is_valid_time(value: &str) -> bool {
    let Some((h, m)) = value.split_once(':') else { return false };
    h.len() == 2 && m.len() == 2 && h.parse::<u32>().is_ok_and(|h| h < 24) && m.parse::<u32>().is_ok_and(|m| m < 60)
}

fn check_id(id: &str) -> Result<(), StorageError> {
    if is_identifier(id, 64) {
        Ok(())
    } else {
        invalid(format!("invalid id \"{id}\""))
    }
}

fn check_project_ref(project_id: &Option<String>) -> Result<(), StorageError> {
    match project_id {
        Some(id) => check_id(id),
        None => Ok(()),
    }
}

/// Maps foreign-key violations (unknown project) to a readable error.
fn map_fk(error: rusqlite::Error) -> StorageError {
    if error.to_string().contains("FOREIGN KEY") {
        StorageError::Invalid("The selected project no longer exists".into())
    } else {
        StorageError::Sqlite(error)
    }
}

fn project_from_row(r: &Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: r.get(0)?,
        name: r.get(1)?,
        color: r.get(2)?,
        archived: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
    })
}

fn task_from_row(r: &Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?,
        title: r.get(1)?,
        notes: r.get(2)?,
        project_id: r.get(3)?,
        priority: r.get(4)?,
        due_date: r.get(5)?,
        due_time: r.get(6)?,
        remind: r.get(7)?,
        completed_at: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
    })
}

fn note_from_row(r: &Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: r.get(0)?,
        title: r.get(1)?,
        body: r.get(2)?,
        project_id: r.get(3)?,
        pinned: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
    })
}

pub fn load(conn: &mut Connection) -> Result<ProductivityData, StorageError> {
    let projects = conn
        .prepare("SELECT id, name, color, archived, created_at, updated_at FROM projects ORDER BY created_at")?
        .query_map([], project_from_row)?
        .collect::<Result<_, _>>()?;
    let tasks = conn
        .prepare(
            "SELECT id, title, notes, project_id, priority, due_date, due_time, remind, completed_at, created_at, updated_at
             FROM tasks ORDER BY created_at",
        )?
        .query_map([], task_from_row)?
        .collect::<Result<_, _>>()?;
    let notes = conn
        .prepare("SELECT id, title, body, project_id, pinned, created_at, updated_at FROM notes ORDER BY updated_at DESC")?
        .query_map([], note_from_row)?
        .collect::<Result<_, _>>()?;
    Ok(ProductivityData { projects, tasks, notes })
}

pub fn save_project(conn: &mut Connection, project: &Project) -> Result<Project, StorageError> {
    check_id(&project.id)?;
    let name = project.name.trim();
    if name.is_empty() || name.chars().count() > 60 {
        return invalid("Project name must be 1–60 characters");
    }
    let color_ok = project.color.is_empty()
        || (project.color.len() == 7 && project.color.starts_with('#') && project.color[1..].chars().all(|c| c.is_ascii_hexdigit()));
    if !color_ok {
        return invalid("Project color must be a #rrggbb value");
    }
    let now = now_millis();
    conn.execute(
        "INSERT INTO projects (id, name, color, archived, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, archived = excluded.archived,
         updated_at = excluded.updated_at",
        params![project.id, name, project.color, project.archived, now],
    )?;
    Ok(conn.query_row(
        "SELECT id, name, color, archived, created_at, updated_at FROM projects WHERE id = ?1",
        [&project.id],
        project_from_row,
    )?)
}

pub fn save_task(conn: &mut Connection, task: &Task) -> Result<Task, StorageError> {
    check_id(&task.id)?;
    check_project_ref(&task.project_id)?;
    let title = task.title.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE {
        return invalid(format!("Task title must be 1–{MAX_TITLE} characters"));
    }
    if task.notes.len() > MAX_TASK_NOTES {
        return invalid("Task notes are too long");
    }
    if task.priority > 3 {
        return invalid("Priority must be between 0 and 3");
    }
    if task.due_date.as_deref().is_some_and(|d| !is_valid_date(d)) {
        return invalid("Due date must be a valid YYYY-MM-DD date");
    }
    if task.due_time.as_deref().is_some_and(|t| !is_valid_time(t)) {
        return invalid("Due time must be HH:MM");
    }
    if task.due_time.is_some() && task.due_date.is_none() {
        return invalid("A due time needs a due date");
    }
    let now = now_millis();
    conn.execute(
        "INSERT INTO tasks (id, title, notes, project_id, priority, due_date, due_time, remind, completed_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, notes = excluded.notes, project_id = excluded.project_id,
         priority = excluded.priority, due_date = excluded.due_date, due_time = excluded.due_time, remind = excluded.remind,
         completed_at = excluded.completed_at, updated_at = excluded.updated_at",
        params![
            task.id,
            title,
            task.notes,
            task.project_id,
            task.priority,
            task.due_date,
            task.due_time,
            task.remind && task.due_date.is_some(),
            task.completed_at,
            now
        ],
    )
    .map_err(map_fk)?;
    Ok(conn.query_row(
        "SELECT id, title, notes, project_id, priority, due_date, due_time, remind, completed_at, created_at, updated_at
         FROM tasks WHERE id = ?1",
        [&task.id],
        task_from_row,
    )?)
}

pub fn save_note(conn: &mut Connection, note: &Note) -> Result<Note, StorageError> {
    check_id(&note.id)?;
    check_project_ref(&note.project_id)?;
    if note.title.chars().count() > MAX_TITLE {
        return invalid(format!("Note title must be at most {MAX_TITLE} characters"));
    }
    if note.body.len() > MAX_NOTE_BODY {
        return invalid("Note is too long");
    }
    let now = now_millis();
    conn.execute(
        "INSERT INTO notes (id, title, body, project_id, pinned, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body, project_id = excluded.project_id,
         pinned = excluded.pinned, updated_at = excluded.updated_at",
        params![note.id, note.title.trim(), note.body, note.project_id, note.pinned, now],
    )
    .map_err(map_fk)?;
    Ok(conn.query_row(
        "SELECT id, title, body, project_id, pinned, created_at, updated_at FROM notes WHERE id = ?1",
        [&note.id],
        note_from_row,
    )?)
}

pub fn delete(conn: &mut Connection, table: Entity, id: &str) -> Result<(), StorageError> {
    check_id(id)?;
    let sql = match table {
        Entity::Project => "DELETE FROM projects WHERE id = ?1",
        Entity::Task => "DELETE FROM tasks WHERE id = ?1",
        Entity::Note => "DELETE FROM notes WHERE id = ?1",
    };
    conn.execute(sql, [id])?;
    Ok(())
}

#[derive(Clone, Copy)]
pub enum Entity {
    Project,
    Task,
    Note,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_connection;

    fn task(id: &str) -> Task {
        Task {
            id: id.into(),
            title: "Write report".into(),
            notes: String::new(),
            project_id: None,
            priority: 2,
            due_date: Some("2026-11-03".into()),
            due_time: Some("09:30".into()),
            remind: true,
            completed_at: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn validates_dates_and_times() {
        assert!(is_valid_date("2024-02-29"));
        assert!(!is_valid_date("2026-02-29"));
        assert!(!is_valid_date("2026-13-01"));
        assert!(!is_valid_date("26-1-1"));
        assert!(is_valid_time("23:59"));
        assert!(!is_valid_time("24:00"));
        assert!(!is_valid_time("9:30"));
    }

    #[test]
    fn upserts_tasks_and_keeps_created_at() {
        let mut conn = test_connection();
        let saved = save_task(&mut conn, &task("t1")).unwrap();
        assert!(saved.created_at > 0);
        let mut changed = saved.clone();
        changed.title = "Ship report".into();
        changed.completed_at = Some(123);
        let updated = save_task(&mut conn, &changed).unwrap();
        assert_eq!(updated.created_at, saved.created_at);
        assert_eq!(updated.title, "Ship report");
        assert_eq!(load(&mut conn).unwrap().tasks.len(), 1);
    }

    #[test]
    fn rejects_invalid_tasks() {
        let mut conn = test_connection();
        let cases = [
            Task { title: " ".into(), ..task("a") },
            Task { priority: 9, ..task("a") },
            Task { due_date: Some("2026-02-30".into()), ..task("a") },
            Task { due_date: None, ..task("a") },
            Task { project_id: Some("missing".into()), ..task("a") },
            Task { id: "bad id".into(), ..task("a") },
        ];
        for case in &cases {
            assert!(save_task(&mut conn, case).is_err(), "accepted {case:?}");
        }
        assert!(load(&mut conn).unwrap().tasks.is_empty());
    }

    #[test]
    fn deleting_a_project_keeps_its_tasks() {
        let mut conn = test_connection();
        let project = save_project(
            &mut conn,
            &Project { id: "p1".into(), name: "Home".into(), color: "#22d3ee".into(), archived: false, created_at: 0, updated_at: 0 },
        )
        .unwrap();
        save_task(&mut conn, &Task { project_id: Some(project.id.clone()), ..task("t1") }).unwrap();
        delete(&mut conn, Entity::Project, "p1").unwrap();
        let data = load(&mut conn).unwrap();
        assert!(data.projects.is_empty());
        assert_eq!(data.tasks[0].project_id, None);
    }

    #[test]
    fn saves_notes() {
        let mut conn = test_connection();
        let note = Note {
            id: "n1".into(),
            title: "Ideas".into(),
            body: "# Heading\n- point".into(),
            project_id: None,
            pinned: true,
            created_at: 0,
            updated_at: 0,
        };
        let saved = save_note(&mut conn, &note).unwrap();
        assert!(saved.pinned);
        assert_eq!(load(&mut conn).unwrap().notes, vec![saved]);
    }
}
