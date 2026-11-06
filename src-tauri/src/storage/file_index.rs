//! NOVA Finder's index: file metadata in `file_index`, names, folders and the
//! beginning of text files in the `file_index_fts` full-text table.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension, ToSql};
use serde::Serialize;

use super::StorageError;

pub struct IndexedFile {
    pub path: String,
    pub root: String,
    pub name: String,
    pub ext: String,
    pub folder: String,
    pub kind: &'static str,
    pub size: i64,
    pub modified: i64,
    pub created: i64,
    pub body: Option<String>,
}

/// path → (id, size, modified) of everything indexed under `root`.
pub fn known(conn: &Connection, root: &str) -> Result<HashMap<String, (i64, i64, i64)>, StorageError> {
    let mut stmt = conn.prepare("SELECT path, id, size, modified FROM file_index WHERE root = ?1")?;
    let rows = stmt.query_map([root], |row| Ok((row.get::<_, String>(0)?, (row.get(1)?, row.get(2)?, row.get(3)?))))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn upsert(conn: &Connection, file: &IndexedFile, seen: i64) -> Result<(), StorageError> {
    let existing: Option<i64> = conn.query_row("SELECT id FROM file_index WHERE path = ?1", [&file.path], |r| r.get(0)).optional()?;
    let id = match existing {
        Some(id) => {
            conn.execute(
                "UPDATE file_index SET root = ?2, name = ?3, ext = ?4, folder = ?5, kind = ?6, size = ?7, modified = ?8,
                 created = ?9, has_text = ?10, seen = ?11 WHERE id = ?1",
                params![id, file.root, file.name, file.ext, file.folder, file.kind, file.size, file.modified, file.created, file.body.is_some(), seen],
            )?;
            conn.execute("DELETE FROM file_index_fts WHERE rowid = ?1", [id])?;
            id
        }
        None => {
            conn.execute(
                "INSERT INTO file_index (path, root, name, ext, folder, kind, size, modified, created, has_text, seen)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![file.path, file.root, file.name, file.ext, file.folder, file.kind, file.size, file.modified, file.created, file.body.is_some(), seen],
            )?;
            conn.last_insert_rowid()
        }
    };
    conn.execute(
        "INSERT INTO file_index_fts (rowid, name, folder, body) VALUES (?1, ?2, ?3, ?4)",
        params![id, searchable_name(&file.name), file.folder, file.body.as_deref().unwrap_or("")],
    )?;
    Ok(())
}

/// "LEGO_Berechnung-v2.xlsx" also matches "berechnung v2": separators become spaces,
/// and camelCase words are split ("HogwartsCastle" → "Hogwarts Castle").
fn searchable_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len() * 2);
    let mut previous: Option<char> = None;
    for c in name.chars() {
        if let Some(p) = previous {
            if p.is_lowercase() && c.is_uppercase() {
                out.push(' ');
            }
        }
        out.push(if c == '_' || c == '-' || c == '.' { ' ' } else { c });
        previous = Some(c);
    }
    format!("{name} {out}")
}

/// Marks unchanged files as still present.
pub fn mark_seen(conn: &Connection, ids: &[i64], seen: i64) -> Result<(), StorageError> {
    let mut stmt = conn.prepare("UPDATE file_index SET seen = ?2 WHERE id = ?1")?;
    for id in ids {
        stmt.execute(params![id, seen])?;
    }
    Ok(())
}

/// Drops files under `root` that the last pass (`seen`) didn't find.
pub fn sweep(conn: &Connection, root: &str, seen: i64) -> Result<usize, StorageError> {
    // Together or not at all: without its search row a file would never be found again.
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM file_index_fts WHERE rowid IN (SELECT id FROM file_index WHERE root = ?1 AND seen <> ?2)",
        params![root, seen],
    )?;
    let removed = tx.execute("DELETE FROM file_index WHERE root = ?1 AND seen <> ?2", params![root, seen])?;
    tx.commit()?;
    Ok(removed)
}

pub fn remove_root(conn: &Connection, root: &str) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM file_index_fts WHERE rowid IN (SELECT id FROM file_index WHERE root = ?1)", [root])?;
    tx.execute("DELETE FROM file_index WHERE root = ?1", [root])?;
    tx.commit()?;
    Ok(())
}

