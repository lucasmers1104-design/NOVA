//! Voice input for NOVA AI through Windows speech recognition: one spoken
//! turn at a time, which ends after a pause.
//!
//! The microphone is opened only after the user presses the mic button and
//! closes as soon as they stop speaking (or press it again). Spoken replies
//! use the Windows voices through the webview's speech synthesis.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime};

type CommandResult<T> = Result<T, String>;

#[derive(Default)]
pub struct VoiceState {
    active: AtomicBool,
    stop: AtomicBool,
    /// A recognizer made ready while NOVA greets, so listening starts at once.
    #[cfg(windows)]
    prepared: std::sync::Mutex<Option<win::Prepared>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum VoiceEvent {
    /// The microphone is open.
    Listening { language: String },
    /// Input level 0–1, about 20 times a second.
    Level { value: f32 },
    /// What has been understood so far.
    Hypothesis { text: String },
    /// Speech ended; the final text is being worked out.
    Processing,
    Result { text: String },
    /// No words came back. `heard`: Windows did hear sound or speech.
    NoSpeech { heard: bool },
    /// `settings`: the Windows settings page that fixes it, if any.
    Error { message: String, settings: Option<&'static str> },
}

/// Windows settings pages the panel may open to fix a voice problem.
const SETTINGS_PAGES: &[&str] = &["privacy-speech", "privacy-microphone", "speech"];

/// A voice failure: the message and the settings page that fixes it.
pub struct VoiceError {
    pub(crate) message: String,
    pub(crate) settings: Option<&'static str>,
}

impl From<String> for VoiceError {
    fn from(message: String) -> Self {
        Self { message, settings: None }
    }
}

impl From<&str> for VoiceError {
    fn from(message: &str) -> Self {
        Self { message: message.into(), settings: None }
    }
}

/// Readable messages for the common speech failures.
pub(crate) fn describe(code: i32, language: &str) -> VoiceError {
    let (message, settings) = match code as u32 {
        0x8004_5509 => ("Windows speech recognition is turned off. Turn on “Online speech recognition” in Windows Settings → Privacy → Speech, then try again.".to_string(), Some("privacy-speech")),
        0x8007_0005 => ("NOVA can't use the microphone. Allow desktop apps to access it in Windows Settings → Privacy → Microphone.".to_string(), Some("privacy-microphone")),
        0x8004_503A | 0x8004_5090 => (format!("No speech recognizer is installed for {language}. Add the language with speech in Windows Settings → Time & language."), Some("speech")),
        0x8007_0490 | 0x8889_0004 => ("No microphone was found.".to_string(), None),
        _ => (format!("Speech recognition failed (0x{code:08X})."), None),
    };
    VoiceError { message, settings }
}

/// What happened in the last spoken turn, written to `voice-last-turn.txt`
/// in NOVA's local data folder so a failed turn can be explained. It holds
/// timings and counts only, never what was said.
#[derive(Debug, Default)]
pub(crate) struct TurnReport {
    language: String,
    /// The recognizer was made ready ahead of time.
    prepared: bool,
    /// When the recognizer was ready, after the request (ms).
    ready_ms: Option<u128>,
    /// When Windows first heard sound / speech, after it was ready (ms).
    sound_ms: Option<u128>,
    speech_ms: Option<u128>,
    hypotheses: u32,
    phrases: u32,
    unsure: u32,
    /// When the words last changed, and when NOVA decided the turn was over (ms after ready).
    last_change_ms: Option<u128>,
    stop_ms: Option<u128>,
    /// The pause that ended the turn (ms).
    end_pause_ms: Option<u128>,
    /// Offline recognizer: time per phrase, and the wait for the last one after the turn ended.
    decode_ms: Vec<u128>,
    final_wait_ms: Option<u128>,
    /// Windows couldn't listen, so the offline recognizer did.
    fell_back: bool,
    ended: String,
    outcome: String,
}

impl TurnReport {
    /// The same timings for `voice-turns.jsonl`.
    fn record(&self) -> serde_json::Value {
        serde_json::json!({
            "source": "dictation",
            "language": self.language,
            "prepared": self.prepared,
            "readyMs": self.ready_ms,
            "soundMs": self.sound_ms,
            "speechMs": self.speech_ms,
            "hypotheses": self.hypotheses,
            "phrases": self.phrases,
            "unsure": self.unsure,
            "lastChangeMs": self.last_change_ms,
            "stopMs": self.stop_ms,
            "endPauseMs": self.end_pause_ms,
            "decodeMs": self.decode_ms,
            "finalWaitMs": self.final_wait_ms,
            "fellBack": self.fell_back,
            "ended": self.ended,
            "outcome": self.outcome,
        })
    }

    fn render(&self, at: &str) -> String {
        let ms = |v: Option<u128>| v.map_or("never".to_string(), |v| format!("{v} ms"));
        format!(
            "NOVA voice turn ({at})\nlanguage: {}\nprepared ahead: {}\nready after: {}\nsound heard after: {}\nspeech detected after: {}\nlive hypotheses: {}\nphrases: {}\nunsure phrases: {}\nwords last changed after: {}\nturn ended after: {} (pause {})\nsession ended: {}\noutcome: {}\n",
            self.language,
            self.prepared,
            ms(self.ready_ms),
            ms(self.sound_ms),
            ms(self.speech_ms),
            self.hypotheses,
            self.phrases,
            self.unsure,
            ms(self.last_change_ms),
            ms(self.stop_ms),
            ms(self.end_pause_ms),
            self.ended,
            self.outcome
        )
    }
}

/// Words after which people usually go on ("und", "weil", "the"…): the turn
/// waits longer before it ends.
const GOES_ON: &[&str] = &[
    "und", "oder", "aber", "weil", "dass", "denn", "sondern", "also", "wenn", "ob", "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer", "mit", "für",
    "von", "zu", "zum", "zur", "in", "im", "auf", "an", "am", "bei", "nach", "über", "unter", "vor", "ähm", "äh", "hm", "mein", "meine", "meinen", "dein", "deine", "and", "or",
    "but", "because", "the", "a", "an", "to", "of", "with", "for", "in", "on", "my", "your", "um", "uh",
];

/// How long a pause after the last change in the words ends the turn.
pub(crate) fn end_pause(text: &str) -> std::time::Duration {
    let last = text.split_whitespace().last().map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase()).unwrap_or_default();
    std::time::Duration::from_millis(if GOES_ON.contains(&last.as_str()) { 1500 } else { 900 })
}

/// Once Windows has closed the phrase (it waited for silence itself), this
/// little more is enough — unless the last word says the user goes on.
pub(crate) const AFTER_FINAL_PHRASE: std::time::Duration = std::time::Duration::from_millis(300);

/// Letters and digits only, for telling whether the words really changed.
pub(crate) fn words_key(text: &str) -> String {
    text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// The finished phrases of a turn plus the one still being spoken.
fn transcript(phrases: &[String], current: &str) -> String {
    phrases.iter().map(String::as_str).chain(std::iter::once(current)).map(str::trim).filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ")
}

#[cfg(windows)]
mod win {
    use std::time::{Duration, Instant};

    use windows::core::HSTRING;
    use windows::Foundation::{TimeSpan, TypedEventHandler};
    use windows::Globalization::Language;
    use windows::Media::SpeechRecognition::{
        SpeechContinuousRecognitionCompletedEventArgs, SpeechContinuousRecognitionResultGeneratedEventArgs, SpeechContinuousRecognitionSession,
        SpeechRecognitionConfidence, SpeechRecognitionHypothesisGeneratedEventArgs, SpeechRecognitionResultStatus, SpeechRecognizer, SpeechRecognizerState,
        SpeechRecognizerStateChangedEventArgs,
    };
    use windows::Win32::Media::Audio::Endpoints::{IAudioEndpointVolume, IAudioMeterInformation};
    use windows::Win32::Media::Audio::{eCapture, eConsole, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

    use super::{describe, end_pause, transcript, words_key, TurnReport, VoiceError, VoiceEvent, VoiceState, AFTER_FINAL_PHRASE};

    /// A recognizer compiled ahead of time (this doesn't open the microphone).
    pub struct Prepared {
        recognizer: SpeechRecognizer,
        language: String,
        used: String,
        at: Instant,
    }

    /// A prepared recognizer is used only this soon after it was made.
    const PREPARED_FOR: Duration = Duration::from_secs(60);

    /// Makes and compiles a recognizer for `language` ("auto" = Windows' speech language).
    fn create(language: &str) -> Result<(SpeechRecognizer, String), VoiceError> {
        let fail = |e: windows::core::Error| describe(e.code().0, language);
        let recognizer = if language == "auto" {
            SpeechRecognizer::new().map_err(fail)?
        } else {
            let tag = Language::CreateLanguage(&HSTRING::from(language)).map_err(|_| format!("“{language}” isn't a language Windows knows"))?;
            SpeechRecognizer::Create(&tag).map_err(fail)?
        };
        let used = recognizer.CurrentLanguage().and_then(|l| l.LanguageTag()).map(|t| t.to_string()).unwrap_or_else(|_| language.to_string());
        let timeouts = recognizer.Timeouts().map_err(fail)?;
        // Phrases end at short pauses; NOVA decides when the whole turn is over.
        let _ = timeouts.SetInitialSilenceTimeout(span(NOTHING_SAID.as_millis() as i64 + 2000));
        let _ = timeouts.SetEndSilenceTimeout(span(600));
        let compiled = recognizer.CompileConstraintsAsync().map_err(fail)?.join().map_err(fail)?;
        if compiled.Status().map_err(fail)? != SpeechRecognitionResultStatus::Success {
            return Err(format!("Windows couldn't prepare speech recognition for {used}.").into());
        }
        Ok((recognizer, used))
    }

    /// Gets a recognizer ready for the next turn (while NOVA greets).
    pub fn prepare(language: &str, state: &VoiceState) -> Result<(), VoiceError> {
        if state.prepared.lock().map(|p| p.as_ref().is_some_and(|p| p.language == language && p.at.elapsed() < PREPARED_FOR / 2)).unwrap_or(false) {
            return Ok(());
        }
        let (recognizer, used) = create(language)?;
        if let Ok(mut slot) = state.prepared.lock() {
            if let Some(old) = slot.replace(Prepared { recognizer, language: language.to_string(), used, at: Instant::now() }) {
                let _ = old.recognizer.Close();
            }
        }
        Ok(())
    }

    /// The prepared recognizer, if it fits and is fresh.
    fn take_prepared(language: &str, state: &VoiceState) -> Option<(SpeechRecognizer, String)> {
        let prepared = state.prepared.lock().ok()?.take()?;
        if prepared.language == language && prepared.at.elapsed() < PREPARED_FOR {
            Some((prepared.recognizer, prepared.used))
        } else {
            let _ = prepared.recognizer.Close();
            None
        }
    }

    /// Peak level of the default microphone (it only moves while something records).
    fn meter() -> Option<IAudioMeterInformation> {
        // SAFETY: standard COM activation on a thread with COM initialized.
        unsafe {
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            let device = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole).ok()?;
            device.Activate(CLSCTX_ALL, None).ok()
        }
    }

    /// Turns the microphone all the way up for one turn, so quiet voices are
    /// understood too, and back to where it was afterwards.
    struct FullMicrophone {
        volume: IAudioEndpointVolume,
        before: f32,
    }

    impl FullMicrophone {
        fn raise() -> Option<Self> {
            // SAFETY: standard COM activation and plain property calls on a thread with COM initialized.
            unsafe {
                let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
                let device = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole).ok()?;
                let volume: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None).ok()?;
                let before = volume.GetMasterVolumeLevelScalar().ok()?;
                if before >= 0.99 {
                    return None;
                }
                volume.SetMasterVolumeLevelScalar(1.0, std::ptr::null()).ok()?;
                Some(Self { volume, before })
            }
        }
    }

