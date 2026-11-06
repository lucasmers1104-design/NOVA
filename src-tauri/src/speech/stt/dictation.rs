//! One spoken turn with the offline recognizer: the microphone runs through
//! Silero VAD; each phrase is transcribed by Parakeet the moment it ends,
//! while listening goes on, so at the end of the turn only the last phrase
//! is left to do.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use super::vad::{Edge, Segmenter, FRAME};
use super::Recognizer;

/// What happens during the turn.
pub enum Event {
    Listening,
    Level(f32),
    /// Everything understood so far.
    Hypothesis(String),
    Processing,
}

#[derive(Debug, Default)]
pub struct Turn {
    pub text: String,
    pub heard_speech: bool,
    /// The loudest the microphone got, 0–1.
    pub peak: f32,
    pub speech_ms: Option<u128>,
    pub phrases: u32,
    /// How long each phrase took to transcribe.
    pub decode_ms: Vec<u128>,
    pub stop_ms: Option<u128>,
    pub last_change_ms: Option<u128>,
    /// Waiting for the last phrase after the turn ended.
    pub final_wait_ms: u128,
    pub end_pause_ms: u128,
}

/// Silence that ends a phrase (it is transcribed then).
const PHRASE_END_MS: u32 = 300;
/// Audio kept from before the start of speech.
const PRE_ROLL: Duration = Duration::from_millis(200);
const NOTHING_SAID: Duration = Duration::from_secs(8);
const LONGEST_TURN: Duration = Duration::from_secs(90);
/// Phrases are cut at this length, so a long monologue is transcribed as it goes.
const LONGEST_PHRASE: Duration = Duration::from_secs(15);

/// Streams microphone audio down to 16 kHz for the VAD (a cheap low-pass and
/// linear steps; the phrases themselves are resampled properly).
pub struct Downsampler {
    ratio: f64,
    position: f64,
    previous: f32,
    smoothed: f32,
    alpha: f32,
}

impl Downsampler {
    pub fn new(rate: u32) -> Self {
        let ratio = rate as f64 / 16_000.0;
        // One-pole low-pass near 7 kHz.
        let alpha = (1.0 - (-2.0 * std::f64::consts::PI * 7_000.0 / rate as f64).exp()) as f32;
        Self { ratio, position: 0.0, previous: 0.0, smoothed: 0.0, alpha }
    }

    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        for &sample in input {
            self.smoothed += self.alpha * (sample - self.smoothed);
            while self.position < 1.0 {
                out.push(self.previous + (self.smoothed - self.previous) * self.position as f32);
                self.position += self.ratio;
            }
            self.position -= 1.0;
            self.previous = self.smoothed;
        }
    }
}

