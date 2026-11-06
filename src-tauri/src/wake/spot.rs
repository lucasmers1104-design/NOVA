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
const LONGEST_PHRASE: Duration = Duration::from_secs(8);

/// How Parakeet writes the "Hey" when it hears it clearly, or loses it.
const CLEAR_STARTS: &[&str] = &["", "hey", "hei", "hai", "hay", "he", "ey", "eh", "hi", "e", "a", "i", "hallo", "hello", "okay", "ok"];
/// What the quiet "Hey" also becomes ("Herr Inova", "Keinova", "Ain Ova"). More
/// wake-ups by mistake are possible, so these count only on "More forgiving".
const LOOSE_STARTS: &[&str] = &["herr", "her", "ai", "ei", "ein", "kei", "kein", "ge", "ha", "high", "hy", "hee", "yeah"];

/// How sure a phrase is a call for NOVA.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Call {
    Sure,
    Near,
    No,
}

/// The sounds of "Nova", as Parakeet spells them: "Nova", "Nowa", "Nofa",
/// "Nuba", "Nuova". The letter after the "o" decides: "Noah", "Nora" and
/// "Nover" (Hannover) are other words.
fn sounds_like_name(letters: &str) -> bool {
    let rest = letters.strip_prefix('n').unwrap_or("");
    let rest = rest.strip_prefix("uo").or_else(|| rest.strip_prefix('o')).or_else(|| rest.strip_prefix('u')).unwrap_or("");
    let rest = rest.strip_prefix('r').unwrap_or(rest);
    matches!(rest, "va" | "wa" | "fa" | "ba" | "vah" | "vo" | "wo")
}

/// Whether `letters` is a start from `starts` and then the name, also with the
/// "in" that the end of "Hey" turns into ("Hey Innova"). `"inova"` is one word
/// when the "Hey" is lost altogether.
fn is_call(letters: &str, starts: &[&str]) -> bool {
    starts.iter().filter_map(|start| letters.strip_prefix(start)).any(|rest| {
        let rest = ["inn", "in", "nn"].iter().find_map(|sound| rest.strip_prefix(sound)).map_or_else(|| rest.to_string(), |tail| format!("n{tail}"));
        sounds_like_name(&rest)
    })
}

/// Whether a transcribed phrase calls NOVA, and what was said after the call.
/// Only the first words can be the call, ending at a word's end: "Casanova",
/// "Supernova" and "Die Nova ist ein Stern" aren't calls.
pub fn read_call(text: &str) -> (Call, Option<String>) {
    let words: Vec<&str> = text.split_whitespace().collect();
    let mut joined = String::new();
    let mut best = (Call::No, 0);
    for (count, word) in words.iter().take(3).enumerate() {
        joined.extend(word.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase));
        // The bare name running on is talk about NOVA ("Nova kann das"), not to it ("Nova, wie spät ist es?").
        if count == 0 && words.len() > 1 && sounds_like_name(&joined) && word.ends_with(|c: char| c.is_alphanumeric()) {
            break;
        }
        if is_call(&joined, CLEAR_STARTS) {
            best = (Call::Sure, count + 1);
            break;
        }
        if best.0 == Call::No && is_call(&joined, LOOSE_STARTS) {
            best = (Call::Near, count + 1);
        }
    }
    let request = words[best.1..].join(" ");
    let request = request.trim_start_matches([',', '.', '!', '?', ';', ':', ' ']).trim();
    (best.0, (best.0 != Call::No && request.chars().filter(|c| c.is_alphanumeric()).count() >= 3).then(|| request.to_string()))
}

