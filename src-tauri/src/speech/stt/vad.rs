//! Silero VAD (v5): how likely each 32 ms of microphone audio is speech, and
//! where spoken phrases start and end.

use std::path::Path;

use ort::session::Session;
use ort::value::Tensor;

use crate::speech::runtime::{self, Device, Runtime};

/// Samples per frame at 16 kHz (32 ms).
pub const FRAME: usize = 512;
/// Silero v5 looks at the end of the previous frame too.
const CONTEXT: usize = 64;
const FRAME_MS: u32 = 32;

pub struct Vad {
    session: Session,
    state: Vec<f32>,
    context: Vec<f32>,
    /// Some exports take the sample rate as a scalar, others as [1].
    scalar_rate: bool,
}

impl Vad {
    pub fn open(runtime: &Runtime, model: &Path) -> Result<Self, String> {
        let session = runtime::session(runtime, model, &Device::Cpu { threads: 1 })?;
        let scalar_rate = session.inputs().iter().find(|i| i.name() == "sr").and_then(|i| i.dtype().tensor_shape().map(|s| s.is_empty())).unwrap_or(true);
        Ok(Self { session, state: vec![0.0; 2 * 128], context: vec![0.0; CONTEXT], scalar_rate })
    }

    pub fn reset(&mut self) {
        self.state.iter_mut().for_each(|s| *s = 0.0);
        self.context.iter_mut().for_each(|s| *s = 0.0);
    }

    /// Speech probability of one frame (`FRAME` samples, 16 kHz).
    pub fn probability(&mut self, frame: &[f32]) -> Result<f32, String> {
        let fail = |e: ort::Error| e.to_string();
        let mut input = Vec::with_capacity(CONTEXT + FRAME);
        input.extend_from_slice(&self.context);
        input.extend_from_slice(&frame[..FRAME.min(frame.len())]);
        input.resize(CONTEXT + FRAME, 0.0);
        self.context.copy_from_slice(&input[input.len() - CONTEXT..]);
        let rate = if self.scalar_rate { Tensor::from_array(((), vec![16_000i64])) } else { Tensor::from_array(([1usize], vec![16_000i64])) }.map_err(fail)?;
        let outputs = self
            .session
            .run(ort::inputs![
                "input" => Tensor::from_array(([1usize, CONTEXT + FRAME], input)).map_err(fail)?,
                "state" => Tensor::from_array(([2usize, 1, 128], self.state.clone())).map_err(fail)?,
                "sr" => rate,
            ])
            .map_err(fail)?;
        let probability = outputs["output"].try_extract_tensor::<f32>().map_err(fail)?.1.first().copied().unwrap_or(0.0);
        self.state = outputs["stateN"].try_extract_tensor::<f32>().map_err(fail)?.1.to_vec();
        Ok(probability)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge {
    Start,
    End,
}

/// Turns probabilities into phrase starts and ends: speech after two likely
/// frames in a row, the end after `end_ms` of quiet.
pub struct Segmenter {
    speaking: bool,
    above: u32,
    below: u32,
    end_frames: u32,
}

impl Segmenter {
    pub fn new(end_ms: u32) -> Self {
        Self { speaking: false, above: 0, below: 0, end_frames: end_ms.div_ceil(FRAME_MS) }
    }

    pub fn speaking(&self) -> bool {
        self.speaking
    }

    pub fn push(&mut self, probability: f32) -> Option<Edge> {
        if self.speaking {
            if probability < 0.35 {
                self.below += 1;
                if self.below >= self.end_frames {
                    self.speaking = false;
                    self.below = 0;
                    return Some(Edge::End);
                }
            } else {
                self.below = 0;
            }
        } else if probability > 0.5 {
            self.above += 1;
            if self.above >= 2 {
                self.speaking = true;
                self.above = 0;
                return Some(Edge::Start);
            }
        } else {
            self.above = 0;
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_phrases() {
        let mut segmenter = Segmenter::new(300);
        let mut edges = Vec::new();
        let probabilities = [0.1, 0.9, 0.2, 0.8, 0.9, 0.7, 0.4, 0.2, 0.2, 0.9]
            .into_iter()
            .chain(std::iter::repeat_n(0.1, 10))
            .chain([0.95, 0.95]);
        for (i, p) in probabilities.enumerate() {
            if let Some(edge) = segmenter.push(p) {
                edges.push((i, edge));
            }
        }
        // One likely frame isn't speech; two are. 300 ms of quiet (10 frames) ends it.
        assert_eq!(edges, vec![(4, Edge::Start), (19, Edge::End), (21, Edge::Start)]);
        assert!(segmenter.speaking());
    }
}
