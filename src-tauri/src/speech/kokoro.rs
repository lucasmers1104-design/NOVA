//! Kokoro-82M with a German voice (the community "Martin" fine-tune):
//! IPA from eSpeak NG, Kokoro's token table, a style vector chosen by the
//! sentence length, 24 kHz audio. Marked experimental in Settings.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use ort::session::Session;
use ort::value::{Tensor, TensorElementType};

use super::runtime::{self, Device, Runtime};
use super::wav::Pcm;

pub const SAMPLE_RATE: u32 = 24_000;
/// Kokoro takes at most this many phoneme tokens at once.
const MAX_TOKENS: usize = 510;
const STYLE: usize = 256;

/// Kokoro-82M's phoneme table (config.json of hexgrad/Kokoro-82M).
const VOCAB: &[(char, i64)] = &[
    (';', 1), (':', 2), (',', 3), ('.', 4), ('!', 5), ('?', 6), ('—', 9), ('…', 10), ('"', 11), ('(', 12), (')', 13), ('“', 14), ('”', 15), (' ', 16), ('\u{303}', 17),
    ('ʣ', 18), ('ʥ', 19), ('ʦ', 20), ('ʨ', 21), ('ᵝ', 22), ('ꭧ', 23), ('A', 24), ('I', 25), ('O', 31), ('Q', 33), ('S', 35), ('T', 36), ('W', 39), ('Y', 41), ('ᵊ', 42),
    ('a', 43), ('b', 44), ('c', 45), ('d', 46), ('e', 47), ('f', 48), ('h', 50), ('i', 51), ('j', 52), ('k', 53), ('l', 54), ('m', 55), ('n', 56), ('o', 57), ('p', 58),
    ('q', 59), ('r', 60), ('s', 61), ('t', 62), ('u', 63), ('v', 64), ('w', 65), ('x', 66), ('y', 67), ('z', 68), ('ɑ', 69), ('ɐ', 70), ('ɒ', 71), ('æ', 72), ('β', 75),
    ('ɔ', 76), ('ɕ', 77), ('ç', 78), ('ɖ', 80), ('ð', 81), ('ʤ', 82), ('ə', 83), ('ɚ', 85), ('ɛ', 86), ('ɜ', 87), ('ɟ', 90), ('ɡ', 92), ('ɥ', 99), ('ɨ', 101), ('ɪ', 102),
    ('ʝ', 103), ('ɯ', 110), ('ɰ', 111), ('ŋ', 112), ('ɳ', 113), ('ɲ', 114), ('ɴ', 115), ('ø', 116), ('ɸ', 118), ('θ', 119), ('œ', 120), ('ɹ', 123), ('ɾ', 125), ('ɻ', 126),
    ('ʁ', 128), ('ɽ', 129), ('ʂ', 130), ('ʃ', 131), ('ʈ', 132), ('ʧ', 133), ('ʊ', 135), ('ʋ', 136), ('ʌ', 138), ('ɣ', 139), ('ɤ', 140), ('χ', 142), ('ʎ', 143), ('ʒ', 147),
    ('ʔ', 148), ('ˈ', 156), ('ˌ', 157), ('ː', 158), ('ʰ', 162), ('ʲ', 164), ('↓', 169), ('→', 171), ('↗', 172), ('↘', 173), ('ᵻ', 177),
];

/// Kokoro tokens for a sentence's phonemes (unknown ones are left out).
pub fn tokens(phonemes: &str) -> Vec<i64> {
    let table: HashMap<char, i64> = VOCAB.iter().copied().collect();
    phonemes.chars().filter_map(|c| table.get(&c).copied()).collect()
}

/// Reads a float32 `.npy` array (Kokoro's voice: style vectors by length).
pub fn read_npy(bytes: &[u8]) -> Result<(Vec<usize>, Vec<f32>), String> {
    if bytes.get(..6) != Some(b"\x93NUMPY".as_slice()) {
        return Err("Not a .npy file".into());
    }
    let major = bytes[6];
    let (len, start) = if major == 1 { (u16::from_le_bytes([bytes[8], bytes[9]]) as usize, 10) } else { (u32::from_le_bytes(bytes[8..12].try_into().map_err(|_| "Bad .npy")?) as usize, 12) };
    let header = std::str::from_utf8(bytes.get(start..start + len).ok_or("Bad .npy")?).map_err(|e| e.to_string())?;
    if !header.contains("'<f4'") || header.contains("'fortran_order': True") {
        return Err("Unexpected voice format".into());
    }
    let shape_text = header.split("'shape':").nth(1).and_then(|s| s.split('(').nth(1)).and_then(|s| s.split(')').next()).ok_or("Bad .npy shape")?;
    let shape: Vec<usize> = shape_text.split(',').filter_map(|d| d.trim().parse().ok()).collect();
    let data: Vec<f32> = bytes[start + len..].as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect();
    if data.len() != shape.iter().product::<usize>() {
        return Err("The voice file is incomplete".into());
    }
    Ok((shape, data))
}

