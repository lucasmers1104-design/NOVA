//! Offline speech recognition: Silero VAD finds the phrases, Parakeet turns
//! each one into text as soon as it ends. Used when the user picks it (or
//! "automatic" and it is fast enough here), and when Windows' recognizer
//! isn't available.

pub mod dictation;
pub mod parakeet;
pub mod vad;

use std::time::Instant;

use tauri::{AppHandle, Runtime};

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

/// Whether this turn uses the offline recognizer.
pub fn use_local<R: Runtime>(app: &AppHandle<R>) -> bool {
    if !ready(app) {
        return false;
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
    let mut slot = lock(&state(app).stt);
    if let Some(loaded) = slot.as_mut().filter(|l| l.device == wanted) {
        if let Some(recognizer) = loaded.recognizer.take() {
            return Ok(recognizer);
        }
    }
    drop(slot);
    open(app)
}

pub fn give_back<R: Runtime>(app: &AppHandle<R>, mut recognizer: Recognizer) {
    recognizer.vad.reset();
    let device = recognizer.device.clone();
    *lock(&state(app).stt) = Some(LoadedRecognizer { recognizer: Some(recognizer), device, last_used: Instant::now() });
    super::ensure_unloader(app);
}

/// Loads the recognizer in the background (NOVA woke up and will listen).
pub fn warm<R: Runtime>(app: &AppHandle<R>) {
    if !use_local(app) || lock(&state(app).stt).is_some() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(recognizer) = open(&app) {
            give_back(&app, recognizer);
        }
    });
}

/// "Parakeet · CPU · 2 threads" while it is loaded.
pub fn active_label<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    lock(&state(app).stt).as_ref().map(|l| format!("Parakeet · {}", l.device.label()))
}
