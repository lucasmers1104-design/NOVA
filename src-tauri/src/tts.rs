//! NOVA's own voice: Piper, a small neural text-to-speech engine that runs
//! offline on this PC, with the German voice "Thorsten".
//!
//! Engine and voice are downloaded once (about 85 MB) into NOVA's local data
//! folder and checked against pinned SHA-256 hashes before anything runs;
//! until then NOVA speaks with a Windows voice. Piper then runs as one hidden
//! process that keeps the voice loaded: each sentence goes in as a line of
//! JSON and comes back as a WAV file, which is handed to the panel and
//! deleted. The process ends after a few idle minutes, and by itself when
//! NOVA exits (its input closes).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

type CommandResult<T> = Result<T, String>;

const EVENT_STATUS: &str = "tts://status";

/// A file NOVA downloads for its voice.
struct Download {
    url: &'static str,
    sha256: &'static str,
    size: u64,
}

/// Piper 2023.11.14-2 for Windows (MIT), from its official release.
const ENGINE: Download = Download {
    url: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip",
    sha256: "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea",
    size: 22_477_236,
};
/// The voice "Thorsten" (medium), trained on the CC0 Thorsten-Voice dataset.
const MODEL: Download = Download {
    url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx",
    sha256: "7e64762d8e5118bb578f2eea6207e1a35a8e0c30595010b666f983fc87bb7819",
    size: 63_201_294,
};
const CONFIG: Download = Download {
    url: "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx.json",
    sha256: "974adee790533adb273a1ac88f49027d2a1b8f0f2cf4905954a4791e79264e85",
    size: 4_819,
};
/// Written last: the voice is complete. Changing it makes NOVA download again.
const MARKER: &str = "piper-2023.11.14-2 thorsten-medium v1.0.0";

/// Piper ends after this long without a sentence to speak (it holds ~150 MB).
const IDLE_LIMIT: Duration = Duration::from_secs(300);
/// One sentence never takes this long; Piper is stuck.
const SENTENCE_LIMIT: Duration = Duration::from_secs(20);
/// The panel sends a sentence or two at a time.
const LONGEST_TEXT: usize = 1200;

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum VoiceInstall {
    #[default]
    Missing,
    Downloading {
        percent: u8,
    },
    Ready,
    Failed {
        message: String,
    },
}

#[derive(Default)]
pub struct TtsState {
    downloading: AtomicBool,
    /// The last download's progress or failure (while not ready).
    install: Mutex<VoiceInstall>,
    engine: Arc<Mutex<Option<Engine>>>,
    next_file: std::sync::atomic::AtomicU64,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn voice_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map(|dir| dir.join("voice")).map_err(|e| format!("No local data folder: {e}"))
}

struct Files {
    exe: PathBuf,
    model: PathBuf,
    config: PathBuf,
    marker: PathBuf,
    out: PathBuf,
}

fn files(dir: &Path) -> Files {
    Files {
        exe: dir.join("piper").join("piper.exe"),
        model: dir.join("thorsten.onnx"),
        config: dir.join("thorsten.onnx.json"),
        marker: dir.join("ready.txt"),
        out: dir.join("out"),
    }
}

fn installed(dir: &Path) -> bool {
    let f = files(dir);
    std::fs::read_to_string(&f.marker).is_ok_and(|m| m.trim() == MARKER) && f.exe.is_file() && f.model.is_file() && f.config.is_file()
}

fn status<R: Runtime>(app: &AppHandle<R>) -> VoiceInstall {
    let state = app.state::<TtsState>();
    if !state.downloading.load(Ordering::SeqCst) && voice_dir(app).is_ok_and(|dir| installed(&dir)) {
        return VoiceInstall::Ready;
    }
    let install = lock(&state.install).clone();
    install
}

fn set_status<R: Runtime>(app: &AppHandle<R>, install: VoiceInstall) {
    let state = app.state::<TtsState>();
    {
        let mut current = lock(&state.install);
        if *current == install {
            return;
        }
        *current = install.clone();
    }
    let _ = app.emit(EVENT_STATUS, install);
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(windows)]
fn sha256(data: &[u8]) -> Result<String, String> {
    use windows::Win32::Security::Cryptography::{BCryptHash, BCRYPT_SHA256_ALG_HANDLE};
    let mut digest = [0u8; 32];
    // SAFETY: a system-provided algorithm pseudo-handle and valid slices for the call's duration.
    let status = unsafe { BCryptHash(BCRYPT_SHA256_ALG_HANDLE, None, data, &mut digest) };
    if status.is_ok() { Ok(hex(&digest)) } else { Err(format!("Couldn't check the download (0x{:08X})", status.0)) }
}

#[cfg(not(windows))]
fn sha256(_data: &[u8]) -> Result<String, String> {
    Err("NOVA's voice requires Windows".into())
}

