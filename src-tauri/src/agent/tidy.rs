//! Sorting a messy folder (Downloads, usually) into subfolders by kind. The plan is
//! shown first, nothing is overwritten, and the last sort can be taken back.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::storage::{self, Database};

const LAST_KEY: &str = "nova.tidy.last";
const MOST_FILES: usize = 5000;
/// Something written to this recently may still be in use.
const SETTLING: Duration = Duration::from_secs(5 * 60);
/// Unfinished downloads of browsers.
pub const PARTIAL: &[&str] = &["crdownload", "opdownload", "part", "partial"];

#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub folder: PathBuf,
    /// (subfolder, files going there), biggest group first.
    pub groups: Vec<(String, Vec<PathBuf>)>,
}

impl Plan {
    pub fn count(&self) -> usize {
        self.groups.iter().map(|(_, files)| files.len()).sum()
    }

    /// "Bilder (12): a.png, b.jpg, …", for the user to check first.
    pub fn preview(&self) -> Vec<String> {
        self.groups
            .iter()
            .map(|(name, files)| {
                let examples: Vec<String> = files.iter().take(3).filter_map(|file| file.file_name().map(|n| n.to_string_lossy().into_owned())).collect();
                format!("{name} ({}): {}{}", files.len(), examples.join(", "), if files.len() > 3 { ", …" } else { "" })
            })
            .collect()
    }
}

/// The subfolder for a kind of file from `finder::kind_of`.
fn subfolder(kind: &str, german: bool) -> &'static str {
    match (kind, german) {
        ("pdf" | "document" | "spreadsheet" | "presentation", true) => "Dokumente",
        ("pdf" | "document" | "spreadsheet" | "presentation", false) => "Documents",
        ("image", true) => "Bilder",
        ("image", false) => "Pictures",
        ("video", _) => "Videos",
        ("audio", true) => "Musik",
        ("audio", false) => "Music",
        ("archive", true) => "Archive",
        ("archive", false) => "Archives",
        ("3d", _) => "3D",
        ("program", true) => "Programme",
        ("program", false) => "Programs",
        ("code", _) => "Code",
        (_, true) => "Sonstiges",
        (_, false) => "Other",
    }
}

fn sortable(path: &Path, now: SystemTime) -> bool {
    let Ok(meta) = path.metadata() else { return false };
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let settled = meta.modified().ok().and_then(|at| now.duration_since(at).ok()).is_some_and(|age| age >= SETTLING);
    meta.is_file() && settled && !crate::files::is_hidden(&meta, &name) && !PARTIAL.contains(&ext.as_str()) && ext != "tmp"
}

/// What sorting `folder` would do. Only files directly in it; folders stay as they are.
pub fn plan(folder: &Path, german: bool) -> Result<Plan, String> {
    let now = SystemTime::now();
    let mut groups: Vec<(String, Vec<PathBuf>)> = Vec::new();
    let entries = std::fs::read_dir(folder).map_err(|e| format!("Couldn't read that folder: {e}"))?;
    for path in entries.flatten().map(|entry| entry.path()).filter(|path| sortable(path, now)).take(MOST_FILES) {
        let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let name = subfolder(crate::finder::kind_of(&ext), german);
        match groups.iter_mut().find(|(group, _)| group == name) {
            Some((_, files)) => files.push(path),
            None => groups.push((name.to_string(), vec![path])),
        }
    }
    groups.sort_by_key(|(_, files)| std::cmp::Reverse(files.len()));
    Ok(Plan { folder: folder.to_path_buf(), groups })
}

/// `name` in `folder`, or "name (2)" when that's taken.
fn free_name(folder: &Path, file: &Path) -> PathBuf {
    let name = file.file_name().unwrap_or_default();
    let first = folder.join(name);
    if !first.exists() {
        return first;
    }
    let stem = file.file_stem().unwrap_or_default().to_string_lossy();
    let ext = file.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..).map(|n| folder.join(format!("{stem} ({n}){ext}"))).find(|path| !path.exists()).unwrap_or(first)
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LastSort {
    pub moves: Vec<(PathBuf, PathBuf)>,
}

