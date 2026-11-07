//! Hands-free wake-up for NOVA AI: "Hey NOVA" and a double clap.
//!
//! Off until the user turns it on. While on, the microphone stays open; its
//! audio is analysed in memory as it arrives and is never recorded, stored or
//! sent. "Hey NOVA" is recognized offline by Windows from a fixed phrase list
//! (see `word`), or by NOVA's own recognizer when that one takes dictation
//! (see `spot`); claps by NOVA's own detector (see `clap`).
//!
//! Listening pauses while NOVA takes dictation or speaks, while the PC is
//! locked, during presentations and, if the user wants, while a game runs.

pub mod clap;
#[cfg(windows)]
pub(crate) mod mic;
#[cfg(windows)]
mod spot;
#[cfg(windows)]
mod word;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::storage::Database;
use clap::Sensitivity;

type CommandResult<T> = Result<T, String>;

const PREFS_KEY: &str = "nova.assistant.wake";
const EVENT_STATUS: &str = "wake://status";
const EVENT_HEARD: &str = "wake://heard";

/// The phrase that wakes NOVA, as Windows should recognize it.
const WAKE_PHRASE: &str = "hey nova";
/// Common and similar-sounding phrases in the same list, so that speech which
/// only resembles the wake phrase matches one of these instead of it.
/// How else people say it; Windows only hears what is on its list.
const WAKE_VARIANTS: &[&str] = &["hi nova", "hei nova", "hallo nova", "hey nowa"];
const DECOYS: &[&str] = &[
    "hey", "nova", "hallo", "okay", "ja", "nein", "danke", "genau", "na ja", "hey noah", "hey nora", "hey du", "hey leute", "hey google", "okay google", "hey siri",
    "alexa", "hey cortana",
];
/// A test in Settings ends by itself after this long.
const TEST_LENGTH: Duration = Duration::from_secs(120);
/// Spoken replies longer than this no longer pause listening (a lost "done").
const SPEAKING_LIMIT: Duration = Duration::from_secs(90);
/// After NOVA stops speaking, listening resumes only after this long: NOVA
/// usually starts listening for an answer right away, and a recognizer
/// started in between would hold the microphone while it does.
const SPEAKING_SETTLE: Duration = Duration::from_millis(1500);
/// Longest wait for the wake listeners to let go of the microphone before dictation.
const RELEASE_WAIT: Duration = Duration::from_secs(4);
/// Two wake-ups closer than this are one.
const WAKE_DEBOUNCE: Duration = Duration::from_secs(3);
/// Keyboard or mouse input this close to a clap means it was probably a key or a click.
const INPUT_VETO: Duration = Duration::from_millis(300);
/// Speaker output this loud (peak × volume) around a clap means the sound came from the PC.
const SPEAKER_VETO: f32 = 0.2;

// ---------------------------------------------------------------------------
// Preferences and status
// ---------------------------------------------------------------------------

/// What NOVA does once it wakes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AfterWake {
    /// Open NOVA AI and listen for a spoken request.
    #[default]
    Listen,
    /// Just open NOVA AI.
    Open,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WakePrefs {
    /// Wake on "Hey NOVA".
    pub phrase: bool,
    pub phrase_sensitivity: Sensitivity,
    /// Wake on a double clap.
    pub clap: bool,
    pub clap_sensitivity: Sensitivity,
    pub after_wake: AfterWake,
    /// A short sound when NOVA wakes.
    pub chime: bool,
    /// Keep listening while a game or other fullscreen app is in front: NOVA then
    /// answers by voice, without its window. Presentations always pause it.
    pub in_games: bool,
    /// Paused from the dot's menu: the microphone is closed until resumed.
    pub muted: bool,
}

impl Default for WakePrefs {
    fn default() -> Self {
        Self {
            phrase: false,
            phrase_sensitivity: Sensitivity::Strict,
            clap: false,
            clap_sensitivity: Sensitivity::Strict,
            after_wake: AfterWake::Listen,
            chime: true,
            in_games: true,
            muted: false,
        }
    }
}

pub fn load_prefs(db: &Database) -> WakePrefs {
    db.with(|conn| crate::storage::kv_get(conn, PREFS_KEY))
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Why listening is paused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Pause {
    /// "Pause listening" in the dot's menu.
    Muted,
    Dictation,
    Speaking,
    Locked,
    Fullscreen,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Listener {
    #[default]
    Off,
    Starting,
    Listening,
    Paused { reason: Pause },
    /// It can't run; `settings` names the Windows settings page that fixes it.
    Unavailable { message: String, settings: Option<&'static str> },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeStatus {
    prefs: WakePrefs,
    phrase: Listener,
    clap: Listener,
    /// Listening after waking needs Windows' online speech recognition.
    dictation: bool,
    testing: bool,
}

/// How sure Windows was about a phrase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Confidence {
    High,
    Medium,
    Low,
    Rejected,
}

/// Why a double clap didn't wake NOVA.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Veto {
    /// Someone typed or clicked at the same moment.
    Typing,
    /// The sound came from the PC's speakers.
    Speakers,
    /// Listening is paused (dictation, speech, fullscreen).
    Paused,
}

/// What the test in Settings shows; only sent while a test runs.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Heard {
    /// Microphone level 0–1, about ten times a second.
    Level { value: f32 },
    Phrase { text: String, confidence: Confidence, accepted: bool },
    Clap { level_db: f32 },
    NotAClap { level_db: f32, reason: clap::NotAClap },
    NotADouble { reason: clap::NotADouble },
    Double { veto: Option<Veto> },
}