/// Downloads one file completely and checks its hash; `progress` gets the bytes so far.
async fn fetch(file: &Download, progress: &(dyn Fn(u64) + Sync)) -> Result<Vec<u8>, String> {
    let mut response = crate::http::client()
        .get(file.url)
        .timeout(Duration::from_secs(600))
        .send()
        .await
        .map_err(crate::http::describe)?;
    if !response.status().is_success() {
        return Err(format!("The download server answered {}", response.status()));
    }
    let mut body = Vec::with_capacity(file.size as usize);
    while let Some(chunk) = response.chunk().await.map_err(crate::http::describe)? {
        if body.len() + chunk.len() > file.size as usize {
            return Err("The download is larger than expected".into());
        }
        body.extend_from_slice(&chunk);
        progress(body.len() as u64);
    }
    if sha256(&body)? != file.sha256 {
        return Err("The download didn't match NOVA's voice (checksum differs)".into());
    }
    Ok(body)
}

/// Runs a program without a console window and waits for it.
fn run_hidden(program: &Path, args: &[&std::ffi::OsStr]) -> Result<(), String> {
    let mut command = std::process::Command::new(program);
    command.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let status = command.status().map_err(|e| format!("{} couldn't run: {e}", program.display()))?;
    if status.success() { Ok(()) } else { Err(format!("{} failed ({status})", program.display())) }
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

async fn install<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let dir = voice_dir(app)?;
    let total = ENGINE.size + MODEL.size + CONFIG.size;
    let last = std::sync::atomic::AtomicU8::new(0);
    let report = |done: u64| {
        let percent = (done * 100 / total).min(99) as u8;
        if last.swap(percent, Ordering::Relaxed) != percent {
            set_status(app, VoiceInstall::Downloading { percent });
        }
    };
    set_status(app, VoiceInstall::Downloading { percent: 0 });
    // Anything from an earlier, unfinished attempt goes.
    let _ = std::fs::remove_file(files(&dir).marker);
    let staging = dir.join(".download");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("Couldn't create {}: {e}", staging.display()))?;

    let engine = fetch(&ENGINE, &|n| report(n)).await?;
    let zip = staging.join("piper.zip");
    std::fs::write(&zip, &engine).map_err(|e| e.to_string())?;
    drop(engine);
    // Windows' own tar unpacks zip archives.
    let tar = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join("System32").join("tar.exe");
    run_hidden(&tar, &["-xf".as_ref(), zip.as_os_str(), "-C".as_ref(), staging.as_os_str()])?;
    if !staging.join("piper").join("piper.exe").is_file() {
        return Err("The voice engine archive didn't contain piper.exe".into());
    }

    let model = fetch(&MODEL, &|n| report(ENGINE.size + n)).await?;
    std::fs::write(staging.join("thorsten.onnx"), &model).map_err(|e| e.to_string())?;
    drop(model);
    let config = fetch(&CONFIG, &|n| report(ENGINE.size + MODEL.size + n)).await?;
    std::fs::write(staging.join("thorsten.onnx.json"), &config).map_err(|e| e.to_string())?;

    // A running engine holds its files.
    *lock(&app.state::<TtsState>().engine) = None;
    let target = files(&dir);
    let _ = std::fs::remove_dir_all(dir.join("piper"));
    std::fs::rename(staging.join("piper"), dir.join("piper")).map_err(|e| e.to_string())?;
    std::fs::rename(staging.join("thorsten.onnx"), &target.model).map_err(|e| e.to_string())?;
    std::fs::rename(staging.join("thorsten.onnx.json"), &target.config).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::write(&target.marker, MARKER).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// The running engine
// ---------------------------------------------------------------------------

struct Engine {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    /// Paths Piper prints once a sentence is written.
    written: std::sync::mpsc::Receiver<String>,
    /// Speed it was started with (Piper's phoneme length, in hundredths).
    length: u32,
    last_used: Instant,
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Piper's phoneme length for a speech rate (2 = twice as fast), in hundredths.
fn length_for(rate: f32) -> u32 {
    let rate = if rate.is_finite() { rate.clamp(0.5, 2.0) } else { 1.0 };
    (100.0 / rate).round() as u32
}

fn start_engine(dir: &Path, length: u32) -> Result<Engine, String> {
    use std::io::BufRead;
    let f = files(dir);
    let mut command = std::process::Command::new(&f.exe);
    command
        .arg("--model")
        .arg(&f.model)
        .arg("--config")
        .arg(&f.config)
        .args(["--json-input", "--quiet", "--sentence_silence", "0.25", "--length_scale"])
        .arg(format!("{:.2}", length as f32 / 100.0))
        .current_dir(dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|e| format!("NOVA's voice couldn't start: {e}"))?;
    let stdin = child.stdin.take().ok_or("NOVA's voice has no input")?;
    let stdout = child.stdout.take().ok_or("NOVA's voice has no output")?;
    let (tx, written) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if tx.send(line.trim().to_string()).is_err() {
                break;
            }
        }
    });
    Ok(Engine { child, stdin, written, length, last_used: Instant::now() })
}

