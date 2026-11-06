//! NOVA's own speech engines: voices and offline speech recognition running
//! inside NOVA on ONNX Runtime — on the processor or, where it is measurably
//! faster, on the graphics card through DirectML (NVIDIA, AMD and Intel
//! alike). Everything is downloaded on demand and checked before it runs.
//!
//! Every way of speaking has a fallback: an in-process voice falls back to
//! piper.exe (the 1.4 engine), and that to a Windows voice in the panel.
//! Speech recognition stays with Windows unless the user picks the offline
//! recognizer, and falls back to Windows when that isn't ready.

pub mod bench;
pub mod catalog;
pub mod download;
pub mod hardware;
pub mod kokoro;
pub mod phonemize;
pub mod piper;
pub mod probe;
pub mod runtime;
pub mod stt;
pub mod wav;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::storage::{self, Database};
use bench::{BackendPref, Cache, Mode};
use catalog::{Engine, Item, Kind};
use runtime::Device;
use wav::Pcm;

type CommandResult<T> = Result<T, String>;

const PREFS_KEY: &str = "nova.assistant.speech";
const EVENT_STATUS: &str = "speech://status";
const EVENT_BENCH: &str = "speech://bench";
/// Two failures in a row and the in-process voice rests until NOVA restarts.
const FAILURE_LIMIT: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SttPref {
    /// Windows speech recognition (online dictation).
    #[default]
    Windows,
    /// Parakeet on this PC, offline.
    Local,
    /// Offline when it is installed and fast enough here, else Windows.
    Auto,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SpeechPrefs {
    pub mode: Mode,
    pub backend: BackendPref,
    /// The DirectML adapter when `backend` is DirectML (DXGI index).
    pub adapter: Option<u32>,
    pub stt: SttPref,
}

impl Default for SpeechPrefs {
    fn default() -> Self {
        Self { mode: Mode::Auto, backend: BackendPref::Auto, adapter: None, stt: SttPref::Windows }
    }
}

pub fn load_prefs(db: &Database) -> SpeechPrefs {
    db.with(|conn| storage::kv_get(conn, PREFS_KEY)).ok().flatten().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

/// A speech engine in memory.
pub trait TtsEngine: Send {
    fn synthesize(&mut self, text: &str, rate: f32) -> Result<Pcm, String>;
    fn device(&self) -> Device;
}

impl TtsEngine for piper::Piper {
    fn synthesize(&mut self, text: &str, rate: f32) -> Result<Pcm, String> {
        piper::Piper::synthesize(self, text, rate)
    }
    fn device(&self) -> Device {
        piper::Piper::device(self).clone()
    }
}

struct Loaded<E: ?Sized> {
    /// Which item on which device.
    key: (String, Device),
    engine: Box<E>,
    last_used: Instant,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Install {
    Missing,
    Downloading { percent: u8 },
    Ready,
    Failed { message: String },
}

#[derive(Default)]
pub struct SpeechState {
    prefs: Mutex<SpeechPrefs>,
    tts: Mutex<Option<Loaded<dyn TtsEngine>>>,
    pub(crate) stt: Mutex<Option<stt::LoadedRecognizer>>,
    installing: Mutex<HashMap<String, Install>>,
    failures: AtomicU32,
    hardware: OnceLock<hardware::Report>,
    bench: Mutex<Option<Cache>>,
    benchmarking: AtomicBool,
    /// The in-process voice is being loaded in the background.
    voice_loading: AtomicBool,
    /// DirectML crashed NOVA last time (the sentinel was left behind).
    directml_crashed: AtomicBool,
    /// The last engine that spoke, for "now running on".
    last_voice: Mutex<Option<String>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

fn state<R: Runtime>(app: &AppHandle<R>) -> &SpeechState {
    app.state::<SpeechState>().inner()
}

pub fn prefs<R: Runtime>(app: &AppHandle<R>) -> SpeechPrefs {
    lock(&state(app).prefs).clone()
}

/// NOVA's speech folder (`%LOCALAPPDATA%\dev.nova.commandcenter\speech`).
pub fn speech_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map(|d| d.join("speech")).map_err(|e| format!("No local data folder: {e}"))
}

fn item_dir(speech_dir: &Path, item: &Item) -> PathBuf {
    if item.kind == Kind::Runtime {
        runtime::folder(speech_dir)
    } else {
        speech_dir.join(item.id)
    }
}

const MARKER: &str = "ready.txt";

/// All files there, of the right size, and finished (marker written last).
fn installed_in(dir: &Path, item: &Item) -> bool {
    std::fs::read_to_string(dir.join(MARKER)).is_ok_and(|m| m.trim() == item.version)
        && item.files.iter().all(|f| std::fs::metadata(dir.join(f.name)).is_ok_and(|m| m.len() == f.size))
}

pub fn installed<R: Runtime>(app: &AppHandle<R>, item: &Item) -> bool {
    match item.id {
        // Thorsten (medium) comes with the Piper bundle.
        "thorsten" => crate::tts::bundled_voice(app).is_some(),
        _ => speech_dir(app).is_ok_and(|dir| installed_in(&item_dir(&dir, item), item)),
    }
}

/// Model and settings files of a voice.
fn voice_files<R: Runtime>(app: &AppHandle<R>, item: &Item) -> Option<(PathBuf, PathBuf)> {
    if item.id == "thorsten" {
        return crate::tts::bundled_voice(app).map(|v| (v.model, v.config));
    }
    let dir = item_dir(&speech_dir(app).ok()?, item);
    installed_in(&dir, item).then(|| (dir.join("model.onnx"), dir.join(if item.engine == Engine::Kokoro { "voice.npy" } else { "model.onnx.json" })))
}

pub fn hardware<R: Runtime>(app: &AppHandle<R>) -> &hardware::Report {
    state(app).hardware.get_or_init(hardware::detect)
}

fn runtime_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let item = catalog::item("runtime")?;
    let dir = item_dir(&speech_dir(app).ok()?, item);
    installed_in(&dir, item).then_some(dir)
}

/// The speech runtime, loaded on first use (if downloaded).
pub fn runtime<R: Runtime>(app: &AppHandle<R>) -> Option<&'static runtime::Runtime> {
    runtime::loaded().or_else(|| runtime::get(&runtime_dir(app)?).ok())
}

fn sentinel<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    speech_dir(app).ok().map(|d| d.join("directml-pending"))
}