/// What woke NOVA.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Phrase,
    Clap,
    /// A routine's time has come.
    Schedule,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Inner {
    prefs: WakePrefs,
    /// Dictation sessions in progress (a new one can begin before the last one
    /// has reported that it ended).
    dictating: u32,
    speaking_until: Option<Instant>,
    testing_until: Option<Instant>,
    phrase: Listener,
    clap: Listener,
    /// The supervisor thread is running.
    running: bool,
    /// No phrase recognizer is open (dictation may start its own).
    phrase_idle: bool,
    /// The clap detector doesn't hold the microphone.
    clap_idle: bool,
    last_wake: Option<Instant>,
    last_status: Option<WakeStatus>,
}

#[derive(Default)]
pub struct WakeState {
    inner: Mutex<Inner>,
    changed: Condvar,
    /// Claps are heard but must not wake NOVA (dictation, speech, fullscreen).
    suppressed: AtomicBool,
    testing: AtomicBool,
}

impl WakeState {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn state<R: Runtime>(app: &AppHandle<R>) -> &WakeState {
    app.state::<WakeState>().inner()
}

fn testing(inner: &Inner) -> bool {
    inner.testing_until.is_some_and(|until| Instant::now() < until)
}

fn speaking(inner: &Inner) -> bool {
    inner.speaking_until.is_some_and(|until| Instant::now() < until)
}

fn status_of(inner: &Inner) -> WakeStatus {
    WakeStatus { prefs: inner.prefs.clone(), phrase: inner.phrase.clone(), clap: inner.clap.clone(), dictation: dictation_allowed(), testing: testing(inner) }
}

/// Sends the status to the windows if it changed.
fn publish<R: Runtime>(app: &AppHandle<R>) {
    let status = {
        let mut inner = state(app).lock();
        let status = status_of(&inner);
        if inner.last_status.as_ref() == Some(&status) {
            return;
        }
        inner.last_status = Some(status.clone());
        status
    };
    let _ = app.emit(EVENT_STATUS, status);
}

fn heard<R: Runtime>(app: &AppHandle<R>, what: Heard) {
    // Development: NOVA_WAKE_LOG=1 prints everything the listener hears.
    if cfg!(debug_assertions) && !matches!(what, Heard::Level { .. }) && std::env::var_os("NOVA_WAKE_LOG").is_some() {
        eprintln!("[wake] {what:?}");
    }
    if state(app).testing.load(Ordering::Relaxed) {
        let _ = app.emit(EVENT_HEARD, what);
    }
}

#[cfg(windows)]
fn dictation_allowed() -> bool {
    mic::dictation_allowed()
}

#[cfg(not(windows))]
fn dictation_allowed() -> bool {
    false
}

/// Startup: begin listening if the user turned it on.
pub fn init<R: Runtime>(app: &AppHandle<R>, prefs: WakePrefs) {
    state(app).lock().prefs = prefs;
    ensure_running(app);
    // Development: NOVA_DEV_WAKE_AFTER=<seconds> acts as if a double clap was heard.
    if let Some(seconds) = std::env::var("NOVA_DEV_WAKE_AFTER").ok().filter(|_| cfg!(debug_assertions)).and_then(|s| s.parse::<u64>().ok()) {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(seconds));
            wake_up(&app, Source::Clap, None);
        });
    }
}

fn ensure_running<R: Runtime>(app: &AppHandle<R>) {
    let state = state(app);
    {
        let mut inner = state.lock();
        let wanted = inner.prefs.phrase || inner.prefs.clap || testing(&inner);
        if !wanted || inner.running {
            state.changed.notify_all();
            return;
        }
        inner.running = true;
        inner.phrase_idle = true;
        inner.clap_idle = true;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        // A panic must not leave `running` set forever (nothing would restart it).
        #[cfg(windows)]
        let _ = crate::shell::with_com(false, || {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| supervise(&app))).is_err() {
                // Don't spin if it panics right away again.
                std::thread::sleep(Duration::from_secs(5));
            }
            Ok(())
        });
        let state = self::state(&app);
        {
            let mut inner = state.lock();
            inner.running = false;
            inner.phrase_idle = true;
            inner.clap_idle = true;
            inner.phrase = Listener::Off;
            inner.clap = Listener::Off;
        }
        state.changed.notify_all();
        publish(&app);
        // Turned on again while this thread was winding down.
        ensure_running(&app);
    });
}

