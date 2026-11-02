//! Key/value settings store. Values are JSON documents validated by the
//! frontend's typed sanitizers; here we only enforce shape and size limits.

use rusqlite::{params, Connection, OptionalExtension};

use super::{now_millis, StorageError};

const MAX_KEY_LEN: usize = 64;
const MAX_VALUE_BYTES: usize = 256 * 1024;

fn validate_key(key: &str) -> Result<(), StorageError> {
    let valid = !key.is_empty()
        && key.len() <= MAX_KEY_LEN
        && key.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-'));
    if valid {
        Ok(())
    } else {
        Err(StorageError::Invalid(format!("invalid settings key \"{key}\"")))
    }
}

pub fn get(conn: &Connection, key: &str) -> Result<Option<String>, StorageError> {
    validate_key(key)?;
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| row.get(0))
        .optional()?)
}

pub fn set(conn: &Connection, key: &str, value: &str) -> Result<(), StorageError> {
    validate_key(key)?;
    if value.len() > MAX_VALUE_BYTES {
        return Err(StorageError::Invalid(format!("value for \"{key}\" exceeds {MAX_VALUE_BYTES} bytes")));
    }
    serde_json::from_str::<serde_json::Value>(value)
        .map_err(|e| StorageError::Invalid(format!("value for \"{key}\" is not valid JSON: {e}")))?;
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now_millis()],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, key: &str) -> Result<(), StorageError> {
    validate_key(key)?;
    conn.execute("DELETE FROM settings WHERE key = ?1", [key])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_connection;

    #[test]
    fn round_trips_json_values() {
        let conn = test_connection();
        assert_eq!(get(&conn, "nova.settings").unwrap(), None);
        set(&conn, "nova.settings", r#"{"state":{"accent":"blue"}}"#).unwrap();
        set(&conn, "nova.settings", r#"{"state":{"accent":"cyan"}}"#).unwrap();
        assert_eq!(get(&conn, "nova.settings").unwrap().as_deref(), Some(r#"{"state":{"accent":"cyan"}}"#));
        delete(&conn, "nova.settings").unwrap();
        assert_eq!(get(&conn, "nova.settings").unwrap(), None);
    }

    #[test]
    fn rejects_malformed_keys_and_values() {
        let conn = test_connection();
        assert!(set(&conn, "", "1").is_err());
        assert!(set(&conn, "Upper", "1").is_err());
        assert!(set(&conn, "../etc", "1").is_err());
        assert!(set(&conn, &"k".repeat(65), "1").is_err());
        assert!(set(&conn, "ok", "{not json").is_err());
        assert!(set(&conn, "ok", &format!("\"{}\"", "x".repeat(MAX_VALUE_BYTES))).is_err());
    }
}
