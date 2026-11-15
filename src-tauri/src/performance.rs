//! Keeping NOVA small: what it gives back to Windows while nobody looks at
//! it, and how much memory it uses right now (Settings → Leistung).
//!
//! The readout is NOVA as Task Manager would have to add it up: nova.exe, its
//! speech processes, and the WebView2 processes that draw its windows.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Manager, Runtime};

use crate::storage::Database;

type CommandResult<T> = Result<T, String>;

const PREFS_KEY: &str = "nova.performance";
/// Longer than this and the panel might as well stay.
const LONGEST_PANEL_IDLE_MINUTES: u32 = 120;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PerformancePrefs {
    /// Closing the main window to the tray ends its page instead of hiding it.
    pub release_main_window: bool,
    /// Minutes NOVA AI's closed panel stays in memory; 0 keeps it for good.
    pub panel_idle_minutes: u32,
}

impl Default for PerformancePrefs {
    fn default() -> Self {
        Self { release_main_window: true, panel_idle_minutes: 5 }
    }
}

impl PerformancePrefs {
    fn sanitized(mut self) -> Self {
        self.panel_idle_minutes = self.panel_idle_minutes.min(LONGEST_PANEL_IDLE_MINUTES);
        self
    }
}

pub fn load_prefs(db: &Database) -> PerformancePrefs {
    db.with(|conn| crate::storage::kv_get(conn, PREFS_KEY)).ok().flatten().and_then(|raw| serde_json::from_str::<PerformancePrefs>(&raw).ok()).unwrap_or_default().sanitized()
}

/// How long the windows took to come back the last time, measured where the user waits:
/// from asking for the window until its page is up.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timings {
    main_reopen_ms: Option<u64>,
    panel_open_ms: Option<u64>,
}

