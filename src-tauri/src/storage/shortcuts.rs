//! User-added application shortcuts (paths picked through the native file dialog).

use rusqlite::{params, Connection, OptionalExtension};

use super::{new_id, now_millis, StorageError};

#[derive(Debug, Clone, PartialEq)]
pub struct Shortcut {
    pub id: String,
    pub name: String,
    pub path: String,
}

pub fn list(conn: &mut Connection) -> Result<Vec<Shortcut>, StorageError> {
    let mut stmt = conn.prepare("SELECT id, name, path FROM application_shortcuts ORDER BY name COLLATE NOCASE")?;
    let rows = stmt.query_map([], |r| Ok(Shortcut { id: r.get(0)?, name: r.get(1)?, path: r.get(2)? }))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(conn: &mut Connection, id: &str) -> Result<Option<Shortcut>, StorageError> {
    Ok(conn
        .query_row("SELECT id, name, path FROM application_shortcuts WHERE id = ?1", [id], |r| {
            Ok(Shortcut { id: r.get(0)?, name: r.get(1)?, path: r.get(2)? })
        })
        .optional()?)
}

pub fn insert(conn: &mut Connection, name: &str, path: &str) -> Result<Shortcut, StorageError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(StorageError::Invalid("App name must be 1–80 characters".into()));
    }
    if path.len() > 1024 {
        return Err(StorageError::Invalid("Path is too long".into()));
    }
    let shortcut = Shortcut { id: new_id("custom"), name: name.to_string(), path: path.to_string() };
    conn.execute(
        "INSERT INTO application_shortcuts (id, name, path, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![shortcut.id, shortcut.name, shortcut.path, now_millis()],
    )?;
    Ok(shortcut)
}

pub fn delete(conn: &mut Connection, id: &str) -> Result<(), StorageError> {
    conn.execute("DELETE FROM application_shortcuts WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_connection;

    #[test]
    fn adds_lists_and_removes_shortcuts() {
        let mut conn = test_connection();
        let added = insert(&mut conn, "  Tool  ", "C:\\Tools\\tool.exe").unwrap();
        assert_eq!(added.name, "Tool");
        assert_eq!(list(&mut conn).unwrap(), vec![added.clone()]);
        assert_eq!(get(&mut conn, &added.id).unwrap(), Some(added.clone()));
        delete(&mut conn, &added.id).unwrap();
        assert!(list(&mut conn).unwrap().is_empty());
    }

    #[test]
    fn rejects_empty_names() {
        let mut conn = test_connection();
        assert!(insert(&mut conn, "   ", "C:\\a.exe").is_err());
    }
}