    impl Drop for FullMicrophone {
        fn drop(&mut self) {
            // SAFETY: plain property call on a live endpoint interface.
            let _ = unsafe { self.volume.SetMasterVolumeLevelScalar(self.before, std::ptr::null()) };
        }
    }

    fn span(ms: i64) -> TimeSpan {
        TimeSpan { Duration: ms * 10_000 }
    }

    /// What the recognizer reports from its own threads.
    enum Heard {
        /// The phrase being spoken right now, as understood so far.
        Hypothesis(String),
        /// A finished phrase (the user paused briefly).
        Phrase(String),
        /// A phrase Windows wasn't sure about (kept in case nothing else comes).
        Unsure(String),
        /// Windows hears sound above the background noise.
        Sound,
        /// Windows hears speech.
        Speech,
        /// The session ended; Success unless something went wrong.
        Ended(SpeechRecognitionResultStatus),
    }

    /// Nobody said anything for this long: give up.
    const NOTHING_SAID: Duration = Duration::from_secs(8);
    /// Windows hears speech but no words have come back yet (online dictation
    /// can lag): wait this long before giving up.
    const NO_WORDS_YET: Duration = Duration::from_secs(14);
    const LONGEST_TURN: Duration = Duration::from_secs(90);

    fn ended_with(status: SpeechRecognitionResultStatus, used: &str) -> Option<VoiceError> {
        match status {
            SpeechRecognitionResultStatus::Success
            | SpeechRecognitionResultStatus::TimeoutExceeded
            | SpeechRecognitionResultStatus::UserCanceled
            | SpeechRecognitionResultStatus::PauseLimitExceeded => None,
            SpeechRecognitionResultStatus::NetworkFailure => Some("Windows couldn't reach its online speech service. Check your connection.".into()),
            SpeechRecognitionResultStatus::MicrophoneUnavailable => Some("No microphone is available.".into()),
            SpeechRecognitionResultStatus::AudioQualityFailure => Some("The audio was too quiet or noisy to understand. Try again closer to the microphone.".into()),
            SpeechRecognitionResultStatus::TopicLanguageNotSupported => Some(format!("Dictation isn't available for {used}.").into()),
            other => Some(format!("Windows speech recognition stopped unexpectedly (status {}). Try again.", other.0).into()),
        }
    }