/// Why DirectML must not be used now, if it mustn't.
fn directml_blocked<R: Runtime>(app: &AppHandle<R>) -> Option<&'static str> {
    if state(app).directml_crashed.load(Ordering::SeqCst) {
        Some("NOVA closed unexpectedly while it last used the graphics card")
    } else {
        None
    }
}

/// Where `item` runs now, and why.
pub fn plan<R: Runtime>(app: &AppHandle<R>, item: &str) -> (Device, String) {
    let prefs = prefs(app);
    let cache = lock(&state(app).bench).clone();
    bench::choose(prefs.mode, prefs.backend, prefs.adapter, cache.as_ref(), item, hardware(app), directml_blocked(app))
}

/// Opens a model on `device`; the first use of DirectML is guarded by a
/// sentinel file, so a driver crash makes NOVA use the processor next time.
fn open_guarded<R: Runtime, T>(app: &AppHandle<R>, device: &Device, open: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let guard = device.is_gpu().then(|| sentinel(app)).flatten();
    if let Some(path) = &guard {
        let _ = std::fs::write(path, b"DirectML in use");
    }
    let result = open();
    if let Some(path) = &guard {
        let _ = std::fs::remove_file(path);
    }
    result
}

fn open_voice<R: Runtime>(app: &AppHandle<R>, item: &Item, device: &Device) -> Result<Box<dyn TtsEngine>, String> {
    let runtime = runtime(app).ok_or("The speech runtime isn't downloaded")?;
    let (model, config) = voice_files(app, item).ok_or("This voice isn't downloaded")?;
    match item.engine {
        Engine::Piper => {
            let espeak = crate::tts::bundle_dir(app).ok_or("eSpeak NG (with NOVA's voice) isn't downloaded")?;
            if phonemize::helper_path().is_none() {
                return Err("nova-phonemize.exe is missing".into());
            }
            let engine = open_guarded(app, device, || piper::Piper::open(runtime, &model, &config, device, item.speaker, &espeak))?;
            Ok(Box::new(engine))
        }
        Engine::Kokoro => {
            let espeak = crate::tts::bundle_dir(app).ok_or("eSpeak NG (with NOVA's voice) isn't downloaded")?;
            let engine = open_guarded(app, device, || kokoro::Kokoro::open(runtime, &model, &config, device, &espeak))?;
            Ok(Box::new(engine))
        }
        _ => Err("Not a voice".into()),
    }
}

