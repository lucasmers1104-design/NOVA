//! "Hey NOVA": phrase spotting with Windows speech recognition. A fixed list
//! of phrases is recognized on the PC; nothing goes to an online service, so
//! it works with "Online speech recognition" turned off.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use windows::core::{Interface, HSTRING};
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Globalization::Language;
use windows::Media::SpeechRecognition::{
    ISpeechRecognitionConstraint, SpeechContinuousRecognitionCompletedEventArgs, SpeechContinuousRecognitionResultGeneratedEventArgs,
    SpeechContinuousRecognitionSession, SpeechRecognitionConfidence, SpeechRecognitionListConstraint, SpeechRecognitionResultStatus, SpeechRecognizer,
};
use windows_collections::IIterable;

use super::Confidence;
use crate::voice::{describe, VoiceError};

#[derive(Debug, Clone)]
pub struct Heard {
    /// The phrase from the list that matched best.
    pub text: String,
    pub confidence: Confidence,
    /// 0–1.
    pub raw: f64,
    pub duration_ms: i64,
}

/// A running recognition session. Stops when dropped.
pub struct PhraseListener {
    recognizer: SpeechRecognizer,
    session: SpeechContinuousRecognitionSession,
    tokens: (i64, i64),
    ended: Arc<AtomicBool>,
}

impl PhraseListener {
    /// Starts listening for `phrases` in `language` ("auto" = the Windows
    /// speech language). `on_heard` runs on a Windows thread-pool thread.
    pub fn start(language: &str, phrases: &[&str], on_heard: impl Fn(Heard) + Send + Sync + 'static) -> Result<Self, VoiceError> {
        let fail = |e: windows::core::Error| describe(e.code().0, language);
        let recognizer = if language == "auto" {
            SpeechRecognizer::new().map_err(fail)?
        } else {
            let tag = Language::CreateLanguage(&HSTRING::from(language)).map_err(|_| VoiceError::from(format!("“{language}” isn't a language Windows knows")))?;
            SpeechRecognizer::Create(&tag).map_err(fail)?
        };
        let list: IIterable<HSTRING> = phrases.iter().map(|p| HSTRING::from(*p)).collect::<Vec<_>>().into();
        let constraint = SpeechRecognitionListConstraint::Create(&list).map_err(fail)?;
        recognizer.Constraints().map_err(fail)?.Append(&constraint.cast::<ISpeechRecognitionConstraint>().map_err(fail)?).map_err(fail)?;
        let compiled = recognizer.CompileConstraintsAsync().map_err(fail)?.join().map_err(fail)?;
        if compiled.Status().map_err(fail)? != SpeechRecognitionResultStatus::Success {
            return Err("Windows couldn't prepare the wake phrase for speech recognition.".into());
        }

        let session = recognizer.ContinuousRecognitionSession().map_err(fail)?;
        // The session would otherwise end after a short silence (a quiet room
        // is the normal case here) and be rebuilt from scratch; keep it going.
        let _ = session.SetAutoStopSilenceTimeout(TimeSpan { Duration: 24 * 3600 * 10_000_000 });
        let result_token = session
            .ResultGenerated(&TypedEventHandler::<SpeechContinuousRecognitionSession, SpeechContinuousRecognitionResultGeneratedEventArgs>::new(move |_, args| {
                let Some(args) = args.as_ref() else { return Ok(()) };
                let result = args.Result()?;
                if result.Status()? != SpeechRecognitionResultStatus::Success {
                    return Ok(());
                }
                let confidence = match result.Confidence()? {
                    SpeechRecognitionConfidence::High => Confidence::High,
                    SpeechRecognitionConfidence::Medium => Confidence::Medium,
                    SpeechRecognitionConfidence::Low => Confidence::Low,
                    _ => Confidence::Rejected,
                };
                on_heard(Heard {
                    text: result.Text()?.to_string(),
                    confidence,
                    raw: result.RawConfidence().unwrap_or(0.0),
                    duration_ms: result.PhraseDuration().map(|d| d.Duration / 10_000).unwrap_or(0),
                });
                Ok(())
            }))
            .map_err(fail)?;
        let ended = Arc::new(AtomicBool::new(false));
        let flag = ended.clone();
        let completed_token = session
            .Completed(&TypedEventHandler::<SpeechContinuousRecognitionSession, SpeechContinuousRecognitionCompletedEventArgs>::new(move |_, _| {
                flag.store(true, Ordering::SeqCst);
                Ok(())
            }))
            .map_err(fail)?;
        let listener = Self { recognizer, session, tokens: (result_token, completed_token), ended };
        listener.session.StartAsync().map_err(fail)?.join().map_err(fail)?;
        Ok(listener)
    }

    /// The session stopped by itself (silence timeout, audio problem); start a new one.
    pub fn ended(&self) -> bool {
        self.ended.load(Ordering::SeqCst)
    }
}

impl Drop for PhraseListener {
    fn drop(&mut self) {
        if !self.ended() {
            if let Ok(stopping) = self.session.StopAsync() {
                let _ = stopping.join();
            }
        }
        let _ = self.session.RemoveResultGenerated(self.tokens.0);
        let _ = self.session.RemoveCompleted(self.tokens.1);
        let _ = self.recognizer.Close();
    }
}