#[derive(Default)]
pub struct PerformanceState {
    prefs: Mutex<PerformancePrefs>,
    timings: Mutex<Timings>,
    /// Kept between readings: sysinfo reuses what it knows about each process.
    processes: Mutex<Option<System>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

fn state<R: Runtime>(app: &AppHandle<R>) -> &PerformanceState {
    app.state::<PerformanceState>().inner()
}

pub fn init<R: Runtime>(app: &AppHandle<R>, prefs: PerformancePrefs) {
    *lock(&state(app).prefs) = prefs;
}

pub fn prefs<R: Runtime>(app: &AppHandle<R>) -> PerformancePrefs {
    lock(&state(app).prefs).clone()
}

pub fn note_main_reopened<R: Runtime>(app: &AppHandle<R>, ms: u64) {
    lock(&state(app).timings).main_reopen_ms = Some(ms);
}

pub fn note_panel_opened<R: Runtime>(app: &AppHandle<R>, ms: u64) {
    lock(&state(app).timings).panel_open_ms = Some(ms);
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/// Which part of NOVA a process is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Part {
    /// nova.exe itself.
    Nova,
    /// The speech processes and what they start (the phonemizer, piper.exe).
    Speech,
    /// The WebView2 processes that draw NOVA's windows.
    WebView,
    /// Anything else NOVA started (a clip being encoded, …).
    Other,
}

/// A running process, as far as the readout cares.
#[derive(Debug, Clone, PartialEq)]
pub struct Seen {
    pub pid: u32,
    pub parent: Option<u32>,
    pub name: String,
    /// Seconds since the epoch.
    pub started: u64,
    /// Committed memory only this process holds: what Windows gets back when it ends.
    pub private: u64,
    /// What sits in RAM right now, shared pages included.
    pub working: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartUse {
    part: Part,
    processes: u32,
    private_bytes: u64,
    working_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReport {
    private_bytes: u64,
    working_bytes: u64,
    processes: u32,
    /// In a fixed order; parts without a process are left out (except NOVA itself).
    parts: Vec<PartUse>,
}

fn is_webview(name: &str) -> bool {
    name.eq_ignore_ascii_case("msedgewebview2.exe")
}

fn is_speech_tool(name: &str) -> bool {
    name.eq_ignore_ascii_case("piper.exe") || name.eq_ignore_ascii_case("nova-phonemize.exe")
}

/// Adds up NOVA: the process `root` and everything it started, directly or
/// not. `speech` are the pids of its speech processes.
///
/// WebView2's browser process is a child of the app that hosts it, and its
/// renderers and GPU process are children of that — so the tree finds NOVA's
/// WebView2 processes and nobody else's, without reading command lines.
pub fn attribute(all: &[Seen], root: u32, speech: &[u32]) -> MemoryReport {
    let mut children: HashMap<u32, Vec<&Seen>> = HashMap::new();
    for process in all {
        if let Some(parent) = process.parent {
            children.entry(parent).or_default().push(process);
        }
    }
    let mut parts = [Part::Nova, Part::Speech, Part::WebView, Part::Other].map(|part| PartUse { part, processes: 0, private_bytes: 0, working_bytes: 0 });
    let mut count = |part: Part, process: &Seen| {
        if let Some(sum) = parts.iter_mut().find(|sum| sum.part == part) {
            sum.processes += 1;
            sum.private_bytes += process.private;
            sum.working_bytes += process.working;
        }
    };
    let Some(nova) = all.iter().find(|process| process.pid == root) else {
        return MemoryReport { private_bytes: 0, working_bytes: 0, processes: 0, parts: Vec::new() };
    };
    count(Part::Nova, nova);
    let mut queue = vec![(nova, Part::Nova)];
    let mut seen = vec![root];
    while let Some((parent, parent_part)) = queue.pop() {
        for child in children.get(&parent.pid).into_iter().flatten() {
            // Windows reuses process ids: a "child" older than its parent belonged to
            // an earlier process with that id.
            if child.started < parent.started || seen.contains(&child.pid) {
                continue;
            }
            seen.push(child.pid);
            let part = if speech.contains(&child.pid) || is_speech_tool(&child.name) {
                Part::Speech
            } else if is_webview(&child.name) {
                Part::WebView
            } else if parent_part == Part::Nova {
                Part::Other
            } else {
                parent_part
            };
            count(part, child);
            queue.push((child, part));
        }
    }
    let parts: Vec<PartUse> = parts.into_iter().filter(|sum| sum.processes > 0).collect();
    MemoryReport {
        private_bytes: parts.iter().map(|sum| sum.private_bytes).sum(),
        working_bytes: parts.iter().map(|sum| sum.working_bytes).sum(),
        processes: parts.iter().map(|sum| sum.processes).sum(),
        parts,
    }
}

/// Every process on the PC, with its memory. One system call for the list; no command lines are read.
fn processes(system: &mut System) -> Vec<Seen> {
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_memory());
    system
        .processes()
        .iter()
        .map(|(pid, process)| Seen {
            pid: pid.as_u32(),
            parent: process.parent().map(|parent| parent.as_u32()),
            name: process.name().to_string_lossy().into_owned(),
            started: process.start_time(),
            // On Windows sysinfo's "virtual memory" is the private usage (commit), its "memory" the working set.
            private: process.virtual_memory(),
            working: process.memory(),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceStatus {
    prefs: PerformancePrefs,
    timings: Timings,
}

fn status<R: Runtime>(app: &AppHandle<R>) -> PerformanceStatus {
    PerformanceStatus { prefs: prefs(app), timings: *lock(&state(app).timings) }
}

#[tauri::command]
pub async fn performance_status<R: Runtime>(app: AppHandle<R>) -> CommandResult<PerformanceStatus> {
    Ok(status(&app))
}

#[tauri::command]
pub async fn performance_configure<R: Runtime>(app: AppHandle<R>, prefs: PerformancePrefs) -> CommandResult<PerformanceStatus> {
    let prefs = prefs.sanitized();
    let json = serde_json::to_string(&prefs).map_err(|e| e.to_string())?;
    app.state::<Database>().with(|conn| crate::storage::kv_set(conn, PREFS_KEY, &json))?;
    *lock(&state(&app).prefs) = prefs;
    // A panel that has been closed for longer than the new time goes at the next look.
    crate::assistant::watch_panel_idle(&app);
    Ok(status(&app))
}

/// What NOVA uses right now. The page asks while it is visible, a few seconds apart.
#[tauri::command]
pub async fn performance_memory<R: Runtime>(app: AppHandle<R>) -> CommandResult<MemoryReport> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut system = lock(&state(&handle).processes);
        if system.is_none() {
            *system = Some(System::new().map_err(|e| format!("Windows doesn't tell which processes run: {e}"))?);
        }
        let all = system.as_mut().map(processes).unwrap_or_default();
        Ok(attribute(&all, std::process::id(), &crate::speech::helper_pids(&handle)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const MB: u64 = 1 << 20;

    fn process(pid: u32, parent: u32, name: &str, started: u64, private_mb: u64) -> Seen {
        Seen { pid, parent: Some(parent), name: name.into(), started, private: private_mb * MB, working: private_mb * MB / 2 }
    }

    fn part(report: &MemoryReport, part: Part) -> Option<(u32, u64)> {
        report.parts.iter().find(|sum| sum.part == part).map(|sum| (sum.processes, sum.private_bytes / MB))
    }

    #[test]
    fn adds_up_nova_its_speech_processes_and_its_webviews() {
        let all = [
            process(4, 0, "System", 1, 1),
            process(100, 4, "explorer.exe", 10, 90),
            process(500, 100, "nova.exe", 50, 60),
            // NOVA's speech processes, and the phonemizer one of them started.
            process(510, 500, "nova.exe", 60, 700),
            process(511, 500, "nova.exe", 61, 150),
            process(512, 511, "nova-phonemize.exe", 62, 8),
            process(513, 500, "piper.exe", 62, 40),
            // WebView2: the browser process is NOVA's child, the rest are the browser's.
            process(520, 500, "msedgewebview2.exe", 51, 36),
            process(521, 520, "msedgewebview2.exe", 51, 226),
            process(522, 520, "msedgewebview2.exe", 52, 23),
            process(523, 520, "MSEdgeWebView2.exe", 52, 3),
            // A clip being encoded.
            process(530, 500, "ffmpeg.exe", 70, 30),
            // Somebody else's WebView2 and another NOVA-like name: not ours.
            process(900, 100, "msedgewebview2.exe", 20, 400),
            process(901, 900, "msedgewebview2.exe", 20, 400),
            process(950, 100, "nova.exe", 20, 999),
        ];
        let report = attribute(&all, 500, &[510, 511]);
        assert_eq!(part(&report, Part::Nova), Some((1, 60)));
        assert_eq!(part(&report, Part::Speech), Some((4, 700 + 150 + 8 + 40)));
        assert_eq!(part(&report, Part::WebView), Some((4, 36 + 226 + 23 + 3)));
        assert_eq!(part(&report, Part::Other), Some((1, 30)));
        assert_eq!(report.processes, 10);
        assert_eq!(report.private_bytes / MB, 60 + 898 + 288 + 30);
        assert_eq!(report.working_bytes, report.private_bytes / 2);
        assert_eq!(report.parts.iter().map(|sum| sum.part).collect::<Vec<_>>(), vec![Part::Nova, Part::Speech, Part::WebView, Part::Other]);
    }

    #[test]
    fn idle_nova_is_itself_and_its_webviews() {
        let all = [process(500, 100, "nova.exe", 50, 45), process(520, 500, "msedgewebview2.exe", 51, 36), process(521, 520, "msedgewebview2.exe", 51, 120)];
        let report = attribute(&all, 500, &[]);
        assert_eq!(report.parts.len(), 2, "no speech process, nothing else");
        assert_eq!(report.private_bytes / MB, 201);
    }

    #[test]
    fn a_reused_process_id_adopts_nobody() {
        // 700 was started long before "its parent" 500 existed: an earlier process had that id.
        let all = [process(500, 100, "nova.exe", 50, 45), process(700, 500, "chrome.exe", 5, 800), process(701, 700, "chrome.exe", 6, 800)];
        let report = attribute(&all, 500, &[]);
        assert_eq!(report.processes, 1);
        assert_eq!(report.private_bytes / MB, 45);
        // And a process list without NOVA in it adds up to nothing.
        assert_eq!(attribute(&all, 42, &[]).processes, 0);
    }

    #[test]
    fn preferences_default_to_saving_memory_and_stay_in_range() {
        let prefs: PerformancePrefs = serde_json::from_str("{}").unwrap();
        assert_eq!(prefs, PerformancePrefs { release_main_window: true, panel_idle_minutes: 5 });
        let wild: PerformancePrefs = serde_json::from_str(r#"{"releaseMainWindow":false,"panelIdleMinutes":100000,"somethingNewer":1}"#).unwrap();
        assert_eq!(wild.sanitized(), PerformancePrefs { release_main_window: false, panel_idle_minutes: 120 });
        assert_eq!(serde_json::to_value(PerformancePrefs::default()).unwrap(), serde_json::json!({ "releaseMainWindow": true, "panelIdleMinutes": 5 }));
    }
}