/// The in-process engine for `item`, loaded (or reloaded for another device).
fn with_voice<R: Runtime, T>(app: &AppHandle<R>, item: &Item, run: impl FnOnce(&mut dyn TtsEngine) -> Result<T, String>) -> Result<T, String> {
    let (device, _) = plan(app, item.id);
    let mut slot = lock(&state(app).tts);
    let key = (item.id.to_string(), device.clone());
    if slot.as_ref().is_none_or(|s| s.key != key) {
        *slot = None;
        let engine = open_voice(app, item, &device)?;
        *slot = Some(Loaded { key, engine, last_used: Instant::now() });
        ensure_unloader(app);
        // piper.exe isn't needed while the voice runs in NOVA.
        crate::tts::stop_exe(app);
    }
    let loaded = slot.as_mut().ok_or("No voice")?;
    loaded.last_used = Instant::now();
    let result = run(loaded.engine.as_mut());
    if result.is_err() {
        *slot = None;
    }
    result
}

/// Whether the in-process engine can speak `item` at all.
fn in_process_possible<R: Runtime>(app: &AppHandle<R>, item: &Item) -> bool {
    state(app).failures.load(Ordering::SeqCst) < FAILURE_LIMIT
        && runtime_dir(app).is_some()
        && voice_files(app, item).is_some()
        && (item.engine != Engine::Piper || phonemize::helper_path().is_some())
}

fn exe_voice<R: Runtime>(app: &AppHandle<R>, item: &Item) -> Option<crate::tts::ExeVoice> {
    if item.engine != Engine::Piper {
        return None;
    }
    let (model, config) = voice_files(app, item)?;
    let speaker = item.speaker.and_then(|name| piper::PiperConfig::parse(&std::fs::read_to_string(&config).ok()?).ok()?.speakers.get(name).copied());
    Some(crate::tts::ExeVoice { model, config, speaker })
}

/// The in-process engine for `item` is in memory (or busy speaking).
fn voice_loaded<R: Runtime>(app: &AppHandle<R>, item: &Item) -> bool {
    let speech = state(app);
    if speech.voice_loading.load(Ordering::SeqCst) {
        return false;
    }
    let (device, _) = plan(app, item.id);
    match speech.tts.try_lock() {
        Ok(slot) => slot.as_ref().is_some_and(|l| l.key == (item.id.to_string(), device)),
        // Someone is speaking with it right now.
        Err(_) => true,
    }
}

/// Loads the in-process voice in the background (once at a time).
fn load_in_background<R: Runtime>(app: &AppHandle<R>, item: &'static Item) {
    if state(app).voice_loading.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // A first sentence also starts the phoneme helper.
        let _ = with_voice(&app, item, |engine| engine.synthesize("Ja.", 1.0).map(|_| ()));
        state(&app).voice_loading.store(false, Ordering::SeqCst);
        publish(&app);
    });
}

