//! NVIDIA Parakeet TDT 0.6B v3 (int8, ONNX export by onnx-asr): offline
//! speech recognition for 25 European languages, German included. Audio →
//! log-mel features (nemo128.onnx) → encoder → token-and-duration decoding.

use std::path::Path;

use ort::session::Session;
use ort::value::Tensor;

use crate::speech::runtime::{self, Device, Runtime};

/// Tokens emitted for one encoder frame before NOVA moves on regardless.
const MAX_TOKENS_PER_STEP: usize = 10;

pub struct Parakeet {
    preprocessor: Session,
    encoder: Session,
    decoder: Session,
    vocab: Vec<String>,
    blank: usize,
    state_shape: [usize; 3],
}

/// The token table: "token id" per line; "▁" marks a word start.
pub fn read_vocab(text: &str) -> Vec<String> {
    let mut pairs: Vec<(usize, String)> = text
        .lines()
        .filter_map(|line| {
            let (token, id) = line.rsplit_once(' ')?;
            Some((id.trim().parse().ok()?, token.to_string()))
        })
        .collect();
    pairs.sort_by_key(|(id, _)| *id);
    pairs.into_iter().map(|(_, t)| t).collect()
}

/// Joins tokens into text.
pub fn detokenize(vocab: &[String], tokens: &[usize]) -> String {
    let text: String = tokens.iter().filter_map(|&t| vocab.get(t)).filter(|t| !(t.starts_with("<") && t.ends_with('>'))).map(|t| t.replace('▁', " ")).collect();
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Greedy decoding for a token-and-duration transducer: at each frame the
/// joint network names a token (or blank) and how many frames to skip.
pub fn tdt_decode(frames: usize, blank: usize, mut step: impl FnMut(usize, Option<usize>) -> Result<(Vec<f32>, Vec<f32>), String>) -> Result<Vec<usize>, String> {
    let mut tokens: Vec<usize> = Vec::new();
    let mut t = 0;
    let mut emitted = 0;
    while t < frames {
        // `step` gives the token and duration logits for frame t after the last token.
        let (logits, durations) = step(t, tokens.last().copied())?;
        let token = argmax(&logits);
        let skip = argmax(&durations);
        if token != blank {
            tokens.push(token);
            emitted += 1;
        }
        if skip > 0 {
            t += skip;
            emitted = 0;
        } else if token == blank || emitted == MAX_TOKENS_PER_STEP {
            t += 1;
            emitted = 0;
        }
    }
    Ok(tokens)
}

fn argmax(values: &[f32]) -> usize {
    values.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).map(|(i, _)| i).unwrap_or(0)
}

impl Parakeet {
    pub fn open(runtime: &Runtime, dir: &Path, device: &Device) -> Result<Self, String> {
        // Feature extraction is tiny and shape-changing: it always runs on the processor.
        let preprocessor = runtime::session(runtime, &dir.join("nemo128.onnx"), &Device::Cpu { threads: 1 })?;
        let encoder = runtime::session(runtime, &dir.join("encoder-model.int8.onnx"), device)?;
        let decoder = runtime::session(runtime, &dir.join("decoder_joint-model.int8.onnx"), &match device {
            // The decoder runs once per frame on tiny inputs: the processor is faster for it.
            Device::DirectMl { .. } => Device::Cpu { threads: 1 },
            other => other.clone(),
        })?;
        let vocab = read_vocab(&std::fs::read_to_string(dir.join("vocab.txt")).map_err(|e| e.to_string())?);
        let blank = vocab.iter().position(|t| t == "<blk>").unwrap_or(vocab.len().saturating_sub(1));
        let state_shape = decoder
            .inputs()
            .iter()
            .find(|i| i.name() == "input_states_1")
            .and_then(|i| i.dtype().tensor_shape().map(|s| s.to_vec()))
            .map(|s| [s.first().copied().unwrap_or(2).max(1) as usize, 1, s.get(2).copied().unwrap_or(640).max(1) as usize])
            .unwrap_or([2, 1, 640]);
        Ok(Self { preprocessor, encoder, decoder, vocab, blank, state_shape })
    }

