//! Text to phonemes for NOVA's own voices, through `nova-phonemize`: a small
//! separate program (GPL, like the eSpeak NG it loads) that NOVA talks to
//! over a pipe. It stays running while NOVA speaks and ends with the voice.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::sync::Mutex;
use std::time::Duration;

const HELPER: &str = "nova-phonemize.exe";
/// A sentence never takes this long; the helper is stuck.
const ANSWER_LIMIT: Duration = Duration::from_secs(10);

struct Helper {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    lines: Receiver<String>,
    espeak: PathBuf,
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

static HELPER_PROCESS: Mutex<Option<Helper>> = Mutex::new(None);

/// Where the helper is: next to nova.exe (installed, and in dev builds), or
/// where `NOVA_PHONEMIZE` points.
pub fn helper_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("NOVA_PHONEMIZE").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(path);
    }
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().skip(1).take(3).map(|dir| dir.join(HELPER)).find(|p| p.is_file())
}

fn start(espeak: &Path) -> Result<Helper, String> {
    let path = helper_path().ok_or("nova-phonemize.exe is missing")?;
    let mut command = std::process::Command::new(&path);
    command.arg(espeak).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().map_err(|e| format!("nova-phonemize couldn't start: {e}"))?;
    let stdin = child.stdin.take().ok_or("nova-phonemize has no input")?;
    let stdout = child.stdout.take().ok_or("nova-phonemize has no output")?;
    let (tx, lines) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    Ok(Helper { child, stdin, lines, espeak: espeak.to_path_buf() })
}

/// The phonemes of each sentence of `text` (eSpeak voice `voice`, e.g. "de"),
/// one char per phoneme, punctuation included — as Piper makes them.
pub fn sentences(espeak: &Path, voice: &str, text: &str) -> Result<Vec<String>, String> {
    request(espeak, voice, text, true)
}

/// The same with accented phonemes kept whole (Kokoro’s table has "ç", Piper’s has "c" + "̧").
pub fn sentences_composed(espeak: &Path, voice: &str, text: &str) -> Result<Vec<String>, String> {
    request(espeak, voice, text, false)
}

fn request(espeak: &Path, voice: &str, text: &str, decompose: bool) -> Result<Vec<String>, String> {
    let mut guard = HELPER_PROCESS.lock().unwrap_or_else(|p| p.into_inner());
    let fresh = guard.as_mut().is_none_or(|h| h.espeak != espeak || !matches!(h.child.try_wait(), Ok(None)));
    if fresh {
        *guard = Some(start(espeak)?);
    }
    let helper = guard.as_mut().ok_or("nova-phonemize isn't running")?;
    let request = serde_json::json!({ "voice": voice, "text": text, "decompose": decompose }).to_string();
    let answer = writeln!(helper.stdin, "{request}")
        .and_then(|()| helper.stdin.flush())
        .map_err(|e| e.to_string())
        .and_then(|()| helper.lines.recv_timeout(ANSWER_LIMIT).map_err(|_| "nova-phonemize didn't answer".to_string()));
    let line = match answer {
        Ok(line) => line,
        Err(error) => {
            *guard = None;
            return Err(error);
        }
    };
    let value: serde_json::Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
    if let Some(error) = value["error"].as_str() {
        if value.get("sentences").is_none() {
            *guard = None;
        }
        return Err(format!("nova-phonemize: {error}"));
    }
    Ok(value["sentences"].as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default())
}

/// Ends the helper (NOVA's voice was unloaded).
pub fn stop() {
    *HELPER_PROCESS.lock().unwrap_or_else(|p| p.into_inner()) = None;
}