    /// One spoken turn: listens continuously, waits out short pauses, and ends
    /// once the words have stopped changing for a moment (see `end_pause`),
    /// or when the user presses stop.
    pub fn listen(language: &str, state: &VoiceState, send: &dyn Fn(VoiceEvent), report: &mut TurnReport) -> Result<(), VoiceError> {
        let requested = Instant::now();
        let fail = |e: windows::core::Error| describe(e.code().0, language);
        let (recognizer, used) = match take_prepared(language, state) {
            Some(ready) => {
                report.prepared = true;
                ready
            }
            None => create(language)?,
        };
        report.language = used.clone();

        let (tx, heard) = std::sync::mpsc::channel::<Heard>();
        let hypothesis_tx = tx.clone();
        let hypothesis_token = recognizer
            .HypothesisGenerated(&TypedEventHandler::<SpeechRecognizer, SpeechRecognitionHypothesisGeneratedEventArgs>::new(move |_, args| {
                if let Some(text) = args.as_ref().and_then(|a| a.Hypothesis().and_then(|h| h.Text()).ok()) {
                    let _ = hypothesis_tx.send(Heard::Hypothesis(text.to_string()));
                }
                Ok(())
            }))
            .map_err(fail)?;
        let state_tx = tx.clone();
        let state_token = recognizer
            .StateChanged(&TypedEventHandler::<SpeechRecognizer, SpeechRecognizerStateChangedEventArgs>::new(move |_, args| {
                match args.as_ref().and_then(|a| a.State().ok()) {
                    Some(SpeechRecognizerState::SoundStarted) => {
                        let _ = state_tx.send(Heard::Sound);
                    }
                    Some(SpeechRecognizerState::SpeechDetected) => {
                        let _ = state_tx.send(Heard::Speech);
                    }
                    _ => {}
                }
                Ok(())
            }))
            .map_err(fail)?;
        let session = recognizer.ContinuousRecognitionSession().map_err(fail)?;
        let _ = session.SetAutoStopSilenceTimeout(span(LONGEST_TURN.as_millis() as i64));
        let phrase_tx = tx.clone();
        let result_token = session
            .ResultGenerated(&TypedEventHandler::<SpeechContinuousRecognitionSession, SpeechContinuousRecognitionResultGeneratedEventArgs>::new(move |_, args| {
                if let Some(result) = args.as_ref().and_then(|a| a.Result().ok()) {
                    let rejected = result.Confidence().is_ok_and(|c| c == SpeechRecognitionConfidence::Rejected);
                    if result.Status()? == SpeechRecognitionResultStatus::Success {
                        let text = result.Text()?.to_string();
                        let _ = phrase_tx.send(if rejected { Heard::Unsure(text) } else { Heard::Phrase(text) });
                    }
                }
                Ok(())
            }))
            .map_err(fail)?;
        let completed_token = session
            .Completed(&TypedEventHandler::<SpeechContinuousRecognitionSession, SpeechContinuousRecognitionCompletedEventArgs>::new(move |_, args| {
                let status = args.as_ref().and_then(|a| a.Status().ok()).unwrap_or(SpeechRecognitionResultStatus::Unknown);
                let _ = tx.send(Heard::Ended(status));
                Ok(())
            }))
            .map_err(fail)?;
        let cleanup = || {
            let _ = recognizer.RemoveHypothesisGenerated(hypothesis_token);
            let _ = recognizer.RemoveStateChanged(state_token);
            let _ = session.RemoveResultGenerated(result_token);
            let _ = session.RemoveCompleted(completed_token);
            let _ = recognizer.Close();
        };
        let _full = FullMicrophone::raise();
        if let Err(error) = session.StartAsync().and_then(|start| start.join()) {
            cleanup();
            return Err(fail(error));
        }
        send(VoiceEvent::Listening { language: used.clone() });

        let meter = meter();
        let started = Instant::now();
        report.ready_ms = Some(started.duration_since(requested).as_millis());
        let mut phrases: Vec<String> = Vec::new();
        let mut unsure: Vec<String> = Vec::new();
        let mut heard_speech = false;
        let mut current = String::new();
        // When the words last really changed, and when Windows last closed a phrase.
        let mut last_words: Option<Instant> = None;
        let mut words = String::new();
        let mut settled: Option<Instant> = None;
        let mut stopping: Option<Instant> = None;
        let mut ended = None;
        let changed = |text: String, words: &mut String, last_words: &mut Option<Instant>| {
            let key = words_key(&text);
            if key != *words || last_words.is_none() {
                *words = key;
                *last_words = Some(Instant::now());
            }
        };
        loop {
            while let Ok(event) = heard.try_recv() {
                match event {
                    Heard::Hypothesis(text) => {
                        report.hypotheses += 1;
                        current = text;
                        settled = None;
                        changed(transcript(&phrases, &current), &mut words, &mut last_words);
                    }
                    Heard::Phrase(text) => {
                        report.phrases += 1;
                        if !text.trim().is_empty() {
                            phrases.push(text.trim().to_string());
                        }
                        current.clear();
                        settled = Some(Instant::now());
                        changed(transcript(&phrases, ""), &mut words, &mut last_words);
                    }
                    Heard::Unsure(text) => {
                        report.unsure += 1;
                        if !text.trim().is_empty() {
                            unsure.push(text.trim().to_string());
                        }
                        current.clear();
                        settled = Some(Instant::now());
                        if last_words.is_none() {
                            last_words = Some(Instant::now());
                        }
                    }
                    Heard::Sound => {
                        report.sound_ms.get_or_insert(started.elapsed().as_millis());
                        continue;
                    }
                    Heard::Speech => {
                        report.speech_ms.get_or_insert(started.elapsed().as_millis());
                        heard_speech = true;
                        continue;
                    }
                    Heard::Ended(status) => ended = Some(status),
                }
                send(VoiceEvent::Hypothesis { text: transcript(&phrases, &current) });
            }
            if ended.is_some() {
                break;
            }
            if let Some(meter) = &meter {
                // SAFETY: plain COM call returning a float.
                let level = unsafe { meter.GetPeakValue() }.unwrap_or(0.0);
                send(VoiceEvent::Level { value: level.clamp(0.0, 1.0) });
            }
            let text = transcript(&phrases, &current);
            let pause = end_pause(&text);
            let goes_on = pause > Duration::from_millis(1000);
            let quiet = last_words.is_some_and(|t| t.elapsed() >= pause)
                // Windows closed the phrase after its own silence: a little more is enough.
                || (!goes_on && current.is_empty() && settled.is_some_and(|t| t.elapsed() >= AFTER_FINAL_PHRASE) && text.split_whitespace().count() >= 2);
            let wants_stop = state.stop.load(super::Ordering::SeqCst)
                || quiet
                || (last_words.is_none() && started.elapsed() >= if heard_speech { NO_WORDS_YET } else { NOTHING_SAID })
                || started.elapsed() >= LONGEST_TURN;
            match stopping {
                None if wants_stop => {
                    report.stop_ms = Some(started.elapsed().as_millis());
                    report.last_change_ms = last_words.map(|t| t.duration_since(started).as_millis());
                    report.end_pause_ms = Some(pause.as_millis());
                    // All words are in finished phrases: nothing left to wait for.
                    if current.is_empty() && !phrases.is_empty() {
                        send(VoiceEvent::Processing);
                        let _ = session.CancelAsync();
                        break;
                    }
                    // Finish politely: Windows delivers the phrase in progress, then ends.
                    send(VoiceEvent::Processing);
                    let _ = session.StopAsync();
                    stopping = Some(Instant::now());
                }
                // With words in hand, the final version isn't worth a long wait.
                Some(since) if since.elapsed() > if text.is_empty() { Duration::from_secs(3) } else { Duration::from_millis(700) } => {
                    let _ = session.CancelAsync();
                    break;
                }
                _ => {}
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        cleanup();
        if stopping.is_none() && report.stop_ms.is_none() {
            send(VoiceEvent::Processing);
        }
        report.ended = ended.map_or_else(|| "stopped by NOVA".to_string(), |status| format!("status {}", status.0));
        // Words still in progress when the turn ended count too; phrases
        // Windows wasn't sure about only when nothing else was understood.
        let mut text = transcript(&phrases, &current);
        if text.is_empty() {
            text = transcript(&unsure, "");
        }
        if let Some(error) = ended.and_then(|status| ended_with(status, &used)).filter(|_| text.is_empty()) {
            report.outcome = format!("error: {}", error.message);
            return Err(error);
        }
        if text.is_empty() {
            let heard = report.sound_ms.is_some() || heard_speech;
            report.outcome = format!("no words (sound heard: {heard})");
            send(VoiceEvent::NoSpeech { heard });
        } else {
            report.outcome = format!("{} words", text.split_whitespace().count());
            send(VoiceEvent::Result { text });
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn voice_listen<R: Runtime>(app: AppHandle<R>, on_event: Channel<VoiceEvent>) -> CommandResult<()> {
    let state = app.state::<VoiceState>();
    if state.active.swap(true, Ordering::SeqCst) {
        return Err("NOVA is already listening".into());
    }
    state.stop.store(false, Ordering::SeqCst);
    let language = crate::agent::prefs(&app).language;
    let app2 = app.clone();
    let channel = on_event.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        // "Hey NOVA" listens with its own recognizer; it waits until dictation is done.
        crate::wake::pause_for_dictation(&app2, true);
        let state = app2.state::<VoiceState>();
        let send = |event: VoiceEvent| {
            let _ = channel.send(event);
        };
        let mut report = TurnReport::default();
        #[cfg(windows)]
        let result = {
            let mut failure = None;
            let _ = crate::shell::with_com(false, || {
                failure = if crate::speech::stt::use_local(&app2) {
                    listen_offline(&app2, &state, &send, &mut report).err()
                } else {
                    match win::listen(&language, &state, &send, &mut report) {
                        // Windows can't listen (online recognition off, offline, no recognizer): NOVA's own recognizer can.
                        Err(error) if offline_helps(&error) && crate::speech::stt::ready(&app2) => {
                            report = TurnReport { fell_back: true, ..TurnReport::default() };
                            listen_offline(&app2, &state, &send, &mut report).err()
                        }
                        other => other.err(),
                    }
                };
                Ok(())
            });
            failure.map_or(Ok(()), Err)
        };
        #[cfg(not(windows))]
        let result: Result<(), VoiceError> = Err("Voice input requires Windows".into());
        let _ = (&state, &send, &language);
        if let Some(error) = result.as_ref().err().filter(|_| report.outcome.is_empty()) {
            report.outcome = format!("error: {}", error.message);
        }
        write_report(&app2, &report);
        result
    })
    .await
    .map_err(|e| e.to_string());
    state.active.store(false, Ordering::SeqCst);
    crate::wake::pause_for_dictation(&app, false);
    let outcome = outcome?;
    if let Err(error) = outcome {
        let _ = on_event.send(VoiceEvent::Error { message: error.message, settings: error.settings });
    }
    Ok(())
}

/// Gets speech recognition ready for the next turn, without opening the
/// microphone (called when NOVA wakes, while it greets).
pub fn prepare<R: Runtime>(app: &AppHandle<R>) {
    if app.state::<VoiceState>().active.load(Ordering::SeqCst) {
        return;
    }
    let language = crate::agent::prefs(app).language;
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            let state = app.state::<VoiceState>();
            let _ = crate::shell::with_com(false, || win::prepare(&language, &state).map_err(|e| e.message));
        }
        #[cfg(not(windows))]
        let _ = (&app, &language);
    });
}

