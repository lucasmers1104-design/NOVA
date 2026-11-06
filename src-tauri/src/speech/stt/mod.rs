//! Offline speech recognition: Silero VAD finds the phrases, Parakeet turns
//! each one into text as soon as it ends. Used when the user picks it (or
//! "automatic" and it is fast enough here), and when Windows' recognizer
//! isn't available.

pub mod dictation;
pub mod parakeet;
pub mod vad;

use std::time::Instant;

use tauri::{AppHandle, Manager, Runtime};

use crate::storage::{self, Database};

use super::runtime::Device;
use super::{bench, lock, state, SttPref};

pub struct Recognizer {
    pub asr: parakeet::Parakeet,
    pub vad: vad::Vad,
    pub device: Device,
}

/// The recognizer in memory; taken out while a turn uses it.
pub struct LoadedRecognizer {
    pub recognizer: Option<Recognizer>,
    pub device: Device,
    pub last_used: Instant,
}

/// Parakeet and the runtime are downloaded.
pub fn ready<R: Runtime>(app: &AppHandle<R>) -> bool {
    super::recognizer_dir(app).is_some() && super::runtime_dir_for(app).is_some()
}

/// Turns since the last understood one in which Windows heard speech but returned no words at all.
const DEAF_TURNS_KEY: &str = "nova.assistant.windowsDeafTurns";
/// This many, and Windows' dictation counts as not working on this PC (seen
/// when its online service stays silent, with nothing reported as wrong). Speech
/// without one word never happens where dictation works, so once is enough.
const DEAF_LIMIT: u32 = 1;

fn deaf_turns<R: Runtime>(app: &AppHandle<R>) -> u32 {
    app.state::<Database>().with(|c| storage::kv_get(c, DEAF_TURNS_KEY)).ok().flatten().and_then(|v| v.parse().ok()).unwrap_or(0)
}

/// Starts over with Windows' recognizer (the user chose in Settings).
pub fn forget_deaf_turns<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.state::<Database>().with(|c| storage::kv_set(c, DEAF_TURNS_KEY, "0"));
}

/// Records how a Windows turn went (`deaf`: speech but no words; otherwise it
/// understood words). Once it counts as not working, NOVA's offline recognizer
/// takes over and is downloaded if needed. True from then on.
pub fn note_windows_turn<R: Runtime>(app: &AppHandle<R>, deaf: bool) -> bool {
    let turns = if deaf { deaf_turns(app).saturating_add(1) } else { 0 };
    let _ = app.state::<Database>().with(|c| storage::kv_set(c, DEAF_TURNS_KEY, &turns.to_string()));
    if turns < DEAF_LIMIT {
        return false;
    }
    let missing = ["runtime", "parakeet"].into_iter().filter(|id| super::catalog::item(id).is_some_and(|item| !super::installed(app, item)));
    for id in missing {
        let (app, id) = (app.clone(), id.to_string());
        tauri::async_runtime::spawn(async move {
            let _ = super::speech_install(app, id).await;
        });
    }
    true
}

/// Whether this turn uses the offline recognizer.
pub fn use_local<R: Runtime>(app: &AppHandle<R>) -> bool {
    if !ready(app) {
        return false;
    }
    if deaf_turns(app) >= DEAF_LIMIT {
        return true;
    }
    match super::prefs(app).stt {
        SttPref::Windows => false,
        SttPref::Local => true,
        SttPref::Auto => {
            let fast = lock(&state(app).bench).as_ref().and_then(|c| c.cpu("parakeet").or_else(|| c.gpu("parakeet", None)).map(|r| r.rtf)).is_some_and(|rtf| rtf <= 0.5);
            let memory = free_memory() >= 1536 << 20;
            fast && memory && super::prefs(app).mode != bench::Mode::Low
        }
    }
}

/// Memory free right now (the recognizer needs about a gigabyte).
fn free_memory() -> u64 {
    use sysinfo::{MemoryRefreshKind, RefreshKind, System};
    System::new_with_specifics(RefreshKind::nothing().with_memory(MemoryRefreshKind::nothing().with_ram())).map_or(0, |s| s.available_memory())
}

fn open<R: Runtime>(app: &AppHandle<R>) -> Result<Recognizer, String> {
    let runtime = super::runtime(app).ok_or("The speech runtime isn't downloaded")?;
    let dir = super::recognizer_dir(app).ok_or("The offline recognizer isn't downloaded")?;
    let (device, _) = super::plan(app, "parakeet");
    let asr = super::open_guarded(app, &device, || parakeet::Parakeet::open(runtime, &dir, &device))?;
    let vad = vad::Vad::open(runtime, &dir.join("silero_vad.onnx"))?;
    Ok(Recognizer { asr, vad, device })
}

/// The recognizer for a turn (loaded if needed); give it back afterwards.
pub fn take<R: Runtime>(app: &AppHandle<R>) -> Result<Recognizer, String> {
    let wanted = super::plan(app, "parakeet").0;
    // Waits for a load in the background instead of loading a second copy (about a gigabyte).
    let _loading = lock(&LOADING);
    let mut slot = lock(&state(app).stt);
    if let Some(loaded) = slot.as_mut().filter(|l| l.device == wanted) {
        if let Some(recognizer) = loaded.recognizer.take() {
            return Ok(recognizer);
        }
    }
    drop(slot);
    open(app)
}

/// Held while the recognizer loads.
static LOADING: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn give_back<R: Runtime>(app: &AppHandle<R>, mut recognizer: Recognizer) {
    recognizer.vad.reset();
    let device = recognizer.device.clone();
    *lock(&state(app).stt) = Some(LoadedRecognizer { recognizer: Some(recognizer), device, last_used: Instant::now() });
    super::ensure_unloader(app);
}

/// "Hey NOVA" has the recognizer; dictation gets it from there, no need to load another.
pub static WITH_SPOTTER: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Loads the recognizer in the background (NOVA woke up and will listen).
pub fn warm<R: Runtime>(app: &AppHandle<R>) {
    if !use_local(app) || lock(&state(app).stt).is_some() || WITH_SPOTTER.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _loading = lock(&LOADING);
        if lock(&state(&app).stt).is_none() {
            if let Ok(recognizer) = open(&app) {
                give_back(&app, recognizer);
            }
        }
    });
}

/// "Parakeet · CPU · 2 threads" while it is loaded.
pub fn active_label<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    lock(&state(app).stt).as_ref().map(|l| format!("Parakeet · {}", l.device.label()))
}