/// Dictation opens its own recognizer: stop the phrase listener and the clap
/// detector first (and wait until both have let go of the microphone), start
/// them again afterwards.
pub fn pause_for_dictation<R: Runtime>(app: &AppHandle<R>, dictating: bool) {
    let state = state(app);
    let mut inner = state.lock();
    inner.dictating = dictation_count(inner.dictating, dictating);
    if dictating {
        // Clearing it is left to the supervisor, which knows about every other pause.
        state.suppressed.store(true, Ordering::SeqCst);
    }
    state.changed.notify_all();
    let deadline = Instant::now() + RELEASE_WAIT;
    while dictating && inner.running && !(inner.phrase_idle && inner.clap_idle) {
        let Some(left) = deadline.checked_duration_since(Instant::now()) else { break };
        inner = state.changed.wait_timeout(inner, left).unwrap_or_else(|p| p.into_inner()).0;
    }
}

/// Counts overlapping dictation sessions: the end of one must not resume
/// listening while the next has already begun.
fn dictation_count(count: u32, started: bool) -> u32 {
    if started {
        count.saturating_add(1)
    } else {
        count.saturating_sub(1)
    }
}

/// Opens NOVA AI after a wake word or a double clap (unless a test runs).
/// `request`: what was said right after the call, which then goes straight to NOVA AI.
fn wake_up<R: Runtime>(app: &AppHandle<R>, source: Source, request: Option<String>) {
    let prefs = {
        let mut inner = state(app).lock();
        if testing(&inner) || inner.dictating > 0 || inner.last_wake.is_some_and(|at| at.elapsed() < WAKE_DEBOUNCE) {
            return;
        }
        inner.last_wake = Some(Instant::now());
        inner.prefs.clone()
    };
    // Listening needs Windows' online recognition, or NOVA's offline one.
    let listen = prefs.after_wake == AfterWake::Listen && (dictation_allowed() || crate::speech::stt::ready(app));
    if cfg!(debug_assertions) && std::env::var_os("NOVA_WAKE_LOG").is_some() {
        eprintln!("[wake] woke by {source:?} (listen: {listen})");
    }
    crate::assistant::wake(app, source, listen, prefs.chime, request);
}

/// Whether a phrase Windows heard should wake NOVA.
fn accepts(text: &str, confidence: Confidence, raw: f64, duration_ms: i64, sensitivity: Sensitivity) -> bool {
    let sure = match sensitivity {
        Sensitivity::Strict => confidence == Confidence::High || (confidence == Confidence::Medium && raw >= 0.7),
        Sensitivity::Normal => confidence == Confidence::High || (confidence == Confidence::Medium && raw >= 0.4),
    };
    // "Hey NOVA" takes about half a second to a second; 0 means Windows didn't say.
    let plausible = duration_ms == 0 || (250..=2500).contains(&duration_ms);
    let text = text.trim();
    (text.eq_ignore_ascii_case(WAKE_PHRASE) || WAKE_VARIANTS.iter().any(|variant| text.eq_ignore_ascii_case(variant))) && sure && plausible
}

// ---------------------------------------------------------------------------
// Listening (Windows)
// ---------------------------------------------------------------------------

#[cfg(windows)]
struct ClapThread {
    stop: std::sync::Arc<AtomicBool>,
    handle: std::thread::JoinHandle<Result<(), mic::MicError>>,
}

#[cfg(windows)]
impl ClapThread {
    fn start<R: Runtime>(app: &AppHandle<R>) -> Self {
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let app = app.clone();
        let handle = std::thread::spawn(move || {
            let mut outcome = Ok(());
            let _ = crate::shell::with_com(false, || {
                outcome = listen_for_claps(&app, &flag);
                Ok(())
            });
            outcome
        });
        Self { stop, handle }
    }

    fn stop(self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.handle.join();
    }
}

#[cfg(windows)]
fn mic_problem(error: &mic::MicError) -> Listener {
    match error {
        mic::MicError::Denied => Listener::Unavailable {
            message: "Windows doesn't let NOVA use the microphone. Allow desktop apps to access it in Windows Settings → Privacy → Microphone.".into(),
            settings: Some("privacy-microphone"),
        },
        mic::MicError::Missing => Listener::Unavailable { message: "No microphone was found.".into(), settings: None },
        mic::MicError::Lost => Listener::Unavailable { message: "The microphone was disconnected. NOVA keeps trying.".into(), settings: None },
        mic::MicError::Other(code) => Listener::Unavailable { message: format!("The microphone couldn't be opened ({code})."), settings: None },
    }
}