/// A phrase as Parakeet reads it best: at a steady level whatever the microphone
/// gives, with a moment of silence around it so the first and last sound count.
fn prepared(audio: &[f32]) -> Vec<f32> {
    let peak = audio.iter().fold(0f32, |most, sample| most.max(sample.abs())).max(0.001);
    // Limited: amplifying near-silence only makes noise.
    let gain = (0.5 / peak).min(12.0);
    let pad = std::iter::repeat_n(0.0, 16_000 / 5);
    pad.clone().chain(audio.iter().map(|sample| sample * gain)).chain(pad).collect()
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
                    let text = asr.transcribe(&prepared(&crate::speech::wav::resample(&audio, rate, 16_000))).unwrap_or_default();
                    let duration_ms = (seconds * 1000.0) as i64;
                    // Longer calls ("Hey NOVA, wie spät ist es") count, so the duration doesn't decide here.
                    on_heard(match read_call(&text) {
                        (Call::Sure, request) => Heard { text: WAKE_PHRASE.to_string(), confidence: Confidence::High, raw: 1.0, duration_ms: 0, request },
                        // Passes only on "More forgiving": see `accepts`.
                        (Call::Near, request) => Heard { text: WAKE_PHRASE.to_string(), confidence: Confidence::Medium, raw: 0.6, duration_ms: 0, request },
                        (Call::No, _) => Heard { text, confidence: Confidence::Rejected, raw: 0.0, duration_ms, request: None },
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

    fn read_wav(path: &std::path::Path) -> (Vec<f32>, u32) {
        let bytes = std::fs::read(path).unwrap();
        let find = |tag: &[u8]| bytes.windows(4).position(|w| w == tag).unwrap();
        let fmt = find(b"fmt ") + 8;
        let channels = u16::from_le_bytes([bytes[fmt + 2], bytes[fmt + 3]]) as usize;
        let rate = u32::from_le_bytes([bytes[fmt + 4], bytes[fmt + 5], bytes[fmt + 6], bytes[fmt + 7]]);
        let data = find(b"data");
        let size = u32::from_le_bytes([bytes[data + 4], bytes[data + 5], bytes[data + 6], bytes[data + 7]]) as usize;
        let samples: Vec<f32> = bytes[data + 8..(data + 8 + size).min(bytes.len())].as_chunks::<2>().0.iter().map(|s| f32::from(i16::from_le_bytes(*s)) / 32768.0).collect();
        (samples.chunks(channels).map(|frame| frame.iter().sum::<f32>() / channels as f32).collect(), rate)
    }

    /// What Parakeet writes for the clips in NOVA_CLIPS, as they are and in worse
    /// conditions: `cargo test --lib -- --ignored wake_clips --nocapture`, with
    /// NOVA_RUNTIME and NOVA_PARAKEET set.
    #[test]
    #[ignore]
    fn wake_clips() {
        let runtime = crate::speech::runtime::get(std::path::Path::new(&std::env::var("NOVA_RUNTIME").unwrap())).unwrap();
        let dir = std::path::PathBuf::from(std::env::var("NOVA_PARAKEET").unwrap());
        let device = crate::speech::runtime::Device::Cpu { threads: 2 };
        let mut asr = crate::speech::stt::parakeet::Parakeet::open(runtime, &dir, &device).unwrap();
        let clips = std::path::PathBuf::from(std::env::var("NOVA_CLIPS").unwrap());
        let mut noise = 12345u32;
        for folder in ["call", "other"] {
            let mut files: Vec<_> = std::fs::read_dir(clips.join(folder)).unwrap().flatten().map(|e| e.path()).collect();
            files.sort();
            let (mut total, mut sure, mut near) = (0, 0, 0);
            for file in files {
                let (samples, rate) = read_wav(&file);
                let clean = crate::speech::wav::resample(&samples, rate, 16_000);
                let peak = clean.iter().fold(0f32, |m, s| m.max(s.abs())).max(0.001);
                let normal: Vec<f32> = clean.iter().map(|s| s / peak * 0.5).collect();
                let quiet: Vec<f32> = normal.iter().map(|s| s * 0.08).collect();
                let noisy: Vec<f32> = normal
                    .iter()
                    .map(|s| {
                        noise = noise.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                        s + (noise as f32 / u32::MAX as f32 - 0.5) * 0.05
                    })
                    .collect();
                // What the microphone's cut leaves: the "Hey" starts too late.
                let cut: Vec<f32> = normal.iter().skip(1600).copied().collect();
                for (condition, audio) in [("clean", &normal), ("quiet", &quiet), ("noisy", &noisy), ("cut", &cut)] {
                    let text = asr.transcribe(&prepared(audio)).unwrap_or_default();
                    let (verdict, request) = read_call(&text);
                    total += 1;
                    match verdict {
                        Call::Sure => sure += 1,
                        Call::Near => near += 1,
                        Call::No => {}
                    }
                    println!("{folder} {verdict:?} {condition} {} | {text} | {request:?}", file.file_stem().unwrap().to_string_lossy());
                }
            }
            println!("=== {folder}: {sure} sure, {near} near, of {total}");
        }
    }

    /// All from what Parakeet really wrote for spoken "Hey Nova"s and other phrases.
    #[test]
    fn knows_how_the_call_gets_written() {
        for text in ["Hey Nova", "Hey, Nova!", "hey nova.", "Hei Nova", "Hai, Nova", "He Nova", "Hey Nowa", "HEY NOVA, wie spät ist es?", "Nova.", "Eh, Nova", "Hey Innova", "Hey. Nuba.", "Hey, Nuba.", "Hi Nuba.", "Nuba.", "Nuova.", "Hi, no fa.", "Hi, Norfa.", "Inova, wie spät ist es?", "Hallo Nova", "Okay, Nova", "Nova, wie spät ist es?", "Ainova, mach Musik an.", "Einova machmusik an."] {
            assert_eq!(read_call(text).0, Call::Sure, "{text}");
        }
        for text in ["Herr Innova, mach Musik an.", "Herr Inova, wie spät ist es?", "Keinova, wie spät ist es?", "Genova", "Hanova.", "Hannova, wie spät ist es?"] {
            assert_eq!(read_call(text).0, Call::Near, "{text}");
        }
    }

    #[test]
    fn other_words_are_no_call() {
        for text in [
            "", "Hey", "Hey Nora", "Hey Noah", "Hi Noah.", "Hi Nora", "Heinora?", "Hey du", "Hey Laura.", "Hi Leute.", "Hey man", "No.", "No way.", "Nora.", "Die Nova ist ein Stern", "Gino ist ein Stern.", "Ich hab Hunger", "Supernova", "Eine Supernova.", "Casanova", "Cazanova",
            "Hasanova.", "Hannover.", "Hand over.", "Highover.", "Hain over.", "Ain't over.", "Nochmal.", "Na klar.", "Nein, danke.", "Neue Version", "Hi noch was.", "Hey noch was?", "I know that.", "I know.", "High.", "Nova kann das", "Nova ist cool",
        ] {
            assert_eq!(read_call(text).0, Call::No, "{text}");
        }
    }

    #[test]
    fn what_follows_the_call_is_the_request() {
        assert_eq!(read_call("Hey Nova, wie spät ist es?").1.as_deref(), Some("wie spät ist es?"));
        assert_eq!(read_call("Herr Innova, mach Musik an.").1.as_deref(), Some("mach Musik an."));
        assert_eq!(read_call("Hey, Nova! Spiel Blinding Lights").1.as_deref(), Some("Spiel Blinding Lights"));
        assert_eq!(read_call("Hey Nova.").1, None);
        assert_eq!(read_call("Nova").1, None);
        // A stray sound is no request.
        assert_eq!(read_call("Hey Nova, äh").1, None);
        assert_eq!(read_call("Die Nova ist ein Stern").1, None);
    }

    #[test]
    fn prepares_any_level_for_reading() {
        let audio = prepared(&[0.01, -0.02]);
        assert_eq!(audio.len(), 2 + 2 * 3200);
        assert!((audio[3201] - -0.24).abs() < 0.001, "amplified, but limited");
        assert!((prepared(&[0.8, -0.2])[3200] - 0.5).abs() < 0.001, "brought down too");
        assert_eq!(prepared(&[]).len(), 2 * 3200);
    }
}
