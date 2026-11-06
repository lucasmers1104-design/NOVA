//! "Hey NOVA" with NOVA's own recognizer, for PCs where Windows' stays silent:
//! Silero VAD finds short phrases on the PC, Parakeet reads each one, and the
//! text is compared with the wake phrase. Nothing is stored or sent. It costs
//! the recognizer's memory while on; Parakeet only runs when someone speaks.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Runtime};

use super::word::Heard;
use super::{mic, Confidence, WAKE_PHRASE};
use crate::speech::stt::dictation::Downsampler;
use crate::speech::stt::vad::{Edge, Segmenter, FRAME};
use crate::speech::stt::{self, Recognizer};
use crate::voice::VoiceError;

/// Silence that ends a phrase.
const PHRASE_END_MS: u32 = 300;
/// Generous: the "Hey" before the name is quiet and often starts before the VAD notices.
const PRE_ROLL: Duration = Duration::from_millis(400);
const SHORTEST_PHRASE: Duration = Duration::from_millis(250);
/// Longer talk isn't a call for NOVA, even if it begins like one; it isn't read at all.
const LONGEST_PHRASE: Duration = Duration::from_secs(6);

/// How Parakeet writes the start of a longer call (letters only, lower case).
const WAKE_SPELLINGS: &[&str] = &["heynova", "heinova", "hainova", "henova", "eynova", "hinova", "heynowa", "heinowa", "hainowa"];

/// Whether a transcribed phrase calls NOVA: it starts like "Hey NOVA", or it is
/// short and ends in the name (the quiet "Hey" often gets lost or misheard).
pub fn calls_nova(text: &str) -> bool {
    let letters: String = text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect();
    WAKE_SPELLINGS.iter().any(|spelling| letters.starts_with(spelling)) || (letters.chars().count() <= 8 && (letters.ends_with("nova") || letters.ends_with("nowa")))
}

/// Listens on the calling thread (COM must be initialized there) until `stop` is set.
pub fn listen(recognizer: &mut Recognizer, stop: &AtomicBool, on_heard: &dyn Fn(Heard)) -> Result<(), String> {
    let Recognizer { asr, vad, .. } = recognizer;
    let mut segmenter = Segmenter::new(PHRASE_END_MS);
    let mut downsampler: Option<Downsampler> = None;
    let mut frames: Vec<f32> = Vec::new();
    let mut pre_roll: VecDeque<f32> = VecDeque::new();
    let mut phrase: Vec<f32> = Vec::new();
    let mut failure = None;
    mic::capture_with(stop, false, |chunk, rate| {
        let longest = (rate as f64 * LONGEST_PHRASE.as_secs_f64()) as usize;
        if segmenter.speaking() {
            // One sample past the limit marks it as too long; no need to keep more.
            if phrase.len() <= longest {
                phrase.extend_from_slice(chunk);
            }
        } else {
            pre_roll.extend(chunk);
            let keep = (rate as f64 * PRE_ROLL.as_secs_f64()) as usize;
            while pre_roll.len() > keep {
                pre_roll.pop_front();
            }
        }
        downsampler.get_or_insert_with(|| Downsampler::new(rate)).push(chunk, &mut frames);
        while frames.len() >= FRAME {
            let frame: Vec<f32> = frames.drain(..FRAME).collect();
            let probability = match vad.probability(&frame) {
                Ok(p) => p,
                Err(error) => {
                    failure = Some(error);
                    return;
                }
            };
            match segmenter.push(probability) {
                Some(Edge::Start) => phrase = pre_roll.drain(..).collect(),
                Some(Edge::End) => {
                    let audio = std::mem::take(&mut phrase);
                    let seconds = audio.len() as f64 / rate.max(1) as f64;
                    if audio.len() > longest || seconds < SHORTEST_PHRASE.as_secs_f64() {
                        continue;
                    }
                    // Also reported without words: the test in Settings shows that something was heard.
                    let text = asr.transcribe(&crate::speech::wav::resample(&audio, rate, 16_000)).unwrap_or_default();
                    let duration_ms = (seconds * 1000.0) as i64;
                    on_heard(if calls_nova(&text) {
                        // Longer calls ("Hey NOVA, wie spät ist es") count, so the duration doesn't decide here.
                        Heard { text: WAKE_PHRASE.to_string(), confidence: Confidence::High, raw: 1.0, duration_ms: 0 }
                    } else {
                        Heard { text, confidence: Confidence::Rejected, raw: 0.0, duration_ms }
                    });
                }
                None => {}
            }
        }
    })
    .map_err(|e| format!("The microphone couldn't be used ({e:?})"))?;
    failure.map_or(Ok(()), Err)
}

/// A running listener with the recognizer it borrowed. Stops when dropped, and
/// hands the recognizer back (dictation takes it right after).
pub struct Spotter {
    stop: Arc<AtomicBool>,
    ended: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl Spotter {
    pub fn start<R: Runtime>(app: &AppHandle<R>, on_heard: impl Fn(Heard) + Send + 'static) -> Result<Self, VoiceError> {
        let mut recognizer = stt::take(app).map_err(|e| VoiceError::from(format!("NOVA's offline recognizer couldn't start: {e}")))?;
        stt::WITH_SPOTTER.store(true, Ordering::SeqCst);
        let (stop, ended) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)));
        let (stop_flag, ended_flag, app) = (stop.clone(), ended.clone(), app.clone());
        let handle = std::thread::spawn(move || {
            let _ = crate::shell::with_com(false, || listen(&mut recognizer, &stop_flag, &on_heard));
            stt::give_back(&app, recognizer);
            stt::WITH_SPOTTER.store(false, Ordering::SeqCst);
            ended_flag.store(true, Ordering::SeqCst);
        });
        Ok(Self { stop, ended, handle: Some(handle) })
    }

    /// It stopped by itself (the microphone went away); start a new one.
    pub fn ended(&self) -> bool {
        self.ended.load(Ordering::SeqCst)
    }
}

impl Drop for Spotter {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_how_the_call_gets_written() {
        for text in ["Hey Nova", "Hey, Nova!", "hey nova.", "Hei Nova", "Hai, Nova", "He Nova", "Hey Nowa", "HEY NOVA, wie spät ist es?", "Nova.", "Eh, Nova", "Genova"] {
            assert!(calls_nova(text), "{text}");
        }
        for text in ["", "Hey", "Hey Nora", "Hey du", "Die Nova ist ein Stern", "Ich hab Hunger", "Supernova"] {
            assert!(!calls_nova(text), "{text}");
        }
    }
}
