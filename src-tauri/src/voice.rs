//! Voice input for NOVA AI through Windows speech recognition (push-to-talk).
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
    NoSpeech,
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

#[cfg(windows)]
mod win {
    use std::time::{Duration, Instant};

    use windows::core::HSTRING;
    use windows::Foundation::{TimeSpan, TypedEventHandler};
    use windows::Globalization::Language;
    use windows::Media::SpeechRecognition::{
        SpeechRecognitionHypothesisGeneratedEventArgs, SpeechRecognitionResultStatus, SpeechRecognizer,
    };
    use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
    use windows::Win32::Media::Audio::{eCapture, eConsole, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
    use windows_future::AsyncStatus;

    use super::{describe, VoiceError, VoiceEvent, VoiceState};

    /// Peak level of the default microphone (it only moves while something records).
    fn meter() -> Option<IAudioMeterInformation> {
        // SAFETY: standard COM activation on a thread with COM initialized.
        unsafe {
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            let device = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole).ok()?;
            device.Activate(CLSCTX_ALL, None).ok()
        }
    }

    fn span(ms: i64) -> TimeSpan {
        TimeSpan { Duration: ms * 10_000 }
    }

    pub fn listen(language: &str, state: &VoiceState, send: &dyn Fn(VoiceEvent)) -> Result<(), VoiceError> {
        let fail = |e: windows::core::Error| describe(e.code().0, language);
        let recognizer = if language == "auto" {
            SpeechRecognizer::new().map_err(fail)?
        } else {
            let tag = Language::CreateLanguage(&HSTRING::from(language)).map_err(|_| format!("“{language}” isn't a language Windows knows"))?;
            SpeechRecognizer::Create(&tag).map_err(fail)?
        };
        let used = recognizer.CurrentLanguage().and_then(|l| l.LanguageTag()).map(|t| t.to_string()).unwrap_or_else(|_| language.to_string());
        let timeouts = recognizer.Timeouts().map_err(fail)?;
        // Give the user time to start; end shortly after they stop talking.
        let _ = timeouts.SetInitialSilenceTimeout(span(7000));
        let _ = timeouts.SetEndSilenceTimeout(span(900));
        let compiled = recognizer.CompileConstraintsAsync().map_err(fail)?.join().map_err(fail)?;
        if compiled.Status().map_err(fail)? != SpeechRecognitionResultStatus::Success {
            return Err(format!("Windows couldn't prepare speech recognition for {used}.").into());
        }

        // Live transcript while the user speaks.
        let (hypotheses, receiver) = std::sync::mpsc::channel::<String>();
        let token = recognizer
            .HypothesisGenerated(&TypedEventHandler::<SpeechRecognizer, SpeechRecognitionHypothesisGeneratedEventArgs>::new(move |_, args| {
                if let Some(args) = args.as_ref() {
                    if let Ok(text) = args.Hypothesis().and_then(|h| h.Text()) {
                        let _ = hypotheses.send(text.to_string());
                    }
                }
                Ok(())
            }))
            .map_err(fail)?;

        let operation = recognizer.RecognizeAsync().map_err(fail)?;
        send(VoiceEvent::Listening { language: used.clone() });
        let meter = meter();
        let mut stopping = false;
        let started = Instant::now();
        loop {
            match operation.Status().map_err(fail)? {
                AsyncStatus::Started => {}
                AsyncStatus::Completed => break,
                AsyncStatus::Canceled => {
                    let _ = recognizer.RemoveHypothesisGenerated(token);
                    send(VoiceEvent::NoSpeech);
                    return Ok(());
                }
                _ => {
                    let code = operation.ErrorCode().map(|c| c.0).unwrap_or(0);
                    let _ = recognizer.RemoveHypothesisGenerated(token);
                    return Err(describe(code, &used));
                }
            }
            while let Ok(text) = receiver.try_recv() {
                send(VoiceEvent::Hypothesis { text });
            }
            if state.stop.load(super::Ordering::SeqCst) && !stopping {
                // "I'm done": finish with what was said so far.
                stopping = true;
                send(VoiceEvent::Processing);
                let _ = recognizer.StopRecognitionAsync();
            }
            if started.elapsed() > Duration::from_secs(60) {
                let _ = operation.Cancel();
            }
            if let Some(meter) = &meter {
                // SAFETY: plain COM call returning a float.
                let level = unsafe { meter.GetPeakValue() }.unwrap_or(0.0);
                send(VoiceEvent::Level { value: level.clamp(0.0, 1.0) });
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = recognizer.RemoveHypothesisGenerated(token);
        if !stopping {
            send(VoiceEvent::Processing);
        }
        let result = operation.GetResults().map_err(fail)?;
        let status = result.Status().map_err(fail)?;
        let text = result.Text().map(|t| t.to_string()).unwrap_or_default();
        match status {
            SpeechRecognitionResultStatus::Success if !text.trim().is_empty() => send(VoiceEvent::Result { text: text.trim().to_string() }),
            SpeechRecognitionResultStatus::Success | SpeechRecognitionResultStatus::TimeoutExceeded | SpeechRecognitionResultStatus::UserCanceled => {
                send(VoiceEvent::NoSpeech)
            }
            SpeechRecognitionResultStatus::NetworkFailure => {
                return Err("Windows couldn't reach its online speech service. Check your connection.".into());
            }
            SpeechRecognitionResultStatus::MicrophoneUnavailable => return Err("No microphone is available.".into()),
            SpeechRecognitionResultStatus::AudioQualityFailure => return Err("The audio was too quiet or noisy to understand. Try again closer to the microphone.".into()),
            SpeechRecognitionResultStatus::TopicLanguageNotSupported => return Err(format!("Dictation isn't available for {used}.").into()),
            other => return Err(format!("Speech recognition stopped ({}).", other.0).into()),
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
        #[cfg(windows)]
        let result = {
            let mut failure = None;
            let _ = crate::shell::with_com(false, || {
                failure = win::listen(&language, &state, &send).err();
                Ok(())
            });
            failure.map_or(Ok(()), Err)
        };
        #[cfg(not(windows))]
        let result: Result<(), VoiceError> = Err("Voice input requires Windows".into());
        let _ = (&state, &send, &language);
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
        assert_eq!(serde_json::to_value(VoiceEvent::NoSpeech).unwrap(), serde_json::json!({ "type": "noSpeech" }));
    }
}
