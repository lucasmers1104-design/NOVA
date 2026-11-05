//! Piper voices (VITS) running inside NOVA on the speech runtime: the same
//! phonemes, ids, scales and loudness handling as piper.exe, without a
//! separate process or temporary files — and on the graphics card when that
//! is faster.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use ort::session::Session;
use ort::value::Tensor;

use super::runtime::{self, Device, Runtime};
use super::wav::Pcm;

/// Silence after each sentence (seconds), as NOVA has always used.
pub const SENTENCE_SILENCE: f32 = 0.25;

#[derive(Debug, Clone, PartialEq)]
pub struct PiperConfig {
    pub sample_rate: u32,
    pub noise_scale: f32,
    pub length_scale: f32,
    pub noise_w: f32,
    /// eSpeak voice for the phonemes ("de").
    pub espeak_voice: String,
    pub ids: HashMap<char, Vec<i64>>,
    pub speakers: HashMap<String, i64>,
    pub num_speakers: u32,
}

impl PiperConfig {
    pub fn parse(json: &str) -> Result<Self, String> {
        let value: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("The voice's settings are damaged: {e}"))?;
        let mut ids = HashMap::new();
        for (phoneme, list) in value["phoneme_id_map"].as_object().ok_or("The voice has no phoneme table")? {
            let mut chars = phoneme.chars();
            let (Some(c), None) = (chars.next(), chars.next()) else { continue };
            ids.insert(c, list.as_array().map(|l| l.iter().filter_map(|v| v.as_i64()).collect()).unwrap_or_default());
        }
        let inference = &value["inference"];
        let speakers = value["speaker_id_map"].as_object().map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_i64()?))).collect()).unwrap_or_default();
        Ok(Self {
            sample_rate: value["audio"]["sample_rate"].as_u64().unwrap_or(22050) as u32,
            noise_scale: inference["noise_scale"].as_f64().unwrap_or(0.667) as f32,
            length_scale: inference["length_scale"].as_f64().unwrap_or(1.0) as f32,
            noise_w: inference["noise_w"].as_f64().unwrap_or(0.8) as f32,
            espeak_voice: value["espeak"]["voice"].as_str().unwrap_or("de").to_string(),
            ids,
            speakers,
            num_speakers: value["num_speakers"].as_u64().unwrap_or(1) as u32,
        })
    }

    /// Phoneme ids for one sentence: start, pad between all, end — as
    /// piper-phonemize's `phonemes_to_ids`. Unknown phonemes are skipped.
    pub fn phoneme_ids(&self, phonemes: &str) -> Vec<i64> {
        let id = |c: char| self.ids.get(&c).cloned().unwrap_or_default();
        let pad = id('_');
        let mut out = id('^');
        out.extend(&pad);
        for c in phonemes.chars() {
            let Some(ids) = self.ids.get(&c) else { continue };
            out.extend(ids);
            out.extend(&pad);
        }
        out.extend(id('$'));
        out
    }
}

pub struct Piper {
    session: Session,
    output: String,
    config: PiperConfig,
    speaker: Option<i64>,
    espeak: PathBuf,
    device: Device,
}

impl Piper {
    pub fn open(runtime: &Runtime, model: &Path, config: &Path, device: &Device, speaker: Option<&str>, espeak: &Path) -> Result<Self, String> {
        let config = PiperConfig::parse(&std::fs::read_to_string(config).map_err(|e| e.to_string())?)?;
        let session = runtime::session_cached(runtime, model, device)?;
        let speaker = (config.num_speakers > 1).then(|| speaker.and_then(|s| config.speakers.get(s).copied()).unwrap_or(0));
        let output = session.outputs().first().map(|o| o.name().to_string()).ok_or("The voice has no output")?;
        Ok(Self { session, output, config, speaker, espeak: espeak.to_path_buf(), device: device.clone() })
    }

    pub fn device(&self) -> &Device {
        &self.device
    }

    pub fn config(&self) -> &PiperConfig {
        &self.config
    }

    /// Audio for one sentence's phoneme ids (`rate` 2 = twice as fast), peak-normalized like Piper.
    pub fn synthesize_ids(&mut self, ids: Vec<i64>, rate: f32, noise: Option<(f32, f32)>) -> Result<Vec<f32>, String> {
        let rate = if rate.is_finite() { rate.clamp(0.5, 2.0) } else { 1.0 };
        let (noise_scale, noise_w) = noise.unwrap_or((self.config.noise_scale, self.config.noise_w));
        let len = ids.len();
        let fail = |e: ort::Error| e.to_string();
        let mut inputs = ort::inputs![
            "input" => Tensor::from_array(([1usize, len], ids)).map_err(fail)?,
            "input_lengths" => Tensor::from_array(([1usize], vec![len as i64])).map_err(fail)?,
            "scales" => Tensor::from_array(([3usize], vec![noise_scale, self.config.length_scale / rate, noise_w])).map_err(fail)?,
        ];
        if let Some(speaker) = self.speaker {
            inputs.push(("sid".into(), Tensor::from_array(([1usize], vec![speaker])).map_err(fail)?.into()));
        }
        let outputs = self.session.run(inputs).map_err(fail)?;
        let (_, audio) = outputs[self.output.as_str()].try_extract_tensor::<f32>().map_err(fail)?;
        let peak = audio.iter().fold(0.01f32, |m, s| m.max(s.abs()));
        let scale = 32767.0 / peak;
        // Piper rounds to 16 bit after scaling; keep that loudness (as floats).
        Ok(audio.iter().map(|s| (s * scale).clamp(-32768.0, 32767.0).trunc() / 32768.0).collect())
    }

    /// Speaks `text`: sentence by sentence, each followed by a short pause.
    pub fn synthesize(&mut self, text: &str, rate: f32) -> Result<Pcm, String> {
        let sentences = super::phonemize::sentences(&self.espeak, &self.config.espeak_voice, text)?;
        let silence = (SENTENCE_SILENCE * self.config.sample_rate as f32) as usize;
        let mut samples = Vec::new();
        for sentence in sentences.iter().filter(|s| !s.trim().is_empty()) {
            let ids = self.config.phoneme_ids(sentence);
            samples.extend(self.synthesize_ids(ids, rate, None)?);
            samples.extend(std::iter::repeat_n(0.0, silence));
        }
        Ok(Pcm { rate: self.config.sample_rate, samples })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = r#"{
        "audio": { "sample_rate": 22050 },
        "espeak": { "voice": "de" },
        "inference": { "noise_scale": 0.667, "length_scale": 1, "noise_w": 0.8 },
        "num_speakers": 1,
        "phoneme_id_map": { "_": [0], "^": [1], "$": [2], " ": [3], ",": [8], "?": [13], "a": [14], "h": [20], "l": [24], "o": [27], "ˈ": [120], "ː": [122] }
    }"#;

    #[test]
    fn ids_match_piper_phonemize() {
        let config = PiperConfig::parse(CONFIG).unwrap();
        // From piper.exe --debug: "hˈaloː, " → 1, 0, 20, 0, 120, 0, 14, 0, 24, 0, 27, 0, 122, 0, 8, 0, 3, 0, …
        assert_eq!(config.phoneme_ids("hˈaloː, "), vec![1, 0, 20, 0, 120, 0, 14, 0, 24, 0, 27, 0, 122, 0, 8, 0, 3, 0, 2]);
        assert_eq!(config.phoneme_ids("h€a"), vec![1, 0, 20, 0, 14, 0, 2], "unknown phonemes are skipped");
        assert_eq!(config.sample_rate, 22050);
        assert_eq!(config.espeak_voice, "de");
    }
}