/// Speaks `text` with the voice preference `voice` ("nova:…"; None = Thorsten): WAV audio.
pub fn speak<R: Runtime>(app: &AppHandle<R>, voice: Option<&str>, text: &str, rate: f32) -> Result<Vec<u8>, String> {
    let preference = voice.filter(|v| v.starts_with("nova:")).unwrap_or("nova:thorsten");
    let item = catalog::voice(preference).ok_or("Unknown voice")?;
    // Loading the in-process voice takes a few seconds on a small PC; until
    // it is ready, piper.exe (which starts faster) says the first sentences.
    let bridge = in_process_possible(app, item) && !voice_loaded(app, item) && exe_voice(app, item).is_some();
    if bridge {
        load_in_background(app, item);
    } else if in_process_possible(app, item) {
        match with_voice(app, item, |engine| Ok((engine.synthesize(text, rate)?, engine.device()))) {
            Ok((pcm, device)) => {
                state(app).failures.store(0, Ordering::SeqCst);
                *lock(&state(app).last_voice) = Some(format!("{} · {}", item.label, device.label()));
                return Ok(wav::to_wav(&pcm));
            }
            Err(error) => {
                let failures = state(app).failures.fetch_add(1, Ordering::SeqCst) + 1;
                eprintln!("[speech] in-process voice failed ({failures}): {error}");
                if failures >= FAILURE_LIMIT {
                    *lock(&state(app).tts) = None;
                    publish(app);
                }
            }
        }
    }
    let voice = exe_voice(app, item).ok_or_else(|| format!("{} isn't available", item.label))?;
    let wav = crate::tts::speak_with_exe(app, &voice, text, rate)?;
    *lock(&state(app).last_voice) = Some(format!("{} · piper.exe (CPU)", item.label));
    Ok(wav)
}

/// Gets the current voice ready (NOVA woke up).
pub fn warm_voice<R: Runtime>(app: &AppHandle<R>) {
    let preference = crate::agent::prefs(app).voice;
    // An online voice has nothing to load; NOVA's own only steps in if it fails.
    if crate::online_voice::is_online(&preference) {
        return;
    }
    let preference = if preference.starts_with("nova:") { preference } else { "nova:thorsten".into() };
    let Some(item) = catalog::voice(&preference) else { return };
    if prefs(app).mode == Mode::Low && lock(&state(app).tts).is_none() {
        // Low resource: load it when the first sentence comes.
        return;
    }
    let in_process = in_process_possible(app, item);
    if in_process && voice_loaded(app, item) {
        return;
    }
    // piper.exe starts fast and covers the first sentences while the in-process voice loads.
    if let Some(voice) = exe_voice(app, item) {
        crate::tts::warm_exe(app, voice);
    }
    if in_process {
        load_in_background(app, item);
    }
}

fn keep_alive(mode: Mode) -> Option<Duration> {
    match mode {
        Mode::Max => None,
        Mode::Auto => Some(Duration::from_secs(20 * 60)),
        Mode::Low => Some(Duration::from_secs(2 * 60)),
    }
}

static UNLOADER: AtomicBool = AtomicBool::new(false);

/// Unloads idle models (how soon depends on the performance mode).
fn ensure_unloader<R: Runtime>(app: &AppHandle<R>) {
    if UNLOADER.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(15));
        let mode = prefs(&app).mode;
        let Some(limit) = keep_alive(mode) else { continue };
        let speech = state(&app);
        let mut tts = lock(&speech.tts);
        if tts.as_ref().is_some_and(|l| l.last_used.elapsed() >= limit) {
            *tts = None;
            phonemize::stop();
        }
        drop(tts);
        let stt_limit = if mode == Mode::Low { Duration::from_secs(20) } else { Duration::from_secs(5 * 60) };
        let mut stt = lock(&speech.stt);
        if stt.as_ref().is_some_and(|l| l.last_used.elapsed() >= stt_limit) {
            *stt = None;
        }
    });
}