/// Ends the engine once it has been idle for a while.
fn watch_idle(engine: Arc<Mutex<Option<Engine>>>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(30));
        let mut guard = lock(&engine);
        match guard.as_ref() {
            None => return,
            Some(running) if running.last_used.elapsed() >= IDLE_LIMIT => {
                *guard = None;
                return;
            }
            Some(_) => {}
        }
    });
}

fn synthesize(state: &TtsState, dir: &Path, text: &str, rate: f32) -> Result<Vec<u8>, String> {
    use std::io::Write;
    let length = length_for(rate);
    let mut guard = lock(&state.engine);
    let usable = guard.as_mut().is_some_and(|e| e.length == length && matches!(e.child.try_wait(), Ok(None)));
    if !usable {
        let fresh = guard.is_none();
        *guard = Some(start_engine(dir, length)?);
        if fresh {
            watch_idle(state.engine.clone());
        }
    }
    let engine = guard.as_mut().ok_or("NOVA's voice isn't running")?;
    let out = files(dir).out;
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let file = out.join(format!("{}.wav", state.next_file.fetch_add(1, Ordering::Relaxed)));
    let line = serde_json::json!({ "text": text, "output_file": file }).to_string();
    let sent = writeln!(engine.stdin, "{line}").and_then(|()| engine.stdin.flush());
    let written = sent.map_err(|e| e.to_string()).and_then(|()| engine.written.recv_timeout(SENTENCE_LIMIT).map_err(|_| "NOVA's voice didn't answer".to_string()));
    engine.last_used = Instant::now();
    if let Err(error) = written {
        *guard = None;
        let _ = std::fs::remove_file(&file);
        return Err(error);
    }
    drop(guard);
    let wav = std::fs::read(&file).map_err(|e| format!("NOVA's voice wrote no audio: {e}"));
    let _ = std::fs::remove_file(&file);
    wav
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn tts_status<R: Runtime>(app: AppHandle<R>) -> CommandResult<VoiceInstall> {
    Ok(status(&app))
}

/// Downloads NOVA's voice unless it's there or already coming.
#[tauri::command]
pub async fn tts_install<R: Runtime>(app: AppHandle<R>) -> CommandResult<VoiceInstall> {
    let current = status(&app);
    if current == VoiceInstall::Ready || app.state::<TtsState>().downloading.swap(true, Ordering::SeqCst) {
        return Ok(current);
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = install(&handle).await;
        handle.state::<TtsState>().downloading.store(false, Ordering::SeqCst);
        match outcome {
            Ok(()) => set_status(&handle, VoiceInstall::Ready),
            Err(message) => set_status(&handle, VoiceInstall::Failed { message: format!("NOVA's voice couldn't be downloaded: {message}") }),
        }
    });
    Ok(VoiceInstall::Downloading { percent: 0 })
}

/// Speaks `text` with NOVA's voice: returns it as WAV audio.
#[tauri::command]
pub async fn tts_speak<R: Runtime>(app: AppHandle<R>, text: String, rate: f32) -> CommandResult<tauri::ipc::Response> {
    let text = text.trim().to_string();
    if text.is_empty() || text.chars().count() > LONGEST_TEXT {
        return Err("Nothing to say, or too much at once".into());
    }
    let dir = voice_dir(&app)?;
    if !installed(&dir) || app.state::<TtsState>().downloading.load(Ordering::SeqCst) {
        return Err("NOVA's voice isn't downloaded yet".into());
    }
    let handle = app.clone();
    let wav = tauri::async_runtime::spawn_blocking(move || synthesize(&handle.state::<TtsState>(), &dir, &text, rate)).await.map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(wav))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speech_rate_becomes_phoneme_length() {
        assert_eq!(length_for(1.0), 100);
        assert_eq!(length_for(2.0), 50);
        assert_eq!(length_for(0.5), 200);
        assert_eq!(length_for(5.0), 50);
        assert_eq!(length_for(f32::NAN), 100);
    }

    #[cfg(windows)]
    #[test]
    fn hashes_like_sha256() {
        assert_eq!(sha256(b"abc").unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn install_needs_every_file_and_the_current_marker() {
        let dir = std::env::temp_dir().join(format!("nova-tts-test-{}", std::process::id()));
        let f = files(&dir);
        std::fs::create_dir_all(f.exe.parent().unwrap()).unwrap();
        for path in [&f.exe, &f.model, &f.config] {
            std::fs::write(path, b"x").unwrap();
        }
        assert!(!installed(&dir), "no marker yet");
        std::fs::write(&f.marker, "an older voice").unwrap();
        assert!(!installed(&dir), "old marker");
        std::fs::write(&f.marker, MARKER).unwrap();
        assert!(installed(&dir));
        std::fs::remove_file(&f.model).unwrap();
        assert!(!installed(&dir), "model missing");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_serializes_for_the_panel() {
        assert_eq!(serde_json::to_value(VoiceInstall::Downloading { percent: 42 }).unwrap(), serde_json::json!({ "state": "downloading", "percent": 42 }));
        assert_eq!(serde_json::to_value(VoiceInstall::Ready).unwrap(), serde_json::json!({ "state": "ready" }));
    }
}