pub fn count_by_root(conn: &Connection) -> Result<HashMap<String, i64>, StorageError> {
    let mut stmt = conn.prepare("SELECT root, count(*) FROM file_index GROUP BY root")?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[derive(Debug, Default, Clone)]
pub struct Query {
    /// Words to look for in names, folders and text content.
    pub terms: Vec<String>,
    pub kind: Option<String>,
    pub ext: Option<String>,
    pub modified_after: Option<i64>,
    pub modified_before: Option<i64>,
    /// Part of the folder path, e.g. "Downloads".
    pub folder: Option<String>,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub path: String,
    pub name: String,
    pub ext: String,
    pub folder: String,
    pub kind: String,
    pub size: i64,
    pub modified: i64,
    /// Where a content match was found, for text files.
    pub snippet: Option<String>,
}

/// The content excerpt, only when the search words matched inside the text
/// (FTS5 returns the beginning of the text otherwise). Single line, markers removed.
fn content_match(snippet: &str) -> Option<String> {
    if !snippet.contains('\u{2}') {
        return None;
    }
    let clean: String = snippet.replace(['\u{2}', '\u{3}'], "").split_whitespace().collect::<Vec<_>>().join(" ");
    (!clean.is_empty()).then_some(clean)
}

/// `"term"*` per word; quotes inside terms are doubled as FTS5 requires.
fn fts_expression(terms: &[String], joiner: &str) -> String {
    terms
        .iter()
        .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(joiner)
}

pub fn search(conn: &Connection, query: &Query) -> Result<Vec<FileHit>, StorageError> {
    let limit = query.limit.clamp(1, 50) as i64;
    let folder = query.folder.as_ref().map(|f| format!("%{}%", f.replace('%', "")));
    let filters = "(?2 IS NULL OR f.kind = ?2) AND (?3 IS NULL OR f.ext = ?3) AND (?4 IS NULL OR f.modified >= ?4)
                   AND (?5 IS NULL OR f.modified <= ?5) AND (?6 IS NULL OR f.folder LIKE ?6)";
    let terms: Vec<String> = query.terms.iter().map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty()).take(8).collect();

    let run = |sql: &str, first: &dyn ToSql| -> Result<Vec<FileHit>, StorageError> {
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(
            params![first, query.kind, query.ext, query.modified_after, query.modified_before, folder, limit],
            |row| {
                Ok(FileHit {
                    path: row.get(0)?,
                    name: row.get(1)?,
                    ext: row.get(2)?,
                    folder: row.get(3)?,
                    kind: row.get(4)?,
                    size: row.get(5)?,
                    modified: row.get(6)?,
                    snippet: row.get::<_, Option<String>>(7)?.as_deref().and_then(content_match),
                })
            },
        )?;
        Ok(rows.collect::<Result<_, _>>()?)
    };

    if terms.is_empty() {
        // Filters only ("presentations from last week"): newest first.
        let sql = format!(
            "SELECT f.path, f.name, f.ext, f.folder, f.kind, f.size, f.modified, NULL FROM file_index f
             WHERE ?1 IS NULL AND {filters} ORDER BY f.modified DESC LIMIT ?7"
        );
        return run(&sql, &Option::<String>::None);
    }

    // Names weigh most, then folders, then content; recent files win ties.
    let sql = format!(
        "SELECT f.path, f.name, f.ext, f.folder, f.kind, f.size, f.modified,
                CASE WHEN f.has_text THEN snippet(file_index_fts, 2, char(2), char(3), '…', 10) END
         FROM file_index_fts JOIN file_index f ON f.id = file_index_fts.rowid
         WHERE file_index_fts MATCH ?1 AND {filters}
         ORDER BY bm25(file_index_fts, 10.0, 3.0, 1.0) - f.modified / 1e13 LIMIT ?7"
    );
    let all = run(&sql, &fts_expression(&terms, " AND "))?;
    if !all.is_empty() || terms.len() == 1 {
        return Ok(all);
    }
    // Approximate descriptions: fall back to any of the words.
    run(&sql, &fts_expression(&terms, " OR "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, kind: &'static str, modified: i64, body: Option<&str>) -> IndexedFile {
        let name = path.rsplit('\\').next().unwrap().to_string();
        let ext = name.rsplit('.').next().unwrap().to_lowercase();
        IndexedFile {
            path: path.into(),
            root: "C:\\Users\\me".into(),
            name,
            ext,
            folder: path.rsplit_once('\\').unwrap().0.into(),
            kind,
            size: 10,
            modified,
            created: modified,
            body: body.map(str::to_string),
        }
    }

    fn db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        super::super::migrations::migrate(&mut conn).unwrap();
        upsert(&conn, &file("C:\\Users\\me\\Documents\\LEGO_Berechnung_v2.xlsx", "spreadsheet", 300, None), 1).unwrap();
        upsert(&conn, &file("C:\\Users\\me\\Documents\\Old\\LEGO_Berechnung_v1.xlsx", "spreadsheet", 100, None), 1).unwrap();
        upsert(&conn, &file("C:\\Users\\me\\Downloads\\Drucker.pdf", "pdf", 200, None), 1).unwrap();
        upsert(&conn, &file("C:\\Users\\me\\Documents\\notes.md", "document", 50, Some("Mein 3D-Drucker braucht neues Filament")), 1).unwrap();
        conn
    }

    fn names(hits: &[FileHit]) -> Vec<&str> {
        hits.iter().map(|h| h.name.as_str()).collect()
    }

    #[test]
    fn finds_by_name_words_prefixes_and_content() {
        let conn = db();
        let q = |terms: &[&str]| Query { terms: terms.iter().map(|t| t.to_string()).collect(), limit: 10, ..Query::default() };
        let lego = search(&conn, &q(&["lego", "berechnung"])).unwrap();
        assert_eq!(names(&lego), ["LEGO_Berechnung_v2.xlsx", "LEGO_Berechnung_v1.xlsx"], "newer first on equal relevance");
        assert_eq!(names(&search(&conn, &q(&["berech"])).unwrap()).len(), 2, "prefix match");
        let content = search(&conn, &q(&["filament"])).unwrap();
        assert_eq!(names(&content), ["notes.md"]);
        assert_eq!(content[0].snippet.as_deref(), Some("Mein 3D-Drucker braucht neues Filament"));
        // A name match shows no content excerpt.
        let by_name = search(&conn, &q(&["notes"])).unwrap();
        assert_eq!(by_name[0].snippet, None);
        // No file has both words: falls back to either.
        assert_eq!(names(&search(&conn, &q(&["drucker", "lego"])).unwrap()).len(), 4);
    }

    #[test]
    fn filters_by_kind_date_and_folder() {
        let conn = db();
        let pdfs = search(&conn, &Query { kind: Some("pdf".into()), limit: 10, ..Query::default() }).unwrap();
        assert_eq!(names(&pdfs), ["Drucker.pdf"]);
        let recent = search(&conn, &Query { modified_after: Some(150), limit: 10, ..Query::default() }).unwrap();
        assert_eq!(names(&recent), ["LEGO_Berechnung_v2.xlsx", "Drucker.pdf"]);
        let old = search(&conn, &Query { terms: vec!["lego".into()], folder: Some("Old".into()), limit: 10, ..Query::default() }).unwrap();
        assert_eq!(names(&old), ["LEGO_Berechnung_v1.xlsx"]);
    }

    #[test]
    fn updates_and_sweeps_files() {
        let conn = db();
        let known = known(&conn, "C:\\Users\\me").unwrap();
        assert_eq!(known.len(), 4);
        let keep: Vec<i64> = known.iter().filter(|(p, _)| p.contains("LEGO")).map(|(_, v)| v.0).collect();
        mark_seen(&conn, &keep, 2).unwrap();
        assert_eq!(sweep(&conn, "C:\\Users\\me", 2).unwrap(), 2);
        assert!(search(&conn, &Query { terms: vec!["filament".into()], limit: 5, ..Query::default() }).unwrap().is_empty());
        assert_eq!(count_by_root(&conn).unwrap()["C:\\Users\\me"], 2);
        remove_root(&conn, "C:\\Users\\me").unwrap();
        assert!(count_by_root(&conn).unwrap().is_empty());
    }
}
