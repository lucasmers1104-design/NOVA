//! Versioned schema migrations tracked with SQLite's `user_version` pragma.
//!
//! Each migration runs in its own transaction, so a failure leaves the
//! database exactly at the last good version. Migrations are append-only:
//! never edit one that has shipped — add a new one instead.

use rusqlite::Connection;

use super::StorageError;

pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
}

pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "settings_and_dashboards",
        sql: r#"
        CREATE TABLE settings (
            key         TEXT PRIMARY KEY NOT NULL,
            value       TEXT NOT NULL,
            updated_at  INTEGER NOT NULL
        );

        CREATE TABLE dashboard_layouts (
            id          TEXT PRIMARY KEY NOT NULL,
            name        TEXT NOT NULL,
            position    INTEGER NOT NULL,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        );

        CREATE TABLE dashboard_widgets (
            layout_id   TEXT NOT NULL REFERENCES dashboard_layouts(id) ON DELETE CASCADE,
            id          TEXT NOT NULL,
            widget_type TEXT NOT NULL,
            position    INTEGER NOT NULL,
            width       INTEGER NOT NULL CHECK (width BETWEEN 1 AND 12),
            height      INTEGER NOT NULL CHECK (height BETWEEN 1 AND 8),
            config      TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (layout_id, id)
        );

        CREATE INDEX idx_dashboard_widgets_order ON dashboard_widgets(layout_id, position);
    "#,
    },
    Migration {
        version: 2,
        name: "apps_productivity_ai",
        sql: r#"
        CREATE TABLE application_shortcuts (
            id          TEXT PRIMARY KEY NOT NULL,
            name        TEXT NOT NULL,
            path        TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        );

        CREATE TABLE projects (
            id          TEXT PRIMARY KEY NOT NULL,
            name        TEXT NOT NULL,
            color       TEXT NOT NULL DEFAULT '',
            archived    INTEGER NOT NULL DEFAULT 0,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        );

        CREATE TABLE tasks (
            id           TEXT PRIMARY KEY NOT NULL,
            title        TEXT NOT NULL,
            notes        TEXT NOT NULL DEFAULT '',
            project_id   TEXT REFERENCES projects(id) ON DELETE SET NULL,
            priority     INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
            due_date     TEXT,
            due_time     TEXT,
            remind       INTEGER NOT NULL DEFAULT 0,
            completed_at INTEGER,
            created_at   INTEGER NOT NULL,
            updated_at   INTEGER NOT NULL
        );
        CREATE INDEX idx_tasks_due ON tasks(due_date);
        CREATE INDEX idx_tasks_project ON tasks(project_id);

        CREATE TABLE notes (
            id          TEXT PRIMARY KEY NOT NULL,
            title       TEXT NOT NULL,
            body        TEXT NOT NULL DEFAULT '',
            project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
            pinned      INTEGER NOT NULL DEFAULT 0,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        );

        CREATE TABLE ai_conversations (
            id          TEXT PRIMARY KEY NOT NULL,
            title       TEXT NOT NULL,
            provider    TEXT NOT NULL,
            model       TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        );

        CREATE TABLE ai_messages (
            id              TEXT PRIMARY KEY NOT NULL,
            conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
            role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
            content         TEXT NOT NULL,
            error           TEXT,
            created_at      INTEGER NOT NULL
        );
        CREATE INDEX idx_ai_messages_conversation ON ai_messages(conversation_id, created_at);
    "#,
    },
    Migration {
        version: 3,
        name: "assistant_usage_actions_file_index",
        sql: r#"
        CREATE TABLE ai_usage (
            id            INTEGER PRIMARY KEY,
            at            INTEGER NOT NULL,
            provider      TEXT NOT NULL,
            model         TEXT NOT NULL,
            input_tokens  INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            -- Estimated US dollars × 1,000,000; NULL when NOVA has no price for the model.
            cost_micros   INTEGER
        );
        CREATE INDEX idx_ai_usage_at ON ai_usage(at);

        CREATE TABLE assistant_actions (
            id      INTEGER PRIMARY KEY,
            at      INTEGER NOT NULL,
            tool    TEXT NOT NULL,
            title   TEXT NOT NULL,
            risk    TEXT NOT NULL CHECK (risk IN ('safe', 'confirm', 'high')),
            status  TEXT NOT NULL CHECK (status IN ('done', 'failed', 'declined')),
            detail  TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX idx_assistant_actions_at ON assistant_actions(at);

        CREATE TABLE file_index (
            id        INTEGER PRIMARY KEY,
            path      TEXT NOT NULL UNIQUE,
            root      TEXT NOT NULL,
            name      TEXT NOT NULL,
            ext       TEXT NOT NULL,
            folder    TEXT NOT NULL,
            kind      TEXT NOT NULL,
            size      INTEGER NOT NULL,
            modified  INTEGER NOT NULL,
            created   INTEGER NOT NULL,
            has_text  INTEGER NOT NULL DEFAULT 0,
            seen      INTEGER NOT NULL
        );
        CREATE INDEX idx_file_index_root ON file_index(root);
        CREATE INDEX idx_file_index_modified ON file_index(modified);
        -- rowid = file_index.id. Names, folders and (for text files) the first part of the content.
        CREATE VIRTUAL TABLE file_index_fts USING fts5(name, folder, body, tokenize = 'unicode61 remove_diacritics 2');
    "#,
    },
    Migration {
        version: 4,
        name: "plugins",
        sql: r#"
        CREATE TABLE plugins (
            id           TEXT PRIMARY KEY NOT NULL,
            version      TEXT NOT NULL,
            manifest     TEXT NOT NULL,
            signer       TEXT NOT NULL,
            enabled      INTEGER NOT NULL DEFAULT 1,
            -- JSON array of the permission keys the user allowed.
            granted      TEXT NOT NULL DEFAULT '[]',
            crashes      INTEGER NOT NULL DEFAULT 0,
            last_error   TEXT,
            installed_at INTEGER NOT NULL,
            updated_at   INTEGER NOT NULL
        );

        CREATE TABLE plugin_storage (
            plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
            key       TEXT NOT NULL,
            value     TEXT NOT NULL,
            PRIMARY KEY (plugin_id, key)
        ) WITHOUT ROWID;
    "#,
    },
];