// ---------------------------------------------------------------------------
// Status for Settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemStatus {
    id: &'static str,
    label: &'static str,
    kind: Kind,
    engine: Engine,
    size: u64,
    license: &'static str,
    gender: &'static str,
    quality: &'static str,
    experimental: bool,
    install: Install,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    label: &'static str,
    loaded: bool,
    error: Option<String>,
    /// Where DirectML.dll was loaded from (NOVA's own copy).
    directml: Option<String>,
    phonemizer: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    item: String,
    device: Device,
    reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechStatus {
    prefs: SpeechPrefs,
    hardware: hardware::Report,
    runtime: RuntimeStatus,
    items: Vec<ItemStatus>,
    bench: Option<Cache>,
    /// The cache was made for other hardware, drivers or models.
    bench_stale: bool,
    benchmarking: bool,
    directml_blocked: Option<String>,
    /// Where each installed engine runs now.
    placements: Vec<Placement>,
    /// What spoke last (engine · device).
    last_voice: Option<String>,
    recognizer: Option<String>,
}

fn install_state<R: Runtime>(app: &AppHandle<R>, item: &Item) -> Install {
    if let Some(running) = lock(&state(app).installing).get(item.id) {
        if !matches!(running, Install::Ready) {
            return running.clone();
        }
    }
    if installed(app, item) {
        Install::Ready
    } else {
        Install::Missing
    }
}

fn bench_key<R: Runtime>(app: &AppHandle<R>) -> String {
    let items: Vec<String> = catalog::ITEMS.iter().filter(|i| i.kind != Kind::Runtime && installed(app, i)).map(|i| format!("{}@{}", i.id, i.version)).collect();
    bench::key(hardware(app), &items)
}

pub fn status<R: Runtime>(app: &AppHandle<R>) -> SpeechStatus {
    let speech = state(app);
    let items: Vec<ItemStatus> = catalog::ITEMS
        .iter()
        .map(|i| ItemStatus {
            id: i.id,
            label: i.label,
            kind: i.kind,
            engine: i.engine,
            size: i.size(),
            license: i.license,
            gender: i.gender,
            quality: i.quality,
            experimental: i.experimental,
            install: install_state(app, i),
        })
        .collect();
    let bench = lock(&speech.bench).clone();
    let key = bench_key(app);
    let placements = catalog::ITEMS
        .iter()
        .filter(|i| i.kind != Kind::Runtime && installed(app, i))
        .map(|i| {
            let (device, reason) = plan(app, i.id);
            Placement { item: i.id.to_string(), device, reason }
        })
        .collect();
    SpeechStatus {
        prefs: prefs(app),
        hardware: hardware(app).clone(),
        runtime: RuntimeStatus {
            label: catalog::RUNTIME_VERSION,
            loaded: runtime::loaded().is_some(),
            error: runtime::load_error(),
            directml: runtime::loaded().and_then(|r| r.directml.clone()),
            phonemizer: phonemize::helper_path().is_some(),
        },
        items,
        bench_stale: bench.as_ref().is_some_and(|b| b.key != key),
        bench,
        benchmarking: speech.benchmarking.load(Ordering::SeqCst),
        directml_blocked: directml_blocked(app).map(str::to_string),
        placements,
        last_voice: lock(&speech.last_voice).clone(),
        recognizer: stt::active_label(app),
    }
}

pub fn publish<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit(EVENT_STATUS, status(app));
}