pub struct Kokoro {
    session: Session,
    /// Style vectors, one per token count.
    styles: Vec<f32>,
    rows: usize,
    espeak: PathBuf,
    device: Device,
    /// Newer exports call the input "input_ids" and take the speed as an integer.
    names: (String, bool),
    output: String,
}

impl Kokoro {
    pub fn open(runtime: &Runtime, model: &Path, voice: &Path, device: &Device, espeak: &Path) -> Result<Self, String> {
        let (shape, styles) = read_npy(&std::fs::read(voice).map_err(|e| e.to_string())?)?;
        if shape.last() != Some(&STYLE) {
            return Err("Unexpected Kokoro voice".into());
        }
        let session = runtime::session(runtime, model, device)?;
        let ids = session.inputs().iter().find(|i| i.name() == "input_ids" || i.name() == "tokens").map(|i| i.name().to_string()).ok_or("Unexpected Kokoro model")?;
        let int_speed = session.inputs().iter().find(|i| i.name() == "speed").and_then(|i| i.dtype().tensor_type()) == Some(TensorElementType::Int32);
        let output = session.outputs().first().map(|o| o.name().to_string()).ok_or("Kokoro has no output")?;
        Ok(Self { session, rows: styles.len() / STYLE, styles, espeak: espeak.to_path_buf(), device: device.clone(), names: (ids, int_speed), output })
    }

    fn sentence(&mut self, tokens: &[i64], rate: f32) -> Result<Vec<f32>, String> {
        let tokens = &tokens[..tokens.len().min(MAX_TOKENS)];
        let row = tokens.len().min(self.rows.saturating_sub(1));
        let style = self.styles[row * STYLE..(row + 1) * STYLE].to_vec();
        let mut ids = Vec::with_capacity(tokens.len() + 2);
        ids.push(0);
        ids.extend_from_slice(tokens);
        ids.push(0);
        let fail = |e: ort::Error| e.to_string();
        let len = ids.len();
        let speed: ort::session::SessionInputValue = if self.names.1 {
            Tensor::from_array(([1usize], vec![rate.round().max(1.0) as i32])).map_err(fail)?.into()
        } else {
            Tensor::from_array(([1usize], vec![rate])).map_err(fail)?.into()
        };
        let inputs = vec![
            (std::borrow::Cow::from(self.names.0.clone()), Tensor::from_array(([1usize, len], ids)).map_err(fail)?.into()),
            ("style".into(), Tensor::from_array(([1usize, STYLE], style)).map_err(fail)?.into()),
            ("speed".into(), speed),
        ];
        let outputs = self.session.run(inputs).map_err(fail)?;
        let (_, audio) = outputs[self.output.as_str()].try_extract_tensor::<f32>().map_err(fail)?;
        Ok(audio.to_vec())
    }
}

impl super::TtsEngine for Kokoro {
    fn synthesize(&mut self, text: &str, rate: f32) -> Result<Pcm, String> {
        let rate = if rate.is_finite() { rate.clamp(0.5, 2.0) } else { 1.0 };
        let sentences = super::phonemize::sentences_composed(&self.espeak, "de", text)?;
        let pause = (0.2 * SAMPLE_RATE as f32) as usize;
        let mut samples = Vec::new();
        for sentence in sentences.iter().filter(|s| !s.trim().is_empty()) {
            let tokens = tokens(sentence);
            if tokens.is_empty() {
                continue;
            }
            samples.extend(self.sentence(&tokens, rate)?);
            samples.extend(std::iter::repeat_n(0.0, pause));
        }
        Ok(Pcm { rate: SAMPLE_RATE, samples })
    }

    fn device(&self) -> Device {
        self.device.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_phonemes_to_kokoro_tokens() {
        assert_eq!(tokens("hˈaloː, ç?"), vec![50, 156, 43, 54, 57, 158, 3, 16, 78, 6]);
        assert_eq!(tokens("€"), Vec::<i64>::new());
    }

    #[test]
    fn reads_npy_voices() {
        let header = "{'descr': '<f4', 'fortran_order': False, 'shape': (2, 1, 256), }";
        let mut padded = header.to_string();
        while !(10 + padded.len() + 1).is_multiple_of(64) {
            padded.push(' ');
        }
        padded.push('\n');
        let mut bytes = b"\x93NUMPY\x01\x00".to_vec();
        bytes.extend_from_slice(&(padded.len() as u16).to_le_bytes());
        bytes.extend_from_slice(padded.as_bytes());
        for i in 0..512 {
            bytes.extend_from_slice(&(i as f32).to_le_bytes());
        }
        let (shape, data) = read_npy(&bytes).unwrap();
        assert_eq!(shape, vec![2, 1, 256]);
        assert_eq!(data[300], 300.0);
        assert!(read_npy(b"nope").is_err());
    }
}