/// What listens for "Hey NOVA".
#[cfg(windows)]
enum PhraseSource {
    Windows(word::PhraseListener),
    Offline(spot::Spotter),
}

#[cfg(windows)]
impl PhraseSource {
    fn ended(&self) -> bool {
        match self {
            PhraseSource::Windows(listener) => listener.ended(),
            PhraseSource::Offline(spotter) => spotter.ended(),
        }
    }
}

/// Keeps the listeners in line with the preferences and pauses until both are turned off.
#[cfg(windows)]
fn supervise<R: Runtime>(app: &AppHandle<R>) {
    let state = state(app);
    // The listener, its language (or that it is the offline one) and when it started.
    let mut phrase: Option<(PhraseSource, String, Instant)> = None;
    let mut phrase_retry = Instant::now();
    let mut phrase_failure: Option<Listener> = None;
    let mut claps: Option<ClapThread> = None;
    let mut clap_retry = Instant::now();
    let mut clap_failure: Option<Listener> = None;
    // Whether a fullscreen app is in front, and when that was last checked.
    let mut fullscreen: (bool, Option<Instant>) = (false, None);

    loop {
        let snapshot = |inner: &Inner| (inner.prefs.clone(), inner.dictating > 0, speaking(inner), testing(inner));
        let (prefs, dictating, speaking_now, test) = {
            let mut inner = state.lock();
            if inner.testing_until.is_some() && !testing(&inner) {
                inner.testing_until = None;
            }
            snapshot(&inner)
        };
        state.testing.store(test, Ordering::Relaxed);
        let want_phrase = prefs.phrase || test;
        let want_clap = prefs.clap || test;
        if !want_phrase && !want_clap {
            break;
        }
        if fullscreen.1.is_none_or(|checked| checked.elapsed() >= Duration::from_secs(2)) {
            let paused = crate::assistant::presenting() || (!prefs.in_games && crate::assistant::fullscreen_in_front());
            fullscreen = (paused, Some(Instant::now()));
        }
        let locked = mic::session_locked();
        let muted = prefs.muted && !test;
        let pause = if muted {
            Some(Pause::Muted)
        } else if locked {
            Some(Pause::Locked)
        } else if dictating {
            Some(Pause::Dictation)
        } else if speaking_now {
            Some(Pause::Speaking)
        } else if fullscreen.0 && !test {
            Some(Pause::Fullscreen)
        } else {
            None
        };
        state.suppressed.store(pause.is_some(), Ordering::SeqCst);

        // "Hey NOVA": the recognizer is closed while paused.
        // Where Windows' dictation returns nothing, its phrase spotting does too: same engine.
        let offline = want_phrase && crate::speech::stt::use_local(app);
        let language = if offline { "offline".to_string() } else { crate::agent::prefs(app).language };
        if let Some((listener, lang, started)) = &phrase {
            if listener.ended() {
                // A session that ends again right away (no microphone, audio
                // problem) must not be restarted every second.
                if started.elapsed() < Duration::from_secs(10) {
                    phrase_retry = Instant::now() + Duration::from_secs(10);
                }
                phrase = None;
            } else if *lang != language {
                phrase = None;
            }
        }
        let phrase_state = if !want_phrase {
            phrase = None;
            phrase_failure = None;
            Listener::Off
        } else if let Some(reason) = pause {
            phrase = None;
            Listener::Paused { reason }
        } else if phrase.is_some() {
            Listener::Listening
        } else if Instant::now() >= phrase_retry {
            // Dictation that began after the snapshot above must not find a
            // recognizer starting here: either it sees one coming (and waits
            // for it to close) or this sees the dictation and leaves it.
            let dictation_began = {
                let mut inner = state.lock();
                let began = inner.dictating > 0;
                if !began {
                    inner.phrase = Listener::Starting;
                    inner.phrase_idle = false;
                }
                began
            };
            if dictation_began {
                Listener::Paused { reason: Pause::Dictation }
            } else {
                publish(app);
                let started = if offline {
                    spot::Spotter::start(app, on_phrase(app)).map(PhraseSource::Offline)
                } else {
                    let mut phrases = vec![WAKE_PHRASE];
                    phrases.extend_from_slice(WAKE_VARIANTS);
                    phrases.extend_from_slice(DECOYS);
                    word::PhraseListener::start(&language, &phrases, on_phrase(app)).map(PhraseSource::Windows)
                };
                match started {
                    Ok(listener) => {
                        phrase = Some((listener, language, Instant::now()));
                        phrase_failure = None;
                        Listener::Listening
                    }
                    Err(error) => {
                        phrase_retry = Instant::now() + Duration::from_secs(30);
                        let failure = Listener::Unavailable { message: error.message, settings: error.settings };
                        phrase_failure = Some(failure.clone());
                        failure
                    }
                }
            }
        } else {
            phrase_failure.clone().unwrap_or(Listener::Starting)
        };

        // Claps: the microphone closes while NOVA talks with the user (two
        // streams on one microphone can leave dictation without sound) and
        // while the PC is locked; it stays open through other pauses, which
        // only make it ignore claps.
        if claps.as_ref().is_some_and(|thread| thread.handle.is_finished()) {
            if let Some(thread) = claps.take() {
                if let Ok(Err(error)) = thread.handle.join() {
                    clap_retry = Instant::now() + if error == mic::MicError::Lost { Duration::from_secs(3) } else { Duration::from_secs(30) };
                    clap_failure = Some(mic_problem(&error));
                }
            }
        }
        let closed = pause.filter(|reason| matches!(reason, Pause::Muted | Pause::Locked | Pause::Dictation | Pause::Speaking));
        let clap_state = if !want_clap || closed.is_some() {
            if let Some(thread) = claps.take() {
                thread.stop();
            }
            clap_failure = None;
            match closed {
                Some(reason) if want_clap => Listener::Paused { reason },
                _ => Listener::Off,
            }
        } else {
            if claps.is_none() && Instant::now() >= clap_retry {
                claps = Some(ClapThread::start(app));
                clap_failure = None;
            }
            match (&claps, pause, &clap_failure) {
                (Some(_), Some(reason), _) => Listener::Paused { reason },
                (Some(_), None, _) => Listener::Listening,
                (None, _, Some(failure)) => failure.clone(),
                (None, _, None) => Listener::Starting,
            }
        };

        {
            let mut inner = state.lock();
            inner.phrase = phrase_state;
            inner.clap = clap_state;
            inner.phrase_idle = phrase.is_none();
            inner.clap_idle = claps.is_none();
        }
        state.changed.notify_all();
        publish(app);

        // Sleep unless something changed since the snapshot (a notification
        // sent while this iteration ran would otherwise be lost for a second).
        let inner = state.lock();
        if snapshot(&inner) == (prefs, dictating, speaking_now, test) {
            let _ = state.changed.wait_timeout(inner, Duration::from_secs(1));
        }
    }

    drop(phrase);
    if let Some(thread) = claps.take() {
        thread.stop();
    }
}