/// Loads preferences and the measurements, and notices a crash during DirectML use.
pub fn init<R: Runtime>(app: &AppHandle<R>, prefs: SpeechPrefs) {
    let speech = state(app);
    *lock(&speech.prefs) = prefs;
    if let Ok(dir) = speech_dir(app) {
        let _ = std::fs::create_dir_all(&dir);
        *lock(&speech.bench) = Cache::load(&dir.join("bench.json"));
        let pending = dir.join("directml-pending");
        if pending.exists() {
            speech.directml_crashed.store(true, Ordering::SeqCst);
            let _ = std::fs::remove_file(pending);
        }
        // Folders of older runtimes can go once nothing holds them.
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with("runtime-") && name != catalog::RUNTIME_FOLDER {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

async fn install<R: Runtime>(app: &AppHandle<R>, item: &'static Item) -> Result<(), String> {
    let dir = item_dir(&speech_dir(app)?, item);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    let _ = std::fs::remove_file(dir.join(MARKER));
    let total = item.size().max(1);
    let mut done = 0u64;
    let last = std::sync::atomic::AtomicU8::new(255);
    for file in item.files {
        let target = dir.join(file.name);
        // Already there from an earlier, interrupted attempt.
        if std::fs::metadata(&target).is_ok_and(|m| m.len() == file.size) && download::sha256_file(&target).is_ok_and(|h| h == file.sha256) {
            done += file.size;
            continue;
        }
        let before = done;
        download::fetch(file, &target, &|n| {
            let percent = ((before + n) * 100 / total).min(99) as u8;
            if last.swap(percent, Ordering::Relaxed) != percent {
                lock(&state(app).installing).insert(item.id.to_string(), Install::Downloading { percent });
                publish(app);
            }
        })
        .await?;
        done += file.size;
    }
    std::fs::write(dir.join(MARKER), item.version).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn speech_status<R: Runtime>(app: AppHandle<R>) -> CommandResult<SpeechStatus> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || status(&handle)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn speech_configure<R: Runtime>(app: AppHandle<R>, prefs: SpeechPrefs) -> CommandResult<SpeechStatus> {
    let json = serde_json::to_string(&prefs).map_err(|e| e.to_string())?;
    app.state::<Database>().with(|c| storage::kv_set(c, PREFS_KEY, &json))?;
    if prefs.stt != lock(&state(&app).prefs).stt {
        stt::forget_deaf_turns(&app);
    }
    *lock(&state(&app).prefs) = prefs;
    // The next sentence loads the voice where the new settings say.
    *lock(&state(&app).tts) = None;
    *lock(&state(&app).stt) = None;
    let status = status(&app);
    let _ = app.emit(EVENT_STATUS, status.clone());
    Ok(status)
}

/// Downloads an item (a voice, the recognizer, the runtime) in the background.
#[tauri::command]
pub async fn speech_install<R: Runtime>(app: AppHandle<R>, id: String) -> CommandResult<SpeechStatus> {
    let item = catalog::item(&id).ok_or("Unknown download")?;
    if item.id == "thorsten" {
        crate::tts::tts_install(app.clone()).await?;
        return Ok(status(&app));
    }
    {
        let mut installing = lock(&state(&app).installing);
        if matches!(installing.get(item.id), Some(Install::Downloading { .. })) {
            drop(installing);
            return Ok(status(&app));
        }
        installing.insert(item.id.to_string(), Install::Downloading { percent: 0 });
    }
    publish(&app);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = install(&handle, item).await;
        let next = match outcome {
            Ok(()) => Install::Ready,
            Err(message) => Install::Failed { message: format!("{} couldn't be downloaded: {message}", item.label) },
        };
        lock(&state(&handle).installing).insert(item.id.to_string(), next);
        publish(&handle);
    });
    Ok(status(&app))
}

/// Removes a downloaded item. The runtime stays in use until NOVA restarts.
#[tauri::command]
pub async fn speech_remove<R: Runtime>(app: AppHandle<R>, id: String) -> CommandResult<SpeechStatus> {
    let item = catalog::item(&id).ok_or("Unknown download")?;
    if item.id == "thorsten" {
        return Err("Thorsten comes with NOVA's voice and stays".into());
    }
    let dir = item_dir(&speech_dir(&app)?, item);
    if item.kind == Kind::Runtime {
        // The DLLs may be loaded: drop the marker now, the folder at the next start.
        let _ = std::fs::remove_file(dir.join(MARKER));
        if runtime::loaded().is_none() {
            let _ = std::fs::remove_dir_all(&dir);
        }
    } else {
        if lock(&state(&app).tts).as_ref().is_some_and(|l| l.key.0 == item.id) {
            *lock(&state(&app).tts) = None;
        }
        if item.kind == Kind::Recognizer {
            *lock(&state(&app).stt) = None;
        }
        std::fs::remove_dir_all(&dir).map_err(|e| format!("Couldn't remove {}: {e}", item.label))?;
    }
    lock(&state(&app).installing).remove(item.id);
    let status = status(&app);
    let _ = app.emit(EVENT_STATUS, status.clone());
    Ok(status)
}

/// Gets the voice (and, for a spoken turn, the recognizer) ready.
#[tauri::command]
pub async fn speech_warm<R: Runtime>(app: AppHandle<R>) -> CommandResult<()> {
    warm_voice(&app);
    stt::warm(&app);
    Ok(())
}

/// Measures every installed model on every device, in separate processes.
#[tauri::command]
pub async fn speech_benchmark<R: Runtime>(app: AppHandle<R>) -> CommandResult<()> {
    if state(&app).benchmarking.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    publish(&app);
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cache = probe::benchmark(&handle, &|progress| {
            let _ = handle.emit(EVENT_BENCH, progress);
        });
        if let Some(cache) = cache {
            if let Ok(dir) = speech_dir(&handle) {
                cache.save(&dir.join("bench.json"));
            }
            *lock(&state(&handle).bench) = Some(cache);
        }
        // Engines reload where the new measurements say.
        *lock(&state(&handle).tts) = None;
        *lock(&state(&handle).stt) = None;
        state(&handle).benchmarking.store(false, Ordering::SeqCst);
        publish(&handle);
    });
    Ok(())
}