#[tauri::command]
pub async fn voice_prepare<R: Runtime>(app: AppHandle<R>) -> CommandResult<()> {
    prepare(&app);
    Ok(())
}

/// Failures NOVA's offline recognizer gets around.
fn offline_helps(error: &VoiceError) -> bool {
    error.settings == Some("privacy-speech") || error.settings == Some("speech") || error.message.contains("online speech service")
}

/// One spoken turn with NOVA's offline recognizer (Silero VAD + Parakeet).
#[cfg(windows)]
fn listen_offline<R: Runtime>(app: &AppHandle<R>, state: &VoiceState, send: &dyn Fn(VoiceEvent), report: &mut TurnReport) -> Result<(), VoiceError> {
    use crate::speech::stt::{self, dictation};
    let requested = std::time::Instant::now();
    let mut recognizer = stt::take(app).map_err(|e| VoiceError::from(format!("NOVA's offline recognizer couldn't start: {e}")))?;
    report.language = format!("offline · {}", recognizer.device.label());
    report.prepared = true;
    let mut ready = None;
    let outcome = dictation::listen(
        &mut recognizer,
        &state.stop,
        &mut |event| match event {
            dictation::Event::Listening => {
                ready = Some(requested.elapsed().as_millis());
                send(VoiceEvent::Listening { language: "offline".into() });
            }
            dictation::Event::Level(value) => send(VoiceEvent::Level { value }),
            dictation::Event::Hypothesis(text) => send(VoiceEvent::Hypothesis { text }),
            dictation::Event::Processing => send(VoiceEvent::Processing),
        },
        &end_pause,
    );
    stt::give_back(app, recognizer);
    let turn = outcome.map_err(VoiceError::from)?;
    report.ready_ms = ready;
    report.speech_ms = turn.speech_ms;
    report.phrases = turn.phrases;
    report.stop_ms = turn.stop_ms;
    report.last_change_ms = turn.last_change_ms;
    report.end_pause_ms = Some(turn.end_pause_ms);
    report.decode_ms = turn.decode_ms.clone();
    report.final_wait_ms = Some(turn.final_wait_ms);
    report.ended = "offline turn".into();
    if turn.text.is_empty() {
        report.outcome = format!("no words (speech heard: {})", turn.heard_speech);
        send(VoiceEvent::NoSpeech { heard: turn.heard_speech });
    } else {
        report.outcome = format!("{} words", turn.text.split_whitespace().count());
        send(VoiceEvent::Result { text: turn.text });
    }
    Ok(())
}

