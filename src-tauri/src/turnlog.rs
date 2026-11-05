//! Timings of NOVA's spoken turns, kept in `voice-turns.jsonl` (the last few
//! hundred lines) and `voice-last-reply.txt` in NOVA's local data folder, so
//! a slow or failed turn can be explained. Only milliseconds, counts and
//! engine names are stored — never what was said.

use std::collections::BTreeMap;
use std::io::Write;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

const LOG_FILE: &str = "voice-turns.jsonl";
const LAST_REPLY_FILE: &str = "voice-last-reply.txt";
/// Lines kept in the log; older ones are dropped when it grows past twice this.
const KEEP_LINES: usize = 200;
const MAX_ENTRIES: usize = 64;

/// What the panel measured during one turn.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendTurn {
    kind: String,
    /// Unix time (ms) the turn started.
    started: f64,
    /// Milliseconds after `started`.
    marks: BTreeMap<String, f64>,
    counts: BTreeMap<String, f64>,
    notes: BTreeMap<String, String>,
}

fn clean_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 40 && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

impl FrontendTurn {
    /// Keeps plain identifiers, finite numbers and short notes only.
    fn sanitized(self) -> Value {
        let numbers = |map: BTreeMap<String, f64>| -> BTreeMap<String, i64> {
            map.into_iter().filter(|(k, v)| clean_key(k) && v.is_finite()).take(MAX_ENTRIES).map(|(k, v)| (k, v.round() as i64)).collect()
        };
        let notes: BTreeMap<String, String> = self
            .notes
            .into_iter()
            .filter(|(k, _)| clean_key(k))
            .take(MAX_ENTRIES)
            .map(|(k, v)| (k, v.chars().filter(|c| !c.is_control()).take(60).collect()))
            .collect();
        let kind: String = self.kind.chars().filter(char::is_ascii_alphanumeric).take(20).collect();
        json!({
            "source": "panel",
            "kind": kind,
            "started": if self.started.is_finite() { self.started.round() as i64 } else { 0 },
            "marks": numbers(self.marks),
            "counts": numbers(self.counts),
            "notes": notes,
        })
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Appends one record (with the time it was written) to the turn log.
pub fn append<R: Runtime>(app: &AppHandle<R>, mut record: Value) {
    let Ok(dir) = app.path().app_local_data_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    record["at"] = json!(now_ms());
    let path = dir.join(LOG_FILE);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{record}");
    }
    trim(&path);
}

fn trim(path: &std::path::Path) {
    let Ok(text) = std::fs::read_to_string(path) else { return };
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() > KEEP_LINES * 2 {
        let kept = lines[lines.len() - KEEP_LINES..].join("\n");
        let _ = std::fs::write(path, kept + "\n");
    }
}

/// A readable version of a panel turn: marks in time order.
fn render(record: &Value) -> String {
    let mut out = format!("NOVA reply timings ({} turn, unix ms {})\n", record["kind"].as_str().unwrap_or("?"), record["started"]);
    let mut marks: Vec<(&String, i64)> = record["marks"].as_object().map(|m| m.iter().filter_map(|(k, v)| Some((k, v.as_i64()?))).collect()).unwrap_or_default();
    marks.sort_by_key(|(_, v)| *v);
    for (name, at) in marks {
        out.push_str(&format!("{at:>7} ms  {name}\n"));
    }
    for (section, value) in [("counts", &record["counts"]), ("notes", &record["notes"])] {
        if let Some(map) = value.as_object().filter(|m| !m.is_empty()) {
            out.push_str(&format!("{section}:\n"));
            for (k, v) in map {
                out.push_str(&format!("  {k}: {}\n", v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())));
            }
        }
    }
    out
}

/// The panel reports a finished turn.
#[tauri::command]
pub async fn voice_report_turn<R: Runtime>(app: AppHandle<R>, report: FrontendTurn) -> Result<(), String> {
    let record = report.sanitized();
    if let Ok(dir) = app.path().app_local_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join(LAST_REPLY_FILE), render(&record));
    }
    append(&app, record);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_numbers_and_identifiers_only() {
        let turn = FrontendTurn {
            kind: "voice turn!".into(),
            started: 1000.4,
            marks: BTreeMap::from([("firstAudio".into(), 812.6), ("bad key".into(), 1.0), ("nan".into(), f64::NAN)]),
            counts: BTreeMap::from([("chunks".into(), 3.0)]),
            notes: BTreeMap::from([("engine".into(), "piper\u{7}-exe".repeat(20))]),
        };
        let value = turn.sanitized();
        assert_eq!(value["kind"], "voiceturn");
        assert_eq!(value["started"], 1000);
        assert_eq!(value["marks"], json!({ "firstAudio": 813 }));
        assert_eq!(value["counts"]["chunks"], 3);
        let engine = value["notes"]["engine"].as_str().unwrap();
        assert!(engine.chars().count() == 60 && !engine.contains('\u{7}'));
        let text = render(&value);
        assert!(text.contains("813 ms  firstAudio") && text.contains("chunks: 3"));
    }
}