/// Handles what the phrase recognizer heard (on a Windows thread-pool thread).
#[cfg(windows)]
fn on_phrase<R: Runtime>(app: &AppHandle<R>) -> impl Fn(word::Heard) + Send + Sync + 'static {
    let app = app.clone();
    move |phrase: word::Heard| {
        let state = self::state(&app);
        let sensitivity = state.lock().prefs.phrase_sensitivity;
        let accepted = accepts(&phrase.text, phrase.confidence, phrase.raw, phrase.duration_ms, sensitivity) && !state.suppressed.load(Ordering::SeqCst);
        heard(&app, Heard::Phrase { text: phrase.text, confidence: phrase.confidence, accepted });
        if accepted {
            wake_up(&app, Source::Phrase, phrase.request);
        }
    }
}

/// Runs the clap detector on the microphone until `stop` is set.
#[cfg(windows)]
fn listen_for_claps<R: Runtime>(app: &AppHandle<R>, stop: &AtomicBool) -> Result<(), mic::MicError> {
    use std::collections::VecDeque;

    let state = state(app);
    let mut detector: Option<clap::ClapDetector> = None;
    let mut sensitivity = state.lock().prefs.clap_sensitivity;
    // When the keyboard or mouse was last used, and how loud the speakers were.
    let mut inputs: VecDeque<Instant> = VecDeque::new();
    let mut speakers = mic::Speakers::open();
    let mut speakers_opened = Instant::now();
    let mut loudness: VecDeque<(Instant, f32)> = VecDeque::new();
    // When listening was last paused: claps from just before a pause ended
    // (NOVA's own voice, a video) are reported only after it.
    let mut last_paused: Option<Instant> = None;
    let mut level = (0.0f32, Instant::now());

    mic::capture(stop, |samples, rate| {
        let now = Instant::now();
        if state.suppressed.load(Ordering::SeqCst) {
            last_paused = Some(now);
        }
        if let Some(last_input) = last_input(now, mic::input_idle_ms()) {
            if inputs.back().is_none_or(|previous| last_input > *previous + Duration::from_millis(5)) {
                inputs.push_back(last_input);
            }
        }
        while inputs.front().is_some_and(|t| now.duration_since(*t) > Duration::from_secs(5)) {
            inputs.pop_front();
        }
        // Follow changes of the default output device now and then.
        if speakers_opened.elapsed() > Duration::from_secs(30) {
            speakers = mic::Speakers::open();
            speakers_opened = now;
        }
        let loud = speakers.as_ref().and_then(|s| s.loudness());
        if loud.is_none() {
            speakers = None;
        }
        loudness.push_back((now, loud.unwrap_or(0.0)));
        while loudness.front().is_some_and(|(t, _)| now.duration_since(*t) > Duration::from_secs(3)) {
            loudness.pop_front();
        }

        let wanted = state.lock().prefs.clap_sensitivity;
        let detector = detector.get_or_insert_with(|| clap::ClapDetector::new(rate, wanted));
        if wanted != sensitivity {
            sensitivity = wanted;
            detector.set_sensitivity(wanted);
        }
        detector.push(samples);
        let elapsed = detector.elapsed_ms();
        let at = |ms: u64| now.checked_sub(Duration::from_millis(elapsed.saturating_sub(ms))).unwrap_or(now);
        for event in detector.drain() {
            match event {
                clap::Event::Clap { level_db, .. } => heard(app, Heard::Clap { level_db }),
                clap::Event::NotAClap { level_db, reason, .. } => heard(app, Heard::NotAClap { level_db, reason }),
                clap::Event::NotADouble { reason, .. } => heard(app, Heard::NotADouble { reason }),
                clap::Event::Double { first_ms, second_ms } => {
                    // Forgiving: sound in a headset doesn't reach the microphone, so playing music mustn't block claps.
                    let veto = clap_veto(at(first_ms), at(second_ms), last_paused, &inputs, &loudness).filter(|veto| sensitivity == Sensitivity::Strict || *veto != Veto::Speakers);
                    heard(app, Heard::Double { veto });
                    if veto.is_none() {
                        wake_up(app, Source::Clap, None);
                    }
                }
            }
        }
        if cfg!(debug_assertions) && std::env::var_os("NOVA_WAKE_LOG").is_some() && elapsed / 10_000 != elapsed.saturating_sub(samples.len() as u64 * 1000 / rate.max(1) as u64) / 10_000 {
            eprintln!("[wake] {} s: noise floor {:.4}, rate {rate}", elapsed / 1000, detector.noise_floor());
        }
        if state.testing.load(Ordering::Relaxed) {
            let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
            level.0 = level.0.max(peak);
            if level.1.elapsed() >= Duration::from_millis(100) {
                heard(app, Heard::Level { value: level.0.min(1.0) });
                level = (0.0, Instant::now());
            }
        }
    })
}

