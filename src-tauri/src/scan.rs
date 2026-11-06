//! Virus scans with Windows Defender, in the background: a quick scan takes
//! minutes and a full one hours, so NOVA stays usable meanwhile. Defender itself
//! quarantines what it finds; NOVA starts the scan and reports the result.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_notification::NotificationExt;

use crate::storage::now_millis;

type CommandResult<T> = Result<T, String>;

const EVENT_STATUS: &str = "scan://status";

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScanKind {
    Quick,
    Full,
}

impl ScanKind {
    fn argument(self) -> &'static str {
        match self {
            ScanKind::Quick => "1",
            ScanKind::Full => "2",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ScanKind::Quick => "quick",
            ScanKind::Full => "full",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScanResult {
    #[default]
    Idle,
    Running,
    Clean,
    Threats,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStatus {
    pub state: ScanResult,
    pub kind: Option<ScanKind>,
    pub started_at: i64,
    pub finished_at: i64,
    pub threats: Vec<String>,
    pub message: Option<String>,
}

#[derive(Default)]
pub struct ScanState {
    status: Mutex<ScanStatus>,
    cancel: AtomicBool,
}

pub fn current<R: Runtime>(app: &AppHandle<R>) -> ScanStatus {
    app.state::<ScanState>().status.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

fn publish<R: Runtime>(app: &AppHandle<R>, status: ScanStatus) {
    *app.state::<ScanState>().status.lock().unwrap_or_else(|p| p.into_inner()) = status.clone();
    let _ = app.emit(EVENT_STATUS, status);
}

fn defender() -> PathBuf {
    let folder = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    folder.join("Windows Defender").join("MpCmdRun.exe")
}

fn hidden(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.stdin(Stdio::null());
    command
}

/// Threat names look like `Virus:DOS/EICAR_Test_File`, whatever language the
/// rest of Defender's report is in.
fn threat_names(output: &str) -> Vec<String> {
    let mut names = Vec::new();
    for line in output.lines() {
        let Some((_, value)) = line.split_once(" : ") else { continue };
        let value = value.trim();
        let looks_like_one = value.split_once(':').is_some_and(|(family, rest)| family.len() > 1 && family.chars().all(char::is_alphabetic) && rest.contains('/'));
        if looks_like_one && !value.contains(' ') && !names.iter().any(|known| known == value) {
            names.push(value.to_string());
        }
    }
    names
}

/// What a finished scan says. Defender answers 2 for threats, and also for not
/// being able to scan at all, so the code alone doesn't tell.
fn result_of(code: Option<i32>, output: &str) -> ScanResult {
    let threats = !threat_names(output).is_empty();
    match code {
        _ if threats => ScanResult::Threats,
        Some(0) => ScanResult::Clean,
        _ => ScanResult::Failed,
    }
}

/// The security programs Windows knows as switched on, from `name|state` lines.
/// Bit 0x1000 of the state means on; uninstalled products often stay listed as off.
fn active_antivirus(lines: &str) -> Vec<String> {
    lines
        .lines()
        .filter_map(|line| {
            let (name, state) = line.trim().rsplit_once('|')?;
            let on = state.trim().parse::<u32>().ok()? & 0x1000 != 0;
            (on && !name.eq_ignore_ascii_case("Windows Defender")).then(|| name.to_string())
        })
        .collect()
}

/// Why Defender couldn't scan, in words someone can act on.
fn why_failed() -> String {
    let script = "Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntivirusProduct | ForEach-Object { $_.displayName + '|' + $_.productState }";
    let listed = hidden("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", script]).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    match active_antivirus(&listed).as_slice() {
        [] => "Windows Defender couldn't scan. It may be switched off under Windows Security.".into(),
        others => format!("Windows Defender can't scan here because {} protects this PC instead. Start the scan in that program.", others.join(" and ")),
    }
}

fn run<R: Runtime>(app: &AppHandle<R>, kind: ScanKind) -> (ScanResult, Vec<String>, Option<String>) {
    let spawned = hidden(defender()).args(["-Scan", "-ScanType", kind.argument()]).stdout(Stdio::piped()).stderr(Stdio::null()).spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(_) => return (ScanResult::Failed, Vec::new(), Some("Windows Defender isn't available on this PC.".into())),
    };
    let mut stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(stdout) = stdout.as_mut() {
            let _ = stdout.read_to_end(&mut bytes);
        }
        String::from_utf8_lossy(&bytes).into_owned()
    });
    let code = loop {
        if app.state::<ScanState>().cancel.swap(false, Ordering::SeqCst) {
            let _ = hidden(defender()).args(["-Scan", "-Cancel"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
            let _ = child.kill();
            let _ = child.wait();
            return (ScanResult::Cancelled, Vec::new(), None);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => std::thread::sleep(Duration::from_millis(500)),
            Err(_) => break None,
        }
    };
    let output = reader.join().unwrap_or_default();
    let result = result_of(code, &output);
    let message = (result == ScanResult::Failed).then(why_failed);
    (result, threat_names(&output), message)
}

/// One line on what the last scan found, for the notification and the model.
pub fn describe(status: &ScanStatus) -> String {
    match status.state {
        ScanResult::Idle => "No virus scan has run since NOVA started.".into(),
        ScanResult::Running => format!("The {} scan is still running.", status.kind.map_or("virus", ScanKind::label)),
        ScanResult::Clean => format!("The {} scan is finished: no threats found.", status.kind.map_or("virus", ScanKind::label)),
        ScanResult::Threats => format!("The scan found {} threat(s): {}. Windows Defender handles them; details are in Windows Security.", status.threats.len(), status.threats.join(", ")),
        ScanResult::Failed => status.message.clone().unwrap_or_else(|| "The scan couldn't run.".into()),
        ScanResult::Cancelled => "The scan was cancelled.".into(),
    }
}

/// Starts a scan in the background; the result arrives as an event and a notification.
pub fn start<R: Runtime>(app: &AppHandle<R>, kind: ScanKind) -> Result<(), String> {
    if current(app).state == ScanResult::Running {
        return Err("A virus scan is already running.".into());
    }
    app.state::<ScanState>().cancel.store(false, Ordering::SeqCst);
    let started_at = now_millis();
    publish(app, ScanStatus { state: ScanResult::Running, kind: Some(kind), started_at, ..ScanStatus::default() });
    let app = app.clone();
    std::thread::spawn(move || {
        let (state, threats, message) = run(&app, kind);
        let status = ScanStatus { state, kind: Some(kind), started_at, finished_at: now_millis(), threats, message };
        publish(&app, status.clone());
        if state != ScanResult::Cancelled {
            let _ = app.notification().builder().title("NOVA virus scan").body(describe(&status)).show();
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn scan_status<R: Runtime>(app: AppHandle<R>) -> CommandResult<ScanStatus> {
    Ok(current(&app))
}

#[tauri::command]
pub async fn scan_cancel<R: Runtime>(app: AppHandle<R>) -> CommandResult<()> {
    if current(&app).state == ScanResult::Running {
        app.state::<ScanState>().cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// Opens Windows Security at its list of threats.
#[tauri::command]
pub async fn scan_open_security() -> CommandResult<()> {
    tauri::async_runtime::spawn_blocking(|| crate::shell::open_system_link("windowsdefender://threat/")).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const FOUND: &str = "Scan starting...\r\nScan finished.\r\nScanning C:\\Users found 1 threats.\r\n<==== LIST OF DETECTED THREATS ====>\r\n---- Threat information ----\r\nThreat                  : Virus:DOS/EICAR_Test_File\r\nResources               : 1 total\r\n    file                : C:\\Users\\me\\Downloads\\eicar.com\r\n";
    /// What this happens to answer while another antivirus is in charge.
    const CANT: &str = "CmdTool: Failed with hr = 0x80004005. Check C:\\Users\\me\\AppData\\Local\\Temp\\MpCmdRun.log for more information";

    #[test]
    fn tells_threats_from_not_being_able_to_scan() {
        // Both answer with code 2.
        assert_eq!(result_of(Some(2), FOUND), ScanResult::Threats);
        assert_eq!(result_of(Some(2), CANT), ScanResult::Failed);
        assert_eq!(result_of(Some(0), "Scan starting...\nScan finished.\nScanning found no threats.\n"), ScanResult::Clean);
        assert_eq!(result_of(None, ""), ScanResult::Failed);
    }

    #[test]
    fn reads_threat_names_not_paths() {
        assert_eq!(threat_names(FOUND), ["Virus:DOS/EICAR_Test_File"]);
        assert_eq!(threat_names(CANT), Vec::<String>::new());
        assert_eq!(threat_names("Bedrohung : Trojan:Win32/Wacatac.B!ml\nBedrohung : Trojan:Win32/Wacatac.B!ml\n"), ["Trojan:Win32/Wacatac.B!ml"]);
        assert_eq!(threat_names("    file                : C:/Users/me/x.exe\n"), Vec::<String>::new());
    }

    #[test]
    fn names_the_antivirus_that_is_really_on() {
        // As Windows lists them on a PC with leftovers of uninstalled products.
        let listed = "Norton 360 for Gamers|262144\r\nMalwarebytes|397312\r\nWindows Defender|393472\r\nKaspersky|270336\r\nAvast Antivirus|270336\r\n";
        assert_eq!(active_antivirus(listed), ["Malwarebytes"]);
        assert!(active_antivirus("Windows Defender|397568\n").is_empty());
        assert!(active_antivirus("nonsense\n").is_empty());
    }

    #[test]
    fn describes_each_result() {
        let status = |state| ScanStatus { state, kind: Some(ScanKind::Quick), ..ScanStatus::default() };
        assert!(describe(&status(ScanResult::Clean)).contains("no threats"));
        assert!(describe(&ScanStatus { threats: vec!["Virus:DOS/EICAR".into()], ..status(ScanResult::Threats) }).contains("Virus:DOS/EICAR"));
        assert!(describe(&ScanStatus { message: Some("Malwarebytes".into()), ..status(ScanResult::Failed) }).contains("Malwarebytes"));
    }

    #[test]
    fn status_serializes_for_the_panel() {
        let value = serde_json::to_value(ScanStatus { state: ScanResult::Running, kind: Some(ScanKind::Quick), started_at: 5, ..ScanStatus::default() }).unwrap();
        assert_eq!(value["state"], "running");
        assert_eq!(value["kind"], "quick");
        assert_eq!(value["startedAt"], 5);
    }

    /// Runs a real scan. `cargo test -- --ignored real_scan --nocapture`
    #[test]
    #[ignore]
    fn real_scan_outcome() {
        let output = hidden(defender()).args(["-Scan", "-ScanType", "1"]).output().unwrap();
        let text = String::from_utf8_lossy(&output.stdout);
        eprintln!("{:?} {:?} {}", output.status.code(), result_of(output.status.code(), &text), why_failed());
    }
}