#[cfg(test)]
pub fn latest_version() -> i64 {
    MIGRATIONS.last().map_or(0, |m| m.version)
}

pub fn schema_version(conn: &Connection) -> Result<i64, StorageError> {
    Ok(conn.pragma_query_value(None, "user_version", |row| row.get(0))?)
}

pub fn migrate(conn: &mut Connection) -> Result<i64, StorageError> {
    migrate_with(conn, MIGRATIONS)
}

pub(crate) fn migrate_with(conn: &mut Connection, migrations: &[Migration]) -> Result<i64, StorageError> {
    let current = schema_version(conn)?;
    let latest = migrations.last().map_or(0, |m| m.version);
    // A database written by a newer NOVA is left untouched rather than
    // "repaired" into something the newer version can no longer read.
    if current > latest {
        return Err(StorageError::NewerSchema { found: current, supported: latest });
    }

    for migration in migrations.iter().filter(|m| m.version > current) {
        let tx = conn.transaction()?;
        tx.execute_batch(migration.sql).map_err(|source| StorageError::Migration {
            version: migration.version,
            name: migration.name,
            source,
        })?;
        tx.pragma_update(None, "user_version", migration.version)?;
        tx.commit()?;
    }
    Ok(latest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table_exists(conn: &Connection, name: &str) -> bool {
        conn.query_row("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1", [name], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap()
            == 1
    }

    #[test]
    fn migrates_a_fresh_database_to_the_latest_version() {
        let mut conn = Connection::open_in_memory().unwrap();
        assert_eq!(migrate(&mut conn).unwrap(), latest_version());
        assert_eq!(schema_version(&conn).unwrap(), latest_version());
        for table in [
            "settings",
            "dashboard_layouts",
            "dashboard_widgets",
            "application_shortcuts",
            "projects",
            "tasks",
            "notes",
            "ai_conversations",
            "ai_messages",
            "ai_usage",
            "assistant_actions",
            "file_index",
            "file_index_fts",
            "plugins",
            "plugin_storage",
        ] {
            assert!(table_exists(&conn, table), "missing table {table}");
        }
    }

    #[test]
    fn rerunning_migrations_is_a_no_op() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        conn.execute("INSERT INTO settings VALUES ('k', '1', 0)", []).unwrap();
        migrate(&mut conn).unwrap();
        let count: i64 = conn.query_row("SELECT count(*) FROM settings", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn upgrades_a_version_1_database_without_losing_data() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate_with(&mut conn, &MIGRATIONS[..1]).unwrap();
        conn.execute("INSERT INTO settings VALUES ('nova.settings', '{}', 0)", []).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), 1);

        migrate(&mut conn).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), latest_version());
        let kept: i64 = conn.query_row("SELECT count(*) FROM settings", [], |r| r.get(0)).unwrap();
        assert_eq!(kept, 1);
        assert!(table_exists(&conn, "tasks"));
    }

    #[test]
    fn refuses_databases_from_a_newer_version() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", 99).unwrap();
        let err = migrate(&mut conn).unwrap_err();
        assert!(matches!(err, StorageError::NewerSchema { found: 99, .. }));
        assert_eq!(schema_version(&conn).unwrap(), 99);
    }

    #[test]
    fn failed_migration_rolls_back_completely() {
        const BROKEN: &[Migration] = &[
            Migration { version: 1, name: "ok", sql: "CREATE TABLE a (x INTEGER);" },
            Migration { version: 2, name: "broken", sql: "CREATE TABLE b (x INTEGER); THIS IS NOT SQL;" },
        ];
        let mut conn = Connection::open_in_memory().unwrap();
        let err = migrate_with(&mut conn, BROKEN).unwrap_err();

        assert!(matches!(err, StorageError::Migration { version: 2, .. }));
        assert_eq!(schema_version(&conn).unwrap(), 1);
        assert!(table_exists(&conn, "a"));
        assert!(!table_exists(&conn, "b"), "partial migration must not persist");
    }
}
