//! Dashboard layouts and their widget instances.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{is_identifier, now_millis, StorageError};

pub const MAX_WIDGETS_PER_LAYOUT: usize = 48;
const MAX_NAME_CHARS: usize = 40;
const MAX_CONFIG_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutWidget {
    pub instance_id: String,
    pub widget_id: String,
    pub w: u8,
    pub h: u8,
    #[serde(default)]
    pub config: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardLayout {
    pub id: String,
    pub name: String,
    pub widgets: Vec<LayoutWidget>,
}

pub fn validate(layout: &DashboardLayout) -> Result<(), StorageError> {
    let invalid = |msg: String| Err(StorageError::Invalid(msg));

    if !is_identifier(&layout.id, 64) {
        return invalid(format!("invalid layout id \"{}\"", layout.id));
    }
    let name_chars = layout.name.trim().chars().count();
    if name_chars == 0 || name_chars > MAX_NAME_CHARS {
        return invalid(format!("layout name must be 1–{MAX_NAME_CHARS} characters"));
    }
    if layout.widgets.len() > MAX_WIDGETS_PER_LAYOUT {
        return invalid(format!("a layout can hold at most {MAX_WIDGETS_PER_LAYOUT} widgets"));
    }

    let mut seen = HashSet::new();
    for widget in &layout.widgets {
        if !is_identifier(&widget.instance_id, 64) || !seen.insert(widget.instance_id.as_str()) {
            return invalid(format!("invalid or duplicate widget instance id \"{}\"", widget.instance_id));
        }
        if !is_identifier(&widget.widget_id, 40) {
            return invalid(format!("invalid widget type \"{}\"", widget.widget_id));
        }
        if !(1..=12).contains(&widget.w) || !(1..=8).contains(&widget.h) {
            return invalid(format!("widget \"{}\" has an invalid size {}×{}", widget.instance_id, widget.w, widget.h));
        }
        let config_len = serde_json::to_string(&widget.config).map(|s| s.len()).unwrap_or(usize::MAX);
        if config_len > MAX_CONFIG_BYTES {
            return invalid(format!("configuration for \"{}\" is too large", widget.instance_id));
        }
    }
    Ok(())
}

pub fn list(conn: &Connection) -> Result<Vec<DashboardLayout>, StorageError> {
    let mut layouts_stmt =
        conn.prepare("SELECT id, name FROM dashboard_layouts ORDER BY position, created_at")?;
    let mut widgets_stmt = conn.prepare(
        "SELECT id, widget_type, width, height, config FROM dashboard_widgets
         WHERE layout_id = ?1 ORDER BY position",
    )?;

    let rows = layouts_stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    let mut layouts = Vec::new();
    for row in rows {
        let (id, name) = row?;
        let widgets = widgets_stmt
            .query_map([&id], |row| {
                let config: String = row.get(4)?;
                Ok(LayoutWidget {
                    instance_id: row.get(0)?,
                    widget_id: row.get(1)?,
                    w: row.get(2)?,
                    h: row.get(3)?,
                    // A corrupted config degrades to defaults instead of hiding the layout.
                    config: serde_json::from_str(&config).unwrap_or_default(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        layouts.push(DashboardLayout { id, name, widgets });
    }
    Ok(layouts)
}

/// Inserts or replaces a layout and all of its widgets atomically.
pub fn save(conn: &mut Connection, layout: &DashboardLayout) -> Result<(), StorageError> {
    validate(layout)?;
    let now = now_millis();
    let tx = conn.transaction()?;

    let exists = tx
        .query_row("SELECT 1 FROM dashboard_layouts WHERE id = ?1", [&layout.id], |_| Ok(()))
        .optional()?
        .is_some();
    if exists {
        tx.execute(
            "UPDATE dashboard_layouts SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![layout.id, layout.name.trim(), now],
        )?;
    } else {
        tx.execute(
            "INSERT INTO dashboard_layouts (id, name, position, created_at, updated_at)
             VALUES (?1, ?2, (SELECT coalesce(max(position) + 1, 0) FROM dashboard_layouts), ?3, ?3)",
            params![layout.id, layout.name.trim(), now],
        )?;
    }

    tx.execute("DELETE FROM dashboard_widgets WHERE layout_id = ?1", [&layout.id])?;
    {
        let mut insert = tx.prepare(
            "INSERT INTO dashboard_widgets (layout_id, id, widget_type, position, width, height, config)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for (position, widget) in layout.widgets.iter().enumerate() {
            insert.execute(params![
                layout.id,
                widget.instance_id,
                widget.widget_id,
                position as i64,
                widget.w,
                widget.h,
                serde_json::to_string(&widget.config).unwrap_or_else(|_| "{}".into()),
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> Result<(), StorageError> {
    if !is_identifier(id, 64) {
        return Err(StorageError::Invalid(format!("invalid layout id \"{id}\"")));
    }
    conn.execute("DELETE FROM dashboard_layouts WHERE id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_connection;

    fn widget(id: &str, kind: &str, w: u8, h: u8) -> LayoutWidget {
        LayoutWidget { instance_id: id.into(), widget_id: kind.into(), w, h, config: Map::new() }
    }

    fn sample(id: &str) -> DashboardLayout {
        DashboardLayout {
            id: id.into(),
            name: "Default".into(),
            widgets: vec![widget("w1", "welcome", 8, 2), widget("w2", "cpu", 4, 3)],
        }
    }

    #[test]
    fn saves_and_lists_layouts_in_order() {
        let mut conn = test_connection();
        let mut first = sample("first");
        first.widgets[1].config.insert("showChart".into(), Value::Bool(false));
        save(&mut conn, &first).unwrap();
        save(&mut conn, &DashboardLayout { name: "Gaming".into(), ..sample("second") }).unwrap();

        let layouts = list(&conn).unwrap();
        assert_eq!(layouts.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), ["first", "second"]);
        assert_eq!(layouts[0], first);
    }

    #[test]
    fn saving_replaces_widgets_and_keeps_position() {
        let mut conn = test_connection();
        save(&mut conn, &sample("a")).unwrap();
        save(&mut conn, &sample("b")).unwrap();

        let mut updated = sample("a");
        updated.name = "Renamed".into();
        updated.widgets = vec![widget("w9", "storage", 12, 2)];
        save(&mut conn, &updated).unwrap();

        let layouts = list(&conn).unwrap();
        assert_eq!(layouts[0].id, "a", "updating must not move the layout to the end");
        assert_eq!(layouts[0].name, "Renamed");
        assert_eq!(layouts[0].widgets, vec![widget("w9", "storage", 12, 2)]);
    }

    #[test]
    fn same_instance_ids_may_exist_in_different_layouts() {
        let mut conn = test_connection();
        save(&mut conn, &sample("a")).unwrap();
        save(&mut conn, &sample("b")).unwrap();
        assert_eq!(list(&conn).unwrap().len(), 2);
    }

    #[test]
    fn deleting_a_layout_removes_its_widgets() {
        let mut conn = test_connection();
        save(&mut conn, &sample("a")).unwrap();
        delete(&conn, "a").unwrap();
        let orphans: i64 = conn.query_row("SELECT count(*) FROM dashboard_widgets", [], |r| r.get(0)).unwrap();
        assert!(list(&conn).unwrap().is_empty());
        assert_eq!(orphans, 0);
    }

    #[test]
    fn rejects_invalid_layouts_without_writing() {
        let mut conn = test_connection();
        let cases = [
            DashboardLayout { id: "bad id!".into(), ..sample("x") },
            DashboardLayout { name: "   ".into(), ..sample("x") },
            DashboardLayout { widgets: vec![widget("w1", "cpu", 13, 2)], ..sample("x") },
            DashboardLayout { widgets: vec![widget("w1", "cpu", 4, 0)], ..sample("x") },
            DashboardLayout { widgets: vec![widget("w1", "cpu", 4, 2), widget("w1", "ram", 4, 2)], ..sample("x") },
            DashboardLayout { widgets: vec![widget("w1", "<script>", 4, 2)], ..sample("x") },
        ];
        for case in &cases {
            assert!(save(&mut conn, case).is_err(), "accepted {case:?}");
        }
        assert!(list(&conn).unwrap().is_empty());
    }
}