    /// Text spoken in `audio` (16 kHz mono).
    pub fn transcribe(&mut self, audio: &[f32]) -> Result<String, String> {
        if audio.len() < 1600 {
            return Ok(String::new());
        }
        let fail = |e: ort::Error| e.to_string();
        let features = self
            .preprocessor
            .run(ort::inputs![
                "waveforms" => Tensor::from_array(([1usize, audio.len()], audio.to_vec())).map_err(fail)?,
                "waveforms_lens" => Tensor::from_array(([1usize], vec![audio.len() as i64])).map_err(fail)?,
            ])
            .map_err(fail)?;
        let (shape, data) = features["features"].try_extract_tensor::<f32>().map_err(fail)?;
        let (mels, frames) = (shape[1] as usize, shape[2] as usize);
        let lens = features["features_lens"].try_extract_tensor::<i64>().map_err(fail)?.1.first().copied().unwrap_or(frames as i64);
        let input = Tensor::from_array(([1usize, mels, frames], data.to_vec())).map_err(fail)?;
        drop(features);
        let encoded = self
            .encoder
            .run(ort::inputs!["audio_signal" => input, "length" => Tensor::from_array(([1usize], vec![lens])).map_err(fail)?])
            .map_err(fail)?;
        let (shape, data) = encoded["outputs"].try_extract_tensor::<f32>().map_err(fail)?;
        let (dim, steps) = (shape[1] as usize, shape[2] as usize);
        let valid = encoded["encoded_lengths"].try_extract_tensor::<i64>().map_err(fail)?.1.first().map(|&l| l as usize).unwrap_or(steps).min(steps);
        // [1, D, T] → one D-vector per frame.
        let frame = |t: usize| -> Vec<f32> { (0..dim).map(|d| data[d * steps + t]).collect() };
        let vocab_len = self.vocab.len();
        let state_len: usize = self.state_shape.iter().product();
        let mut state = (vec![0f32; state_len], vec![0f32; state_len]);
        let blank = self.blank;
        let shape = self.state_shape;
        let decoder = &mut self.decoder;
        let tokens = tdt_decode(valid, blank, |t, last| {
            let outputs = decoder
                .run(ort::inputs![
                    "encoder_outputs" => Tensor::from_array(([1usize, dim, 1], frame(t))).map_err(fail)?,
                    "targets" => Tensor::from_array(([1usize, 1], vec![last.unwrap_or(blank) as i32])).map_err(fail)?,
                    "target_length" => Tensor::from_array(([1usize], vec![1i32])).map_err(fail)?,
                    "input_states_1" => Tensor::from_array((shape, state.0.clone())).map_err(fail)?,
                    "input_states_2" => Tensor::from_array((shape, state.1.clone())).map_err(fail)?,
                ])
                .map_err(fail)?;
            let (_, logits) = outputs["outputs"].try_extract_tensor::<f32>().map_err(fail)?;
            let token_logits = logits[..vocab_len.min(logits.len())].to_vec();
            let durations = logits.get(vocab_len..).unwrap_or(&[]).to_vec();
            let next = (outputs["output_states_1"].try_extract_tensor::<f32>().map_err(fail)?.1.to_vec(), outputs["output_states_2"].try_extract_tensor::<f32>().map_err(fail)?.1.to_vec());
            // The new state counts only once a real token was emitted.
            if argmax(&token_logits) != blank {
                state = next;
            }
            Ok((token_logits, durations))
        })?;
        Ok(detokenize(&self.vocab, &tokens))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_token_table_and_joins_words() {
        let vocab = read_vocab("<unk> 0\n▁Hallo 1\n▁Welt 2\n! 3\n<blk> 4\n");
        assert_eq!(vocab, vec!["<unk>", "▁Hallo", "▁Welt", "!", "<blk>"]);
        assert_eq!(detokenize(&vocab, &[1, 2, 3]), "Hallo Welt!");
        assert_eq!(detokenize(&vocab, &[0, 1]), "Hallo");
    }

    #[test]
    fn decodes_tokens_and_durations() {
        // Frames 0..6; blank = 3. Frame 0: token 1, stay; then blank, skip 2; frame 2: token 2 and skip 4 → done.
        let script = |t: usize, last: Option<usize>| -> (Vec<f32>, Vec<f32>) {
            match (t, last) {
                (0, None) => (vec![0.0, 9.0, 0.0, 0.0], vec![9.0, 0.0, 0.0, 0.0, 0.0]),
                (0, Some(1)) => (vec![0.0, 0.0, 0.0, 9.0], vec![0.0, 0.0, 9.0, 0.0, 0.0]),
                (2, _) => (vec![0.0, 0.0, 9.0, 0.0], vec![0.0, 0.0, 0.0, 0.0, 9.0]),
                _ => (vec![0.0, 0.0, 0.0, 9.0], vec![0.0, 9.0, 0.0, 0.0, 0.0]),
            }
        };
        let tokens = tdt_decode(6, 3, |t, last| {
            Ok(script(t, last))
        })
        .unwrap();
        assert_eq!(tokens, vec![1, 2]);
        // A frame that keeps naming tokens moves on after ten.
        let stuck = tdt_decode(2, 3, |_, _| Ok((vec![0.0, 9.0, 0.0, 0.0], vec![9.0, 0.0, 0.0, 0.0, 0.0]))).unwrap();
        assert_eq!(stuck.len(), 2 * MAX_TOKENS_PER_STEP);
    }
}