/// Moves the files as planned. A file that can't move stays; returns what moved and why the others didn't.
fn move_files(plan: &Plan) -> (LastSort, Vec<String>) {
    let mut last = LastSort::default();
    let mut failed = Vec::new();
    for (name, files) in &plan.groups {
        let target = plan.folder.join(name);
        if let Err(why) = std::fs::create_dir_all(&target) {
            failed.extend(files.iter().map(|_| format!("{name}: {why}")));
            continue;
        }
        for file in files {
            let to = free_name(&target, file);
            match std::fs::rename(file, &to) {
                Ok(()) => last.moves.push((file.clone(), to)),
                Err(why) => failed.push(format!("{}: {why}", file.file_name().unwrap_or_default().to_string_lossy())),
            }
        }
        // Nothing got there: no empty folder stays behind. Fails while something is in it.
        let _ = std::fs::remove_dir(&target);
    }
    (last, failed)
}

/// Sorts as planned and remembers it for `undo`. Says how many moved and why others didn't.
pub fn apply<R: Runtime>(app: &AppHandle<R>, plan: &Plan) -> Result<(usize, Vec<String>), String> {
    let (last, failed) = move_files(plan);
    let raw = serde_json::to_string(&last).map_err(|e| e.to_string())?;
    app.state::<Database>().with(|c| storage::kv_set(c, LAST_KEY, &raw))?;
    Ok((last.moves.len(), failed))
}

pub fn last<R: Runtime>(app: &AppHandle<R>) -> LastSort {
    app.state::<Database>().with(|c| storage::kv_get(c, LAST_KEY)).ok().flatten().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

/// Puts the files of the last sort back, and removes subfolders that are empty again.
pub fn undo<R: Runtime>(app: &AppHandle<R>) -> Result<usize, String> {
    let sort = last(app);
    let mut back = 0;
    let mut left = LastSort::default();
    for (from, to) in &sort.moves {
        if !from.exists() && std::fs::rename(to, from).is_ok() {
            back += 1;
        } else if to.exists() {
            // In use right now, perhaps: it can still be tried again.
            left.moves.push((from.clone(), to.clone()));
        }
    }
    let mut folders: Vec<&Path> = sort.moves.iter().filter_map(|(_, to)| to.parent()).collect();
    folders.sort_unstable();
    folders.dedup();
    for folder in folders {
        // Fails while something else is in it, which is what should happen.
        let _ = std::fs::remove_dir(folder);
    }
    let raw = serde_json::to_string(&left).map_err(|e| e.to_string())?;
    app.state::<Database>().with(|c| storage::kv_set(c, LAST_KEY, &raw))?;
    Ok(back)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nova-tidy-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn old_file(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, b"x").unwrap();
        let old = SystemTime::now() - Duration::from_secs(3600);
        std::fs::File::options().write(true).open(&path).unwrap().set_modified(old).unwrap();
        path
    }

    #[test]
    fn plans_by_kind_and_leaves_what_may_be_in_use() {
        let dir = folder("plan");
        old_file(&dir, "a.png");
        old_file(&dir, "b.jpg");
        old_file(&dir, "c.pdf");
        old_file(&dir, "halb.crdownload");
        std::fs::write(dir.join("gerade.png"), b"x").unwrap();
        std::fs::create_dir(dir.join("Ordner")).unwrap();
        let plan = plan(&dir, true).unwrap();
        assert_eq!(plan.count(), 3);
        assert_eq!(plan.groups[0].0, "Bilder");
        assert_eq!(plan.groups[0].1.len(), 2);
        assert_eq!(plan.groups[1].0, "Dokumente");
        assert!(plan.preview()[0].starts_with("Bilder (2): "));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn moves_the_files_where_the_plan_says() {
        let dir = folder("moves");
        old_file(&dir, "a.png");
        old_file(&dir, "c.pdf");
        let (last, failed) = move_files(&plan(&dir, false).unwrap());
        assert_eq!(failed, Vec::<String>::new());
        assert_eq!(last.moves.len(), 2);
        assert!(dir.join("Pictures").join("a.png").is_file() && dir.join("Documents").join("c.pdf").is_file());
        assert!(!dir.join("a.png").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn never_overwrites() {
        let dir = folder("names");
        let file = old_file(&dir, "a.png");
        let target = dir.join("Bilder");
        std::fs::create_dir(&target).unwrap();
        assert_eq!(free_name(&target, &file), target.join("a.png"));
        std::fs::write(target.join("a.png"), b"y").unwrap();
        assert_eq!(free_name(&target, &file), target.join("a (2).png"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
