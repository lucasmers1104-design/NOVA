//! The local log of actions NOVA AI took (or was refused), shown in its history.

use rusqlite::{params, Connection};
use serde::Serialize;

use super::{now_millis, StorageError};

/// Older entries are pruned beyond this many.
const MAX_ENTRIES: i64 = 2000;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionEntry {
    pub id: i64,
    pub at: i64,
    pub tool: String,
    pub title: String,
    pub risk: String,
    pub status: String,
    pub detail: String,
}

pub fn log(conn: &Connection, tool: &str, title: &str, risk: &str, status: &str, detail: &str) -> Result<(), StorageError> {
    let title: String = title.chars().take(300).collect();
    let detail: String = detail.chars().take(2000).collect();
    conn.execute(
        "INSERT INTO assistant_actions (at, tool, title, risk, status, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![now_millis(), tool, title, risk, status, detail],
    )?;
    conn.execute(
        "DELETE FROM assistant_actions WHERE id <= (SELECT max(id) FROM assistant_actions) - ?1",
        [MAX_ENTRIES],
    )?;
    Ok(())
}

pub fn list(conn: &Connection, limit: usize) -> Result<Vec<ActionEntry>, StorageError> {
    let mut stmt = conn.prepare("SELECT id, at, tool, title, risk, status, detail FROM assistant_actions ORDER BY id DESC LIMIT ?1")?;
    let rows = stmt.query_map([limit.min(500) as i64], |row| {
        Ok(ActionEntry {
            id: row.get(0)?,
            at: row.get(1)?,
            tool: row.get(2)?,
            title: row.get(3)?,
            risk: row.get(4)?,
            status: row.get(5)?,
            detail: row.get(6)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn clear(conn: &Connection) -> Result<(), StorageError> {
    conn.execute("DELETE FROM assistant_actions", [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logs_newest_first_and_validates_values() {
        let mut conn = Connection::open_in_memory().unwrap();
        super::super::migrations::migrate(&mut conn).unwrap();
        log(&conn, "search_files", "Searched for “lego”", "safe", "done", "4 results").unwrap();
        log(&conn, "delete_file", "Move a.txt to the Recycle Bin", "high", "declined", "").unwrap();
        let entries = list(&conn, 10).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].tool, "delete_file");
        assert_eq!(entries[0].status, "declined");
        assert!(log(&conn, "x", "y", "risky", "done", "").is_err(), "the CHECK constraint rejects unknown risk levels");
        clear(&conn).unwrap();
        assert!(list(&conn, 10).unwrap().is_empty());
    }
}
