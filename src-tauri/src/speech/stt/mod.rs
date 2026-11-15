//! Offline speech recognition: Silero VAD finds the phrases, Parakeet turns
//! each one into text as soon as it ends. Used when the user picks it (or
//! "automatic" and it is fast enough here), and when Windows' recognizer
//! isn't available.

pub mod dictation;
pub mod parakeet;
pub mod vad;

use std::sync::Arc;
use std::time::Instant;

use tauri::{AppHandle, Manager, Runtime};

use crate::storage::{self, Database};

use super::helper::{RecognizerSpec, Session};
use super::runtime::Device;
use super::{bench, lock, state, SttPref};

/// Turns a phrase (16 kHz mono) into text.
pub trait Transcriber: Send {
    fn transcribe(&mut self, audio: &[f32]) -> Result<String, String>;
}

/// Says how likely each 32 ms of audio is speech.
pub trait SpeechDetector: Send {
    fn probability(&mut self, frame: &[f32]) -> Result<f32, String>;
    fn reset(&mut self);
}

impl Transcriber for parakeet::Parakeet {
    fn transcribe(&mut self, audio: &[f32]) -> Result<String, String> {
        parakeet::Parakeet::transcribe(self, audio)
    }
}

impl SpeechDetector for vad::Vad {
    fn probability(&mut self, frame: &[f32]) -> Result<f32, String> {
        vad::Vad::probability(self, frame)
    }
    fn reset(&mut self) {
        vad::Vad::reset(self)
    }
}

/// Parakeet and the VAD in NOVA's speech process. Two handles on one session,
/// because a turn transcribes a finished phrase while it keeps listening.
struct Remote(Arc<Session>);

impl Transcriber for Remote {
    fn transcribe(&mut self, audio: &[f32]) -> Result<String, String> {
        self.0.transcribe(audio).map_err(String::from)
    }
}

impl SpeechDetector for Remote {
    fn probability(&mut self, frame: &[f32]) -> Result<f32, String> {
        self.0.probability(frame).map_err(String::from)
    }
    fn reset(&mut self) {
        // A process that is gone has nothing left to reset.
        let _ = self.0.reset();
    }
}

pub struct Recognizer {
    pub asr: Box<dyn Transcriber>,
    pub vad: Box<dyn SpeechDetector>,
    pub device: Device,
    /// The speech process it lives in; none for models loaded right here (measurements).
    session: Option<Arc<Session>>,
}

impl Recognizer {
    /// Models loaded in this very process, as the speech process and the measurements do.
    pub fn in_process(asr: parakeet::Parakeet, vad: vad::Vad, device: Device) -> Self {
        Self { asr: Box::new(asr), vad: Box::new(vad), device, session: None }
    }

    pub fn remote(session: Session, device: Device) -> Self {
        let session = Arc::new(session);
        Self { asr: Box::new(Remote(session.clone())), vad: Box::new(Remote(session.clone())), device, session: Some(session) }
    }

    /// Its speech process still runs (always, for models loaded right here).
    pub fn alive(&self) -> bool {
        self.session.as_ref().is_none_or(|session| session.alive())
    }

    /// Its speech process went down by itself while the model ran on the graphics card.
    fn lost_to_directml(&self) -> bool {
        self.device.is_gpu() && self.session.as_ref().is_some_and(|session| session.crashed())
    }
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
/// When that was last seen. A day later Windows gets another chance: an online
/// service comes back, and otherwise nothing would ever try it again.
const DEAF_AT_KEY: &str = "nova.assistant.windowsDeafAt";
const DEAF_FORGOTTEN_AFTER_MS: i64 = 24 * 3_600_000;

fn deaf_turns<R: Runtime>(app: &AppHandle<R>) -> u32 {
    app.state::<Database>().with(|c| storage::kv_get(c, DEAF_TURNS_KEY)).ok().flatten().and_then(|v| v.parse().ok()).unwrap_or(0)
}

fn deaf_counts(at: Option<i64>, now: i64) -> bool {
    at.is_some_and(|at| now - at < DEAF_FORGOTTEN_AFTER_MS)
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
    let _ = app.state::<Database>().with(|c| {
        storage::kv_set(c, DEAF_AT_KEY, &storage::now_millis().to_string())?;
        storage::kv_set(c, DEAF_TURNS_KEY, &turns.to_string())
    });
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
        let at = app.state::<Database>().with(|c| storage::kv_get(c, DEAF_AT_KEY)).ok().flatten().and_then(|v| v.parse().ok());
        if deaf_counts(at, storage::now_millis()) {
            return true;
        }
        forget_deaf_turns(app);
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
    let runtime = super::runtime_dir_for(app).ok_or("The speech runtime isn't downloaded")?;
    let dir = super::recognizer_dir(app).ok_or("The offline recognizer isn't downloaded")?;
    let (device, _) = super::plan(app, "parakeet");
    let spec = RecognizerSpec { runtime, dir, device: device.clone() };
    let helper = &state(app).helpers.recognizer;
    let session = super::open_guarded(app, &device, || helper.open_recognizer(&spec))?;
    Ok(Recognizer::remote(session, device))
}

/// The recognizer for a turn (loaded if needed); give it back afterwards.
pub fn take<R: Runtime>(app: &AppHandle<R>) -> Result<Recognizer, String> {
    let wanted = super::plan(app, "parakeet").0;
    // Waits for a load in the background instead of loading a second copy (about a gigabyte).
    let _loading = lock(&LOADING);
    let mut slot = lock(&state(app).stt);
    if let Some(loaded) = slot.as_mut().filter(|l| l.device == wanted) {
        // One whose speech process ended meanwhile is dropped: a new process loads it again.
        if let Some(recognizer) = loaded.recognizer.take().filter(Recognizer::alive) {
            return Ok(recognizer);
        }
    }
    drop(slot);
    open(app)
}

/// Held while the recognizer loads.
static LOADING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// A turn failed: its recognizer isn't kept, the next turn loads a fresh one.
/// One that a graphics driver took down runs on the processor from then on.
pub fn discard<R: Runtime>(app: &AppHandle<R>, recognizer: Recognizer) {
    if recognizer.lost_to_directml() {
        super::directml_failed(app);
    }
    // With the last handle gone, the idle check ends the speech process.
    super::ensure_unloader(app);
}

pub fn give_back<R: Runtime>(app: &AppHandle<R>, mut recognizer: Recognizer) {
    // Its speech process crashed or was stopped for new settings: nothing to keep.
    if !recognizer.alive() {
        return discard(app, recognizer);
    }
    super::ensure_unloader(app);
    recognizer.vad.reset();
    let device = recognizer.device.clone();
    *lock(&state(app).stt) = Some(LoadedRecognizer { recognizer: Some(recognizer), device, last_used: Instant::now() });
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
    if !state(app).helpers.recognizer.running() {
        return None;
    }
    lock(&state(app).stt).as_ref().map(|l| format!("Parakeet · {}", l.device.label()))
}