fn write_report<R: Runtime>(app: &AppHandle<R>, report: &TurnReport) {
    crate::turnlog::append(app, report.record());
    let Ok(dir) = app.path().app_local_data_dir() else { return };
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join("voice-last-turn.txt"), report.render(&format!("unix time {at}")));
}

/// Opens a Windows settings page that fixes a voice problem (fixed list, no input passes through).
#[tauri::command]
pub async fn voice_open_settings(page: String) -> CommandResult<()> {
    let page = SETTINGS_PAGES.iter().find(|p| **p == page).ok_or("Unknown settings page")?;
    #[cfg(windows)]
    {
        use windows::core::{w, HSTRING, PCWSTR};
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let uri = HSTRING::from(format!("ms-settings:{page}"));
        crate::shell::with_com(true, || {
            // SAFETY: valid NUL-terminated wide strings for the duration of the call.
            let result = unsafe { ShellExecuteW(None, w!("open"), &uri, PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
            if result.0 as isize > 32 { Ok(()) } else { Err("Windows couldn't open Settings".into()) }
        })
    }
    #[cfg(not(windows))]
    {
        let _ = page;
        Err("Windows settings aren't available here".into())
    }
}

/// Ends listening early, keeping what was said.
#[tauri::command]
pub async fn voice_stop<R: Runtime>(app: AppHandle<R>) -> CommandResult<()> {
    app.state::<VoiceState>().stop.store(true, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_phrases_of_a_turn() {
        let phrases = vec!["Öffne bitte".to_string(), " meine Downloads ".to_string()];
        assert_eq!(transcript(&phrases, "und die neueste"), "Öffne bitte meine Downloads und die neueste");
        assert_eq!(transcript(&phrases, "  "), "Öffne bitte meine Downloads");
        assert_eq!(transcript(&[], ""), "");
    }

    #[test]
    fn waits_longer_when_the_last_word_says_more_is_coming() {
        assert_eq!(end_pause("Öffne bitte meine Downloads").as_millis(), 900);
        assert_eq!(end_pause("Such mir die Rechnung und").as_millis(), 1500);
        assert_eq!(end_pause("Wie spät ist es in ähm…").as_millis(), 1500);
        assert_eq!(end_pause("").as_millis(), 900);
        assert_eq!(words_key("Öffne bitte, meine Downloads."), words_key("öffne bitte meine downloads"));
        assert_ne!(words_key("öffne bitte"), words_key("öffne bitte meine"));
    }

    #[test]
    fn turn_report_holds_no_words() {
        let report = TurnReport { language: "de-DE".into(), ready_ms: Some(420), speech_ms: Some(900), hypotheses: 0, outcome: "no words (sound heard: true)".into(), ..TurnReport::default() };
        let text = report.render("now");
        assert!(text.contains("ready after: 420 ms") && text.contains("sound heard after: never") && text.contains("speech detected after: 900 ms"));
    }

    #[test]
    fn explains_common_failures() {
        let privacy = describe(0x8004_5509u32 as i32, "de-DE");
        assert!(privacy.message.contains("Online speech recognition"));
        assert_eq!(privacy.settings, Some("privacy-speech"));
        assert_eq!(describe(0x8007_0005u32 as i32, "de-DE").settings, Some("privacy-microphone"));
        assert!(describe(0x8004_503Au32 as i32, "de-DE").message.contains("de-DE"));
        let unknown = describe(0x1234, "en-US");
        assert!(unknown.message.contains("0x00001234") && unknown.settings.is_none());
    }

    #[test]
    fn events_serialize_for_the_panel() {
        let json = serde_json::to_value(VoiceEvent::Hypothesis { text: "hallo".into() }).unwrap();
        assert_eq!(json, serde_json::json!({ "type": "hypothesis", "text": "hallo" }));
        assert_eq!(serde_json::to_value(VoiceEvent::NoSpeech { heard: true }).unwrap(), serde_json::json!({ "type": "noSpeech", "heard": true }));
    }
}