/// Everything the benchmark needs about installed items.
pub(crate) struct BenchTarget {
    pub item: &'static Item,
    pub model: PathBuf,
    pub config: PathBuf,
}

pub(crate) fn bench_targets<R: Runtime>(app: &AppHandle<R>) -> Vec<BenchTarget> {
    let mut out = Vec::new();
    for item in catalog::ITEMS.iter().filter(|i| i.kind == Kind::Voice) {
        if let Some((model, config)) = voice_files(app, item) {
            out.push(BenchTarget { item, model, config });
        }
    }
    if let Some(item) = catalog::item("parakeet") {
        if let Ok(dir) = speech_dir(app) {
            let dir = item_dir(&dir, item);
            if installed_in(&dir, item) {
                out.push(BenchTarget { item, model: dir.clone(), config: dir });
            }
        }
    }
    out
}

pub(crate) fn bench_key_for<R: Runtime>(app: &AppHandle<R>) -> String {
    bench_key(app)
}

pub(crate) fn runtime_dir_for<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    runtime_dir(app)
}

pub(crate) fn recognizer_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let item = catalog::item("parakeet")?;
    let dir = item_dir(&speech_dir(app).ok()?, item);
    installed_in(&dir, item).then_some(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefs_default_to_windows_recognition_and_auto() {
        let prefs: SpeechPrefs = serde_json::from_str("{}").unwrap();
        assert_eq!(prefs, SpeechPrefs::default());
        assert_eq!(serde_json::to_value(&prefs).unwrap(), serde_json::json!({ "mode": "auto", "backend": "auto", "adapter": null, "stt": "windows" }));
        let low: SpeechPrefs = serde_json::from_str(r#"{"mode":"low","backend":"directMl","adapter":1,"stt":"local"}"#).unwrap();
        assert_eq!((low.mode, low.backend, low.adapter, low.stt), (Mode::Low, BackendPref::DirectMl, Some(1), SttPref::Local));
    }

    #[test]
    fn an_item_counts_only_when_complete() {
        let dir = std::env::temp_dir().join(format!("nova-speech-test-{}", std::process::id()));
        let item = catalog::item("eva").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!installed_in(&dir, item));
        for file in item.files {
            std::fs::write(dir.join(file.name), vec![0u8; file.size as usize]).unwrap();
        }
        assert!(!installed_in(&dir, item), "no marker yet");
        std::fs::write(dir.join(MARKER), item.version).unwrap();
        assert!(installed_in(&dir, item));
        std::fs::write(dir.join("model.onnx.json"), b"short").unwrap();
        assert!(!installed_in(&dir, item), "a file of the wrong size");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(keep_alive(Mode::Max), None);
        assert!(keep_alive(Mode::Low) < keep_alive(Mode::Auto));
    }
}
