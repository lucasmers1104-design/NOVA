//! Audio as NOVA's speech code passes it around: mono float samples, WAV
//! bytes for the panel, and resampling (voices speak at 16 or 22.05 kHz,
//! speech recognition listens at 16 kHz).

/// Mono audio, samples in -1..1.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Pcm {
    pub rate: u32,
    pub samples: Vec<f32>,
}

impl Pcm {
    pub fn seconds(&self) -> f64 {
        if self.rate == 0 {
            0.0
        } else {
            self.samples.len() as f64 / self.rate as f64
        }
    }
}

/// 16-bit mono WAV.
pub fn to_wav(pcm: &Pcm) -> Vec<u8> {
    let data_len = (pcm.samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&pcm.rate.to_le_bytes());
    out.extend_from_slice(&(pcm.rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in &pcm.samples {
        out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes());
    }
    out
}

/// Reads a 16-bit PCM WAV (channels are mixed down).
pub fn from_wav(bytes: &[u8]) -> Option<Pcm> {
    if bytes.get(0..4)? != b"RIFF" || bytes.get(8..12)? != b"WAVE" {
        return None;
    }
    let mut at = 12;
    let (mut channels, mut rate, mut bits) = (0u16, 0u32, 0u16);
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let len = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().ok()?) as usize;
        let body = bytes.get(at + 8..(at + 8 + len).min(bytes.len()))?;
        if id == b"fmt " {
            channels = u16::from_le_bytes(body.get(2..4)?.try_into().ok()?);
            rate = u32::from_le_bytes(body.get(4..8)?.try_into().ok()?);
            bits = u16::from_le_bytes(body.get(14..16)?.try_into().ok()?);
        } else if id == b"data" {
            if bits != 16 || channels == 0 {
                return None;
            }
            let frames = body.chunks_exact(2 * channels as usize);
            let samples = frames
                .map(|frame| frame.as_chunks::<2>().0.iter().map(|s| i16::from_le_bytes(*s) as f32 / 32768.0).sum::<f32>() / channels as f32)
                .collect();
            return Some(Pcm { rate, samples });
        }
        at += 8 + len + (len & 1);
    }
    None
}

/// Changes the sample rate: a windowed-sinc low-pass when going down (no
/// aliasing), then linear interpolation. Good enough for speech.
pub fn resample(samples: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || samples.is_empty() || from == 0 || to == 0 {
        return samples.to_vec();
    }
    let filtered;
    let source = if to < from {
        let cutoff = 0.5 * to as f32 / from as f32 * 0.9;
        const TAPS: usize = 31;
        let half = (TAPS / 2) as isize;
        let kernel: Vec<f32> = (0..TAPS as isize)
            .map(|i| {
                let n = (i - half) as f32;
                let sinc = if n == 0.0 { 2.0 * cutoff } else { (2.0 * std::f32::consts::PI * cutoff * n).sin() / (std::f32::consts::PI * n) };
                let window = 0.54 - 0.46 * (2.0 * std::f32::consts::PI * i as f32 / (TAPS - 1) as f32).cos();
                sinc * window
            })
            .collect();
        let sum: f32 = kernel.iter().sum();
        filtered = (0..samples.len() as isize)
            .map(|i| kernel.iter().enumerate().map(|(k, w)| w * samples.get((i + k as isize - half).max(0) as usize).copied().unwrap_or(0.0)).sum::<f32>() / sum)
            .collect::<Vec<f32>>();
        &filtered
    } else {
        samples
    };
    let ratio = from as f64 / to as f64;
    let len = (source.len() as f64 / ratio).floor() as usize;
    (0..len)
        .map(|i| {
            let pos = i as f64 * ratio;
            let j = pos.floor() as usize;
            let frac = (pos - j as f64) as f32;
            let a = source[j];
            let b = source.get(j + 1).copied().unwrap_or(a);
            a + (b - a) * frac
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_round_trip() {
        let pcm = Pcm { rate: 22050, samples: vec![0.0, 0.5, -0.5, 1.0, -1.0] };
        let back = from_wav(&to_wav(&pcm)).unwrap();
        assert_eq!(back.rate, 22050);
        for (a, b) in pcm.samples.iter().zip(&back.samples) {
            assert!((a - b).abs() < 1e-3);
        }
        assert!((pcm.seconds() - 5.0 / 22050.0).abs() < 1e-9);
    }

    #[test]
    fn resampling_keeps_length_and_tone() {
        let tone: Vec<f32> = (0..22050).map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 22050.0).sin()).collect();
        let out = resample(&tone, 22050, 16000);
        assert_eq!(out.len(), 16000);
        // Still a 440 Hz tone: about 880 zero crossings per second.
        let crossings = out.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count();
        assert!((870..=890).contains(&crossings), "{crossings}");
    }
}