/// Runs the turn on the calling thread (COM must be initialized there).
#[cfg(windows)]
pub fn listen(recognizer: &mut Recognizer, stop: &AtomicBool, send: &mut dyn FnMut(Event), end_pause: &dyn Fn(&str) -> Duration) -> Result<Turn, String> {
    let Recognizer { asr, vad, .. } = recognizer;
    let (to_decoder, phrases) = std::sync::mpsc::channel::<(usize, Vec<f32>, u32)>();
    let (to_listener, results) = std::sync::mpsc::channel::<(usize, String, u128)>();
    let started = Instant::now();
    let mut turn = Turn::default();
    let capture_stop = AtomicBool::new(false);
    let decode_error = std::sync::OnceLock::<String>::new();
    let decode_error = &decode_error;
    let outcome: Result<(), String> = std::thread::scope(|scope| {
        // Transcribes each phrase as soon as it is complete.
        let decoder = scope.spawn(move || {
            for (index, audio, rate) in phrases {
                let begun = Instant::now();
                let audio = crate::speech::wav::resample(&audio, rate, 16_000);
                let text = match asr.transcribe(&audio) {
                    Ok(text) => text,
                    Err(error) => {
                        decode_error.get_or_init(|| error);
                        String::new()
                    }
                };
                if to_listener.send((index, text, begun.elapsed().as_millis())).is_err() {
                    break;
                }
            }
        });
        let mut texts: Vec<Option<String>> = Vec::new();
        let mut segmenter = Segmenter::new(PHRASE_END_MS);
        let mut downsampler: Option<Downsampler> = None;
        let mut frames: Vec<f32> = Vec::new();
        let mut pre_roll: std::collections::VecDeque<f32> = std::collections::VecDeque::new();
        let mut phrase: Vec<f32> = Vec::new();
        let mut phrase_started: Option<Instant> = None;
        let mut last_end: Option<Instant> = None;
        let mut last_change: Option<Instant> = None;
        let mut rate = 48_000;
        let mut announced = false;
        let mut vad_error = None;
        let close_phrase = |phrase: &mut Vec<f32>, texts: &mut Vec<Option<String>>, rate: u32| {
            if phrase.is_empty() {
                return;
            }
            texts.push(None);
            let _ = to_decoder.send((texts.len() - 1, std::mem::take(phrase), rate));
        };
        let capture = capture(&capture_stop, |chunk, mic_rate| {
            rate = mic_rate;
            if !announced {
                announced = true;
                send(Event::Listening);
            }
            let peak = chunk.iter().fold(0f32, |m, s| m.max(s.abs()));
            turn.peak = turn.peak.max(peak);
            send(Event::Level(peak.min(1.0)));
            // Pre-roll and the phrase in progress, at the microphone's rate.
            if phrase_started.is_some() {
                phrase.extend_from_slice(chunk);
            } else {
                pre_roll.extend(chunk);
                let keep = (mic_rate as f64 * PRE_ROLL.as_secs_f64()) as usize;
                while pre_roll.len() > keep {
                    pre_roll.pop_front();
                }
            }
            downsampler.get_or_insert_with(|| Downsampler::new(mic_rate)).push(chunk, &mut frames);
            while frames.len() >= FRAME {
                let frame: Vec<f32> = frames.drain(..FRAME).collect();
                let probability = match vad.probability(&frame) {
                    Ok(p) => p,
                    Err(e) => {
                        vad_error = Some(e);
                        capture_stop.store(true, Ordering::SeqCst);
                        return;
                    }
                };
                match segmenter.push(probability) {
                    Some(Edge::Start) => {
                        turn.heard_speech = true;
                        turn.speech_ms.get_or_insert(started.elapsed().as_millis());
                        phrase_started = Some(Instant::now());
                        phrase = pre_roll.drain(..).collect();
                    }
                    Some(Edge::End) => {
                        phrase_started = None;
                        last_end = Some(Instant::now());
                        turn.phrases += 1;
                        close_phrase(&mut phrase, &mut texts, mic_rate);
                    }
                    None => {}
                }
            }
            if phrase_started.is_some_and(|t| t.elapsed() >= LONGEST_PHRASE) {
                phrase_started = Some(Instant::now());
                close_phrase(&mut phrase, &mut texts, mic_rate);
            }
            // Phrases finished meanwhile.
            while let Ok((index, text, ms)) = results.try_recv() {
                turn.decode_ms.push(ms);
                if let Some(slot) = texts.get_mut(index) {
                    *slot = Some(text);
                }
                last_change = Some(Instant::now());
                send(Event::Hypothesis(join(&texts)));
            }
            // The turn ends after a pause that fits what was said so far.
            let so_far = join(&texts);
            let pause = end_pause(&so_far).saturating_sub(Duration::from_millis(PHRASE_END_MS as u64));
            // A pause ends the turn only once it has words and they are all in: a
            // cough decodes to nothing, and a slow PC is still working on the last phrase.
            let all_in = !so_far.is_empty() && texts.iter().all(Option::is_some);
            let done = stop.load(Ordering::SeqCst)
                || (so_far.is_empty() && !segmenter.speaking() && texts.iter().all(Option::is_some) && started.elapsed() >= NOTHING_SAID)
                || (all_in && !segmenter.speaking() && last_end.is_some_and(|t| t.elapsed() >= pause))
                || started.elapsed() >= LONGEST_TURN;
            if done && !capture_stop.load(Ordering::SeqCst) {
                turn.stop_ms = Some(started.elapsed().as_millis());
                turn.end_pause_ms = pause.as_millis() + PHRASE_END_MS as u128;
                capture_stop.store(true, Ordering::SeqCst);
            }
        });
        send(Event::Processing);
        // Whatever was still being said counts too.
        if phrase_started.is_some() {
            turn.phrases += 1;
            close_phrase(&mut phrase, &mut texts, rate);
        }
        let waiting = Instant::now();
        drop(to_decoder);
        for (index, text, ms) in results.iter() {
            turn.decode_ms.push(ms);
            if let Some(slot) = texts.get_mut(index) {
                *slot = Some(text);
            }
            last_change = Some(Instant::now());
        }
        let _ = decoder.join();
        turn.final_wait_ms = waiting.elapsed().as_millis();
        turn.text = join(&texts);
        turn.last_change_ms = last_change.map(|t| t.duration_since(started).as_millis());
        if let Some(error) = vad_error {
            return Err(error);
        }
        // Only when it cost words; otherwise the turn went fine.
        if let Some(error) = decode_error.get().filter(|_| turn.text.is_empty()) {
            return Err(format!("NOVA's offline recognizer failed: {error}"));
        }
        capture.map_err(|e| format!("The microphone couldn't be used ({e:?})"))
    });
    outcome?;
    Ok(turn)
}

/// The microphone (with Windows' speech processing), or in debug builds a WAV
/// file from `NOVA_DEV_STT_WAV` played in real time, for end-to-end tests.
#[cfg(windows)]
fn capture(stop: &AtomicBool, sink: impl FnMut(&[f32], u32)) -> Result<(), crate::wake::mic::MicError> {
    let test_file = if cfg!(debug_assertions) { std::env::var_os("NOVA_DEV_STT_WAV") } else { None };
    let Some(path) = test_file else { return crate::wake::mic::capture_with(stop, false, sink) };
    let mut sink = sink;
    let pcm = std::fs::read(path)
        .ok()
        .and_then(|b| crate::speech::wav::from_wav(&b))
        .ok_or_else(|| crate::wake::mic::MicError::Other("NOVA_DEV_STT_WAV isn't a 16-bit WAV".into()))?;
    let chunk = (pcm.rate / 50) as usize;
    // The file, then silence until the turn ends.
    let mut parts = pcm.samples.chunks(chunk);
    let silence = vec![0.0; chunk];
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(20));
        sink(parts.next().unwrap_or(&silence), pcm.rate);
    }
    Ok(())
}

fn join(texts: &[Option<String>]) -> String {
    texts.iter().flatten().map(|t| t.trim()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downsampling_keeps_time() {
        let mut down = Downsampler::new(48_000);
        let mut out = Vec::new();
        for _ in 0..50 {
            down.push(&[0.25; 960], &mut out);
        }
        // One second at 48 kHz → one second at 16 kHz.
        assert!((15_990..=16_010).contains(&out.len()), "{}", out.len());
        assert!((out.last().unwrap() - 0.25).abs() < 0.01);
        assert_eq!(join(&[Some(" Öffne ".into()), None, Some("die Datei".into())]), "Öffne die Datei");
    }
}