/// When the keyboard or mouse was last used, from the idle time; None when
/// Windows couldn't say (`u32::MAX`), so that it isn't taken for input now.
#[cfg_attr(not(windows), allow(dead_code))]
fn last_input(now: Instant, idle_ms: u32) -> Option<Instant> {
    if idle_ms == u32::MAX {
        return None;
    }
    now.checked_sub(Duration::from_millis(idle_ms as u64))
}

/// Why a double clap with claps at `first` and `second` must not wake NOVA:
/// listening was paused at or after the first clap, someone typed or clicked
/// around them, or the speakers were loud right then.
#[cfg_attr(not(windows), allow(dead_code))]
fn clap_veto(first: Instant, second: Instant, last_paused: Option<Instant>, inputs: &std::collections::VecDeque<Instant>, loudness: &std::collections::VecDeque<(Instant, f32)>) -> Option<Veto> {
    let near = |t: Instant, around: Instant, window: Duration| t + window >= around && t <= around + window;
    if last_paused.is_some_and(|t| t + INPUT_VETO >= first) {
        Some(Veto::Paused)
    } else if inputs.iter().any(|t| *t + INPUT_VETO >= first && *t <= second + INPUT_VETO) {
        Some(Veto::Typing)
    } else if loudness.iter().any(|(t, l)| *l >= SPEAKER_VETO && (near(*t, first, Duration::from_millis(120)) || near(*t, second, Duration::from_millis(120)))) {
        Some(Veto::Speakers)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn wake_status<R: Runtime>(app: AppHandle<R>) -> CommandResult<WakeStatus> {
    Ok(status_of(&state(&app).lock()))
}

#[tauri::command]
pub async fn wake_configure<R: Runtime>(app: AppHandle<R>, prefs: WakePrefs) -> CommandResult<WakeStatus> {
    let json = serde_json::to_string(&prefs).map_err(|e| e.to_string())?;
    app.state::<Database>().with(|conn| crate::storage::kv_set(conn, PREFS_KEY, &json))?;
    state(&app).lock().prefs = prefs;
    ensure_running(&app);
    publish(&app);
    Ok(status_of(&state(&app).lock()))
}

/// Whether "Hey NOVA" or the double clap is turned on, and if so whether it is paused.
pub fn listening<R: Runtime>(app: &AppHandle<R>) -> Option<bool> {
    let prefs = state(app).lock().prefs.clone();
    (prefs.phrase || prefs.clap).then_some(!prefs.muted)
}

/// "Pause listening" / "Resume listening" from the dot's menu.
pub fn toggle_muted<R: Runtime>(app: &AppHandle<R>) {
    let prefs = {
        let mut inner = state(app).lock();
        inner.prefs.muted = !inner.prefs.muted;
        inner.prefs.clone()
    };
    if let Ok(json) = serde_json::to_string(&prefs) {
        let _ = app.state::<Database>().with(|conn| crate::storage::kv_set(conn, PREFS_KEY, &json));
    }
    ensure_running(app);
    publish(app);
}

/// Starts (or ends) a test in Settings: what NOVA hears is shown, nothing opens.
#[tauri::command]
pub async fn wake_test<R: Runtime>(app: AppHandle<R>, on: bool) -> CommandResult<WakeStatus> {
    {
        let state = state(&app);
        let mut inner = state.lock();
        inner.testing_until = on.then(|| Instant::now() + TEST_LENGTH);
        state.testing.store(on, Ordering::Relaxed);
    }
    ensure_running(&app);
    publish(&app);
    Ok(status_of(&state(&app).lock()))
}

/// NOVA started or stopped reading a reply aloud (its own voice must not wake it).
#[tauri::command]
pub async fn wake_set_speaking<R: Runtime>(app: AppHandle<R>, speaking: bool) -> CommandResult<()> {
    let state = state(&app);
    let mut inner = state.lock();
    // Done speaking still pauses listening for a moment (see SPEAKING_SETTLE).
    inner.speaking_until = Some(Instant::now() + if speaking { SPEAKING_LIMIT } else { SPEAKING_SETTLE });
    if speaking {
        // Clearing it is left to the supervisor, which knows about every other pause.
        state.suppressed.store(true, Ordering::SeqCst);
    }
    state.changed.notify_all();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Prints what the wake listeners make of the real microphone for 150 seconds
    /// (decisions and levels only, nothing is kept), by hand:
    /// `cargo test --lib -- --ignored hears_live --nocapture`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn hears_live() {
        crate::shell::with_com(false, || {
            let started = Instant::now();
            let stop = std::sync::Arc::new(AtomicBool::new(false));
            // NOVA's own phrase spotting, on its own thread, from NOVA_RUNTIME and NOVA_PARAKEET.
            let spotting = stop.clone();
            let spotter = std::thread::spawn(move || {
                let runtime = crate::speech::runtime::get(std::path::Path::new(&std::env::var("NOVA_RUNTIME").unwrap())).unwrap();
                let dir = std::path::PathBuf::from(std::env::var("NOVA_PARAKEET").unwrap());
                let device = crate::speech::runtime::Device::Cpu { threads: 4 };
                let asr = crate::speech::stt::parakeet::Parakeet::open(runtime, &dir, &device).unwrap();
                let vad = crate::speech::stt::vad::Vad::open(runtime, &dir.join("silero_vad.onnx")).unwrap();
                let mut recognizer = crate::speech::stt::Recognizer { asr, vad, device };
                println!("spotter ready after {} s", started.elapsed().as_secs());
                crate::shell::with_com(false, || spot::listen(&mut recognizer, &spotting, &|heard| println!("{:>4}s phrase accepted={} {}", started.elapsed().as_secs(), heard.confidence == Confidence::High, heard.text.chars().count()))).unwrap();
            });
            let speakers = mic::Speakers::open();
            let mut detector: Option<clap::ClapDetector> = None;
            let (mut peak, mut last) = (0f32, 0u64);
            mic::capture(&stop, |samples, rate| {
                let detector = detector.get_or_insert_with(|| clap::ClapDetector::new(rate, Sensitivity::Normal));
                peak = samples.iter().fold(peak, |m, s| m.max(s.abs()));
                detector.push(samples);
                let at = started.elapsed().as_secs();
                let loud = speakers.as_ref().and_then(|s| s.loudness()).unwrap_or(0.0);
                for event in detector.drain() {
                    println!("{at:>4}s {event:?} (speakers {loud:.2})");
                }
                if at >= last + 15 {
                    println!("{at:>4}s peak {peak:.3}, noise floor {:.4}, speakers {loud:.2}", detector.noise_floor());
                    (peak, last) = (0.0, at);
                }
                if at >= 150 {
                    stop.store(true, Ordering::Relaxed);
                }
            })
            .map_err(|e| format!("{e:?}"))?;
            spotter.join().map_err(|_| "spotter failed".to_string())
        })
        .unwrap();
    }

    #[test]
    fn wake_phrase_needs_confidence() {
        assert!(accepts("hey nova", Confidence::High, 0.9, 700, Sensitivity::Strict));
        assert!(accepts("Hey Nova ", Confidence::High, 0.9, 0, Sensitivity::Strict));
        assert!(accepts("hi nova", Confidence::High, 0.9, 700, Sensitivity::Strict));
        assert!(accepts("hey nova", Confidence::Medium, 0.8, 700, Sensitivity::Strict));
        // What NOVA's own recognizer reports as near: only "More forgiving" takes it.
        assert!(!accepts("hey nova", Confidence::Medium, 0.6, 700, Sensitivity::Strict));
        assert!(accepts("hey nova", Confidence::Medium, 0.6, 700, Sensitivity::Normal));
        assert!(!accepts("hey nova", Confidence::Medium, 0.3, 700, Sensitivity::Normal));
        assert!(!accepts("hey nova", Confidence::Low, 0.9, 700, Sensitivity::Normal));
        // A decoy, or something far too short or long to be the phrase.
        assert!(!accepts("hey noah", Confidence::High, 0.95, 700, Sensitivity::Normal));
        assert!(!accepts("hey nova", Confidence::High, 0.95, 120, Sensitivity::Normal));
        assert!(!accepts("hey nova", Confidence::High, 0.95, 4000, Sensitivity::Normal));
    }

    #[test]
    fn overlapping_dictations_keep_listening_paused() {
        // B starts before A has reported its end.
        let count = dictation_count(dictation_count(0, true), true);
        let count = dictation_count(count, false);
        assert_eq!(count, 1, "still dictating");
        assert_eq!(dictation_count(count, false), 0);
        // A stray "ended" never underflows.
        assert_eq!(dictation_count(0, false), 0);
    }

    #[test]
    fn unknown_idle_time_is_not_input_now() {
        let now = Instant::now();
        assert_eq!(last_input(now, u32::MAX), None);
        assert_eq!(last_input(now, 0), Some(now));
        if let Some(t) = last_input(now, 250) {
            assert_eq!(now.duration_since(t), Duration::from_millis(250));
        }
    }

    #[test]
    fn vetoes_claps_around_input_speakers_and_pauses() {
        use std::collections::VecDeque;
        let Some(base) = Instant::now().checked_sub(Duration::from_secs(10)) else { return };
        let ms = |n: u64| base + Duration::from_millis(n);
        let (first, second) = (ms(5000), ms(5300));
        let none = VecDeque::new();
        let quiet: VecDeque<(Instant, f32)> = (4000..6000).step_by(20).map(|t| (ms(t), 0.05)).collect();
        assert_eq!(clap_veto(first, second, None, &none, &quiet), None);
        // A pause that ended long before is fine; one that ended right before or during the claps isn't.
        assert_eq!(clap_veto(first, second, Some(ms(3000)), &none, &quiet), None);
        assert_eq!(clap_veto(first, second, Some(ms(4900)), &none, &quiet), Some(Veto::Paused));
        assert_eq!(clap_veto(first, second, Some(ms(5600)), &none, &quiet), Some(Veto::Paused));
        // Typing close to either clap, but not long before or after.
        assert_eq!(clap_veto(first, second, None, &VecDeque::from([ms(4800)]), &quiet), Some(Veto::Typing));
        assert_eq!(clap_veto(first, second, None, &VecDeque::from([ms(5550)]), &quiet), Some(Veto::Typing));
        assert_eq!(clap_veto(first, second, None, &VecDeque::from([ms(4000), ms(6000)]), &quiet), None);
        // Loud speakers right at a clap.
        let mut loud = quiet.clone();
        loud.push_back((ms(5310), 0.5));
        assert_eq!(clap_veto(first, second, None, &none, &loud), Some(Veto::Speakers));
        let mut earlier = quiet.clone();
        earlier.push_back((ms(4500), 0.5));
        assert_eq!(clap_veto(first, second, None, &none, &earlier), None);
    }

    #[test]
    fn decoys_never_include_the_wake_phrase() {
        assert!(DECOYS.iter().all(|d| !d.eq_ignore_ascii_case(WAKE_PHRASE)));
    }

    #[test]
    fn preferences_start_off_and_fill_in_defaults() {
        let prefs = WakePrefs::default();
        assert!(!prefs.phrase && !prefs.clap && prefs.chime && prefs.in_games);
        let parsed: WakePrefs = serde_json::from_str(r#"{"clap":true,"clapSensitivity":"normal"}"#).unwrap();
        assert!(parsed.clap && !parsed.phrase);
        assert_eq!(parsed.clap_sensitivity, Sensitivity::Normal);
        assert_eq!(parsed.after_wake, AfterWake::Listen);
    }

    #[test]
    fn status_serializes_for_the_settings_page() {
        let json = serde_json::to_value(Listener::Paused { reason: Pause::Dictation }).unwrap();
        assert_eq!(json, serde_json::json!({ "state": "paused", "reason": "dictation" }));
        let json = serde_json::to_value(Heard::NotAClap { level_db: -20.0, reason: clap::NotAClap::TooLong }).unwrap();
        assert_eq!(json, serde_json::json!({ "kind": "notAClap", "levelDb": -20.0, "reason": "tooLong" }));
    }
}
