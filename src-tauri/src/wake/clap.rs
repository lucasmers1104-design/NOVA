//! Double-clap detection on raw microphone samples.
//!
//! A clap is a sudden, loud, broadband burst: it rises within a couple of
//! milliseconds, carries little energy below 300 Hz, and dies away within
//! about a tenth of a second. A double clap is two of them 0.17–0.65 s apart,
//! about equally loud, with quiet before, between and after. Speech, music,
//! typing, knocks, single claps and applause don't fit that pattern.
//!
//! Pure signal processing (no Windows APIs), so it can be tested with
//! synthetic and recorded audio. The caller adds what only the live system
//! knows (keyboard and mouse activity, sound coming from the speakers).

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

/// How sure the detector must be before it reports a double clap.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Sensitivity {
    /// Only crisp, clearly separated claps in an otherwise quiet moment.
    #[default]
    Strict,
    /// Any two sudden sounds with quiet around them, however they sound.
    Normal,
}

#[derive(Debug, Clone, Copy)]
struct Params {
    /// Clap peak over the background noise.
    above_floor_db: f32,
    /// Clap peak in absolute terms (full scale = 1.0).
    min_peak: f32,
    /// Clap peak over everything in the 30 ms before it.
    rise_db: f32,
    /// Drop from the peak by 35–55 ms after the start.
    decay_mid_db: f32,
    /// Drop from the peak by 90–120 ms after the start (or down to the noise).
    decay_end_db: f32,
    /// Most energy below 300 Hz a clap may have (knocks, thumps, voices have more).
    max_low_share: f32,
    /// Least energy above 2 kHz a clap must have, relative to everything above 300 Hz.
    min_high_share: f32,
    /// Share of the first 60 ms of energy that falls into the first 15 ms.
    min_focus: f32,
    /// Milliseconds within 10 dB of the peak: clicks are shorter than claps.
    min_width_ms: u64,
    /// Spectral flatness of the burst: claps are noise-like, beeps and clinks ring.
    min_flatness: f32,
    /// Time from the first clap to the second.
    gap_ms: (u64, u64),
    /// Largest loudness difference between the two claps.
    level_match_db: f32,
    /// Quiet before the first clap.
    quiet_before_ms: u64,
    /// Quiet after the second clap's tail; also the confirmation delay.
    quiet_after_ms: u64,
}

impl Sensitivity {
    fn params(self) -> Params {
        match self {
            Sensitivity::Strict => Params {
                above_floor_db: 24.0,
                min_peak: 0.01,
                rise_db: 18.0,
                decay_mid_db: 10.0,
                decay_end_db: 18.0,
                max_low_share: 0.35,
                min_high_share: 0.12,
                min_focus: 0.55,
                min_width_ms: 3,
                min_flatness: 0.07,
                gap_ms: (170, 650),
                level_match_db: 9.0,
                quiet_before_ms: 400,
                quiet_after_ms: 350,
            },
            // Mostly the pattern: two sudden sounds with quiet around them. Measured on a
            // cheap microphone at full level, a clap's spectrum and decay say little: it
            // clips, booms and pumps, and two claps differ by 20 dB. Keys are ruled out
            // live, around the detector; only a low thud stays excluded here.
            Sensitivity::Normal => Params {
                above_floor_db: 20.0,
                min_peak: 0.02,
                rise_db: 8.0,
                decay_mid_db: 3.0,
                decay_end_db: 6.0,
                max_low_share: 0.97,
                min_high_share: 0.0,
                min_focus: 0.3,
                min_width_ms: 2,
                min_flatness: 0.0,
                gap_ms: (120, 900),
                level_match_db: 24.0,
                quiet_before_ms: 300,
                quiet_after_ms: 300,
            },
        }
    }
}

/// Why a sharp sound wasn't taken for a clap.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NotAClap {
    /// It grew out of other sound instead of starting from quiet.
    NoSuddenStart,
    /// It kept going (a voice, a note, a rattle).
    TooLong,
    /// A click (a key, a mouse button, a pen): over almost at once.
    TooShort,
    /// Mostly low frequencies: a knock, a thump, a bump against the desk.
    TooDull,
    /// No high frequencies: muffled or far away.
    TooMuffled,
    /// It rang like a bell, a glass or a beep instead of sounding like noise.
    Tonal,
}

/// Why two claps didn't count as a double clap.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NotADouble {
    /// One clap was much louder than the other.
    Uneven,
    /// Other sound right before, between or after them (talking, music, more claps).
    NotQuiet,
}

/// What the detector measured on a sharp sound.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Features {
    /// Peak over the 30 ms before it (dB).
    pub rise_db: f32,
    /// Milliseconds within 10 dB of the peak.
    pub width_ms: u64,
    /// Energy below 300 Hz, relative to all.
    pub low_share: f32,
    /// Energy above 2 kHz, relative to everything above 300 Hz.
    pub high_share: f32,
    /// Share of the first 60 ms of energy in the first 15 ms.
    pub focus: f32,
    /// Spectral flatness 300 Hz–8 kHz (1 = white noise, near 0 = a pure tone).
    pub flatness: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Event {
    /// A sharp sound that sounded like a clap. `level_db` is its peak (dBFS).
    Clap { at_ms: u64, level_db: f32, features: Features },
    /// A sharp sound that didn't.
    NotAClap { at_ms: u64, level_db: f32, reason: NotAClap, features: Features },
    /// Two claps that didn't make a double clap.
    NotADouble { first_ms: u64, second_ms: u64, reason: NotADouble },
    /// A double clap, reported once the quiet after it has confirmed it.
    Double { first_ms: u64, second_ms: u64 },
}

/// One millisecond of filtered audio.
#[derive(Debug, Clone, Copy, Default)]
struct Bin {
    /// Peak of the signal above 300 Hz.
    peak: f32,
    /// Energy above 300 Hz.
    band: f32,
    /// Energy below 300 Hz.
    low: f32,
    /// Energy above 2 kHz.
    high: f32,
}

/// Second-order IIR filter (RBJ cookbook), transposed direct form II.
#[derive(Debug, Clone, Copy)]
struct Biquad {
    b: [f32; 3],
    a: [f32; 2],
    z: [f32; 2],
}

impl Biquad {
    fn new(rate: u32, cutoff: f32, high_pass: bool) -> Self {
        let w = std::f32::consts::TAU * cutoff / rate as f32;
        let (sin, cos) = w.sin_cos();
        let alpha = sin / (2.0 * std::f32::consts::FRAC_1_SQRT_2);
        let a0 = 1.0 + alpha;
        let b = if high_pass { [(1.0 + cos) / 2.0, -(1.0 + cos), (1.0 + cos) / 2.0] } else { [(1.0 - cos) / 2.0, 1.0 - cos, (1.0 - cos) / 2.0] };
        Self { b: b.map(|v| v / a0), a: [-2.0 * cos / a0, (1.0 - alpha) / a0], z: [0.0; 2] }
    }

    fn run(&mut self, x: f32) -> f32 {
        let y = self.b[0] * x + self.z[0];
        self.z[0] = self.b[1] * x - self.a[0] * y + self.z[1];
        self.z[1] = self.b[2] * x - self.a[1] * y;
        y
    }
}

/// History kept for the quiet checks (about 4 s).
const HISTORY_BINS: usize = 4096;
/// The analysis of a sharp sound needs this much of what follows it.
const WINDOW_BINS: u64 = 120;
/// Noise floor: a percentile of 10 ms block peaks over the last 2 s.
const FLOOR_BLOCK: usize = 10;
const FLOOR_BLOCKS: usize = 200;
const FLOOR_PERCENTILE: f32 = 0.3;
/// Nothing is detected until the noise floor is known.
const WARMUP_BINS: u64 = 1500;
/// After a double clap, sounds are ignored for this long.
const COOLDOWN_BINS: u64 = 2000;
/// A sharp sound starts with at least this jump over the 30 ms before it.
const ONSET_JUMP_DB: f32 = 10.0;

fn gain(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

fn to_db(value: f32) -> f32 {
    20.0 * value.max(1e-9).log10()
}

#[derive(Debug, Clone, Copy)]
struct Clap {
    at: u64,
    peak: f32,
    /// Nothing loud in the time before it (only matters for the first clap of a pair).
    quiet_before: bool,
}

/// Streaming double-clap detector. Feed it mono samples with `push`, then
/// collect what it noticed with `drain`.
pub struct ClapDetector {
    params: Params,
    rate: u32,
    bin_len: usize,
    band: Biquad,
    low: Biquad,
    high: Biquad,
    current: Bin,
    filled: usize,
    bins: Vec<Bin>,
    /// Completed bins so far; the next bin's index.
    count: u64,
    block_peak: f32,
    blocks: VecDeque<f32>,
    scratch: Vec<f32>,
    floor: f32,
    /// A sharp sound waiting for the rest of its window.
    pending: Option<u64>,
    /// An accepted clap waiting for a partner.
    first: Option<Clap>,
    /// Two claps waiting for the quiet after them.
    pair: Option<(Clap, Clap)>,
    blocked_until: u64,
    events: Vec<Event>,
    /// The last quarter second of the filtered signal, for the spectrum of a burst.
    raw: Vec<f32>,
    samples: u64,
}

impl ClapDetector {
    pub fn new(rate: u32, sensitivity: Sensitivity) -> Self {
        let rate = rate.clamp(8_000, 384_000);
        Self {
            params: sensitivity.params(),
            rate,
            bin_len: (rate as usize / 1000).max(1),
            band: Biquad::new(rate, 300.0, true),
            low: Biquad::new(rate, 300.0, false),
            high: Biquad::new(rate, 2000.0, true),
            current: Bin::default(),
            filled: 0,
            bins: vec![Bin::default(); HISTORY_BINS],
            count: 0,
            block_peak: 0.0,
            blocks: VecDeque::with_capacity(FLOOR_BLOCKS),
            scratch: Vec::with_capacity(FLOOR_BLOCKS),
            floor: 1.0,
            pending: None,
            first: None,
            pair: None,
            blocked_until: 0,
            events: Vec::new(),
            raw: vec![0.0; rate as usize / 4],
            samples: 0,
        }
    }

    pub fn set_sensitivity(&mut self, sensitivity: Sensitivity) {
        self.params = sensitivity.params();
    }

    /// Milliseconds of audio processed so far.
    pub fn elapsed_ms(&self) -> u64 {
        self.ms(self.count)
    }

    /// Background noise level (peak, full scale = 1.0).
    pub fn noise_floor(&self) -> f32 {
        self.floor
    }

    fn ms(&self, bin: u64) -> u64 {
        bin * self.bin_len as u64 * 1000 / self.rate as u64
    }

    /// Processes mono samples (full scale = 1.0).
    pub fn push(&mut self, samples: &[f32]) {
        for &x in samples {
            // Out-of-range input must not wreck the filters.
            let x = if x.is_finite() { x.clamp(-4.0, 4.0) } else { 0.0 };
            let band = self.band.run(x);
            let low = self.low.run(x);
            let high = self.high.run(x);
            let len = self.raw.len() as u64;
            self.raw[(self.samples % len) as usize] = band;
            self.samples += 1;
            let bin = &mut self.current;
            bin.peak = bin.peak.max(band.abs());
            bin.band += band * band;
            bin.low += low * low;
            bin.high += high * high;
            self.filled += 1;
            if self.filled == self.bin_len {
                self.finish_bin();
            }
        }
    }

    /// Everything noticed since the last call, oldest first.
    pub fn drain(&mut self) -> Vec<Event> {
        std::mem::take(&mut self.events)
    }

    fn bin(&self, index: u64) -> Bin {
        self.bins[(index % HISTORY_BINS as u64) as usize]
    }

    /// Loudest peak in `from..to` (bins); 0 for an empty range.
    fn max_peak(&self, from: u64, to: u64) -> f32 {
        let from = from.max(self.count.saturating_sub(HISTORY_BINS as u64));
        (from..to.min(self.count)).map(|i| self.bin(i).peak).fold(0.0, f32::max)
    }

    fn energy(&self, from: u64, to: u64) -> Bin {
        (from..to.min(self.count)).map(|i| self.bin(i)).fold(Bin::default(), |sum, b| Bin {
            peak: sum.peak.max(b.peak),
            band: sum.band + b.band,
            low: sum.low + b.low,
            high: sum.high + b.high,
        })
    }

    fn finish_bin(&mut self) {
        let bin = std::mem::take(&mut self.current);
        self.filled = 0;
        let index = self.count;
        self.bins[(index % HISTORY_BINS as u64) as usize] = bin;
        self.count += 1;
        self.update_floor(bin.peak, index);

        if index >= WARMUP_BINS && index >= self.blocked_until && self.pending.is_none() {
            let threshold = (self.floor * gain(self.params.above_floor_db)).max(self.params.min_peak);
            let before = self.max_peak(index.saturating_sub(30), index.saturating_sub(2));
            if bin.peak >= threshold && bin.peak >= before * gain(ONSET_JUMP_DB) {
                self.pending = Some(index);
            }
        }
        if let Some(onset) = self.pending {
            if index >= onset + WINDOW_BINS {
                self.pending = None;
                self.analyse(onset);
            }
        }
        self.confirm_pair(index);
    }

    fn update_floor(&mut self, peak: f32, index: u64) {
        self.block_peak = self.block_peak.max(peak);
        if !(index + 1).is_multiple_of(FLOOR_BLOCK as u64) {
            return;
        }
        if self.blocks.len() == FLOOR_BLOCKS {
            self.blocks.pop_front();
        }
        self.blocks.push_back(self.block_peak);
        self.block_peak = 0.0;
        self.scratch.clear();
        self.scratch.extend(self.blocks.iter().copied());
        let nth = ((self.scratch.len() - 1) as f32 * FLOOR_PERCENTILE) as usize;
        let (_, value, _) = self.scratch.select_nth_unstable_by(nth, f32::total_cmp);
        self.floor = value.max(1e-6);
    }

    /// Decides whether the sharp sound starting at `onset` was a clap.
    fn analyse(&mut self, onset: u64) {
        let p = &self.params;
        let peak = self.max_peak(onset.saturating_sub(2), onset + 8);
        let before = self.max_peak(onset.saturating_sub(33), onset.saturating_sub(2));
        let mid = self.max_peak(onset + 35, onset + 55);
        let end = self.max_peak(onset + 90, onset + WINDOW_BINS);
        let burst = self.energy(onset.saturating_sub(1), onset + 15);
        let spread = self.energy(onset.saturating_sub(1), onset + 60);
        let low_share = burst.low / (burst.low + burst.band).max(1e-12);
        let high_share = burst.high / burst.band.max(1e-12);
        let focus = burst.band / spread.band.max(1e-12);
        let width = (onset.saturating_sub(2)..onset + 20).filter(|&i| i < self.count && self.bin(i).peak >= peak * gain(-10.0)).count() as u64;
        let flatness = self.flatness(onset.saturating_sub(1) * self.bin_len as u64);
        let features = Features { rise_db: to_db(peak) - to_db(before), width_ms: width, low_share, high_share, focus, flatness };

        let reason = if before * gain(p.rise_db) > peak {
            Some(NotAClap::NoSuddenStart)
        } else if mid > peak * gain(-p.decay_mid_db) || end > (peak * gain(-p.decay_end_db)).max(self.floor * gain(6.0)) || focus < p.min_focus {
            Some(NotAClap::TooLong)
        } else if width < p.min_width_ms {
            Some(NotAClap::TooShort)
        } else if low_share > p.max_low_share {
            Some(NotAClap::TooDull)
        } else if high_share < p.min_high_share {
            Some(NotAClap::TooMuffled)
        } else if flatness < p.min_flatness {
            Some(NotAClap::Tonal)
        } else {
            None
        };
        let at_ms = self.ms(onset);
        let level_db = to_db(peak);
        match reason {
            Some(reason) => self.events.push(Event::NotAClap { at_ms, level_db, reason, features }),
            None => {
                self.events.push(Event::Clap { at_ms, level_db, features });
                let quiet_before = self.max_peak(onset.saturating_sub(p.quiet_before_ms), onset.saturating_sub(2)) * gain(p.rise_db) <= peak;
                self.on_clap(Clap { at: onset, peak, quiet_before });
            }
        }
    }

    /// Spectral flatness (geometric over arithmetic mean of the power
    /// spectrum, 300 Hz–8 kHz) of about 10 ms of signal from `start` (a
    /// sample index). Only runs for sharp sounds, so a plain DFT is plenty.
    fn flatness(&self, start: u64) -> f32 {
        let n = (self.rate as usize / 100).next_power_of_two().min(self.raw.len());
        let len = self.raw.len() as u64;
        if start + (n as u64) > self.samples || self.samples - start > len {
            return 1.0;
        }
        let frame: Vec<f32> = (0..n)
            .map(|i| {
                let hann = 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / n as f32).cos();
                self.raw[((start + i as u64) % len) as usize] * hann
            })
            .collect();
        let bin_hz = self.rate as f32 / n as f32;
        let first = ((300.0 / bin_hz).ceil() as usize).max(1);
        let last = ((8000.0 / bin_hz) as usize).min(n / 2 - 1);
        let (mut log_sum, mut sum, mut bins) = (0.0f64, 0.0f64, 0usize);
        for k in first..=last {
            let (step_sin, step_cos) = (-std::f32::consts::TAU * k as f32 / n as f32).sin_cos();
            let (mut re, mut im, mut c, mut s) = (0.0f32, 0.0f32, 1.0f32, 0.0f32);
            for &x in &frame {
                re += x * c;
                im += x * s;
                (c, s) = (c * step_cos - s * step_sin, c * step_sin + s * step_cos);
            }
            let power = (re * re + im * im) as f64 + 1e-20;
            log_sum += power.ln();
            sum += power;
            bins += 1;
        }
        if bins == 0 || sum <= 0.0 {
            return 1.0;
        }
        ((log_sum / bins as f64).exp() / (sum / bins as f64)) as f32
    }

    fn on_clap(&mut self, clap: Clap) {
        let p = self.params;
        if let Some((first, second)) = self.pair.take() {
            // A third clap: applause or a rhythm, not a double clap.
            self.events.push(Event::NotADouble { first_ms: self.ms(first.at), second_ms: self.ms(second.at), reason: NotADouble::NotQuiet });
            self.first = None;
            return;
        }
        match self.first.take() {
            Some(first) if (p.gap_ms.0..=p.gap_ms.1).contains(&(self.ms(clap.at) - self.ms(first.at))) => self.pair = Some((first, clap)),
            _ => self.first = Some(clap),
        }
    }

    /// Once the quiet after a pair has passed, reports it (or why it doesn't count).
    fn confirm_pair(&mut self, index: u64) {
        let Some((first, second)) = self.pair else { return };
        let p = self.params;
        let tail_end = second.at + WINDOW_BINS;
        if index < tail_end + p.quiet_after_ms {
            return;
        }
        self.pair = None;
        let quiet_between = self.max_peak(first.at + WINDOW_BINS, second.at.saturating_sub(2)) <= first.peak * gain(-p.decay_end_db);
        let quiet_after = self.max_peak(tail_end, tail_end + p.quiet_after_ms) <= second.peak * gain(-p.decay_end_db);
        let even = (to_db(first.peak) - to_db(second.peak)).abs() <= p.level_match_db;
        let (first_ms, second_ms) = (self.ms(first.at), self.ms(second.at));
        if !(first.quiet_before && quiet_between && quiet_after) {
            self.events.push(Event::NotADouble { first_ms, second_ms, reason: NotADouble::NotQuiet });
        } else if !even {
            self.events.push(Event::NotADouble { first_ms, second_ms, reason: NotADouble::Uneven });
        } else {
            self.events.push(Event::Double { first_ms, second_ms });
            self.blocked_until = index + COOLDOWN_BINS;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;

    /// Deterministic noise source.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> f32 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 >> 40) as f32 / (1u64 << 23) as f32 - 1.0
        }
    }

    fn samples(ms: u64) -> usize {
        (ms * RATE as u64 / 1000) as usize
    }

    /// `ms` of white noise at `rms`.
    fn noise(ms: u64, rms: f32, seed: u64) -> Vec<f32> {
        let mut rng = Rng(seed | 1);
        (0..samples(ms)).map(|_| rng.next() * rms * 1.73).collect()
    }

    fn mix(into: &mut Vec<f32>, at_ms: u64, sound: &[f32]) {
        let start = samples(at_ms);
        if into.len() < start + sound.len() {
            into.resize(start + sound.len(), 0.0);
        }
        for (i, s) in sound.iter().enumerate() {
            into[start + i] += s;
        }
    }

    fn normalize(sound: &mut [f32], peak: f32) {
        let max = sound.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        for s in sound {
            *s *= peak / max;
        }
    }

    /// A hand clap: a noise burst centred around 1–3 kHz that rises within a
    /// millisecond and fades in a few, plus a room's reverb about 15 dB down.
    fn clap(peak: f32, seed: u64) -> Vec<f32> {
        let mut rng = Rng(seed | 1);
        let mut low_cut = Biquad::new(RATE, 700.0, true);
        let mut high_cut = Biquad::new(RATE, 5000.0, false);
        let len = samples(250);
        let mut out: Vec<f32> = (0..len)
            .map(|i| {
                let t = i as f32 / RATE as f32 * 1000.0;
                let attack = (t / 0.6).min(1.0);
                let burst = attack * (-t / 5.0).exp();
                let reverb = if t > 2.0 { 0.18 * (-(t - 2.0) / 60.0).exp() } else { 0.0 };
                let raw = rng.next();
                high_cut.run(low_cut.run(raw)) * burst + rng.next() * reverb * 0.5
            })
            .collect();
        normalize(&mut out, peak);
        out
    }

    /// A key press on a laptop: a tiny click and a thump through the chassis,
    /// then a softer release click.
    fn keystroke(peak: f32, seed: u64) -> Vec<f32> {
        let mut rng = Rng(seed | 1);
        let len = samples(200);
        let release = samples(90 + seed % 40);
        let mut out: Vec<f32> = (0..len)
            .map(|i| {
                let t = i as f32 / RATE as f32;
                let click = rng.next() * (-t * 1000.0 / 0.8).exp();
                let thump = (std::f32::consts::TAU * 140.0 * t).sin() * (-t * 1000.0 / 15.0).exp() * 1.4;
                let up = if i >= release { 0.5 * rng.next() * (-((i - release) as f32 / RATE as f32) * 1000.0 / 0.8).exp() } else { 0.0 };
                click + thump + up
            })
            .collect();
        normalize(&mut out, peak);
        out
    }

    /// A knock on the desk: mostly a low, short tone.
    fn knock(peak: f32, seed: u64) -> Vec<f32> {
        let mut rng = Rng(seed | 1);
        let mut out: Vec<f32> = (0..samples(150))
            .map(|i| {
                let t = i as f32 / RATE as f32;
                (std::f32::consts::TAU * 180.0 * t).sin() * (-t * 1000.0 / 25.0).exp() + 0.15 * rng.next() * (-t * 1000.0 / 1.0).exp()
            })
            .collect();
        normalize(&mut out, peak);
        out
    }

    /// A drum machine: kick, snare and hi-hat at `bpm` for `ms`.
    fn beat(ms: u64, bpm: u64, peak: f32) -> Vec<f32> {
        let mut out = vec![0.0; samples(ms)];
        let step = 60_000 / bpm / 2;
        let mut rng = Rng(99);
        for (n, at) in (0..ms.saturating_sub(300)).step_by(step as usize).enumerate() {
            let hit: Vec<f32> = match n % 4 {
                0 => (0..samples(200)).map(|i| {
                    let t = i as f32 / RATE as f32;
                    (std::f32::consts::TAU * 55.0 * t).sin() * (-t * 1000.0 / 80.0).exp()
                }).collect(),
                2 => (0..samples(220)).map(|i| {
                    let t = i as f32 / RATE as f32;
                    0.6 * rng.next() * (-t * 1000.0 / 60.0).exp() + 0.5 * (std::f32::consts::TAU * 190.0 * t).sin() * (-t * 1000.0 / 30.0).exp()
                }).collect(),
                _ => (0..samples(60)).map(|i| {
                    let t = i as f32 / RATE as f32;
                    0.3 * rng.next() * (-t * 1000.0 / 8.0).exp()
                }).collect(),
            };
            mix(&mut out, at, &hit);
        }
        normalize(&mut out, peak);
        out
    }

    /// Talking: voiced syllables (a buzz shaped by formants), plosive bursts
    /// before some of them, hissing consonants and short pauses.
    fn speech(ms: u64, peak: f32, seed: u64) -> Vec<f32> {
        let mut rng = Rng(seed | 1);
        let mut out = vec![0.0; samples(ms)];
        let mut at = 0u64;
        while at + 400 < ms {
            let len = 120 + (rng.next().abs() * 160.0) as u64;
            let f0 = 110.0 + rng.next().abs() * 90.0;
            if rng.next() > 0.0 {
                // Plosive: a short burst, then the voice 20–50 ms later.
                let burst: Vec<f32> = (0..samples(6)).map(|i| 0.5 * rng.next() * (-(i as f32) / samples(2) as f32).exp()).collect();
                mix(&mut out, at, &burst);
                at += 20 + (rng.next().abs() * 30.0) as u64;
            }
            let syllable: Vec<f32> = (0..samples(len))
                .map(|i| {
                    let t = i as f32 / RATE as f32;
                    let env = (t * 1000.0 / 25.0).min(1.0) * ((len as f32 - t * 1000.0) / 40.0).clamp(0.0, 1.0);
                    let voice: f32 = (1..18)
                        .map(|h| {
                            let f = f0 * h as f32;
                            let formant = (-((f - 600.0) / 250.0).powi(2)).exp() + 0.6 * (-((f - 1600.0) / 300.0).powi(2)).exp() + 0.3 * (-((f - 2600.0) / 400.0).powi(2)).exp();
                            formant * (std::f32::consts::TAU * f * t).sin()
                        })
                        .sum();
                    env * voice
                })
                .collect();
            mix(&mut out, at, &syllable);
            at += len;
            if rng.next() > 0.3 {
                let mut hiss = Biquad::new(RATE, 4000.0, true);
                let fricative: Vec<f32> = (0..samples(90)).map(|i| hiss.run(rng.next()) * 0.4 * ((i as f32 / samples(15) as f32).min(1.0))).collect();
                mix(&mut out, at, &fricative);
                at += 90;
            }
            at += 30 + (rng.next().abs() * 250.0) as u64;
        }
        normalize(&mut out, peak);
        out
    }

    /// A quiet room: faint noise, as the detector hears it.
    fn room(ms: u64) -> Vec<f32> {
        noise(ms, 0.0008, 7)
    }

    fn run(audio: &[f32], sensitivity: Sensitivity) -> Vec<Event> {
        let mut detector = ClapDetector::new(RATE, sensitivity);
        let mut events = Vec::new();
        // Feed in chunks of 10 ms, as the microphone delivers them.
        for chunk in audio.chunks(samples(10)) {
            detector.push(chunk);
            events.extend(detector.drain());
        }
        events
    }

    fn doubles(events: &[Event]) -> Vec<(u64, u64)> {
        events.iter().filter_map(|e| if let Event::Double { first_ms, second_ms } = e { Some((*first_ms, *second_ms)) } else { None }).collect()
    }

    fn claps(events: &[Event]) -> usize {
        events.iter().filter(|e| matches!(e, Event::Clap { .. })).count()
    }

    fn double_clap(gap_ms: u64, first: f32, second: f32) -> Vec<f32> {
        let mut audio = room(5000);
        mix(&mut audio, 2500, &clap(first, 11));
        mix(&mut audio, 2500 + gap_ms, &clap(second, 23));
        audio
    }

    #[test]
    fn hears_a_double_clap() {
        for sensitivity in [Sensitivity::Strict, Sensitivity::Normal] {
            let events = run(&double_clap(320, 0.4, 0.35), sensitivity);
            let found = doubles(&events);
            assert_eq!(found.len(), 1, "{sensitivity:?}: {events:?}");
            let (first, second) = found[0];
            assert!(first.abs_diff(2500) <= 2 && second.abs_diff(2820) <= 2, "{found:?}");
        }
    }

    /// A clap on a cheap microphone at full level: clipped, with a boom and a slow tail.
    fn clipped_clap(seed: u64) -> Vec<f32> {
        let mut out = clap(3.0, seed);
        for (i, s) in out.iter_mut().enumerate() {
            let t = i as f32 / RATE as f32;
            *s += 0.6 * (std::f32::consts::TAU * 120.0 * t).sin() * (-t * 1000.0 / 30.0).exp();
            *s = s.clamp(-1.0, 1.0);
        }
        out
    }

    #[test]
    fn more_forgiving_hears_clipped_uneven_claps() {
        let mut audio = room(5000);
        mix(&mut audio, 2500, &clipped_clap(3));
        let mut quiet = clipped_clap(4);
        quiet.iter_mut().for_each(|s| *s *= 0.1);
        mix(&mut audio, 2860, &quiet);
        let events = run(&audio, Sensitivity::Normal);
        assert_eq!(doubles(&events).len(), 1, "{events:?}");
    }

    #[test]
    fn hears_quick_slow_soft_and_loud_double_claps() {
        for (gap, a, b) in [(180, 0.3, 0.3), (250, 0.9, 1.0), (450, 0.2, 0.15), (640, 0.5, 0.5), (300, 0.06, 0.05)] {
            let events = run(&double_clap(gap, a, b), Sensitivity::Strict);
            assert_eq!(doubles(&events).len(), 1, "gap {gap} ms, peaks {a}/{b}: {events:?}");
        }
    }

    #[test]
    fn hears_claps_over_steady_background_noise() {
        // A fan or air conditioning 30 dB below the claps.
        let mut audio = noise(5000, 0.01, 3);
        mix(&mut audio, 2500, &clap(0.5, 5));
        mix(&mut audio, 2830, &clap(0.5, 6));
        assert_eq!(doubles(&run(&audio, Sensitivity::Strict)).len(), 1);
    }

    #[test]
    fn reports_the_double_clap_after_the_quiet_that_confirms_it() {
        let audio = double_clap(300, 0.4, 0.4);
        let mut detector = ClapDetector::new(RATE, Sensitivity::Strict);
        let mut reported_at = None;
        for chunk in audio.chunks(samples(10)) {
            detector.push(chunk);
            if detector.drain().iter().any(|e| matches!(e, Event::Double { .. })) {
                reported_at = Some(detector.elapsed_ms());
            }
        }
        // Second clap at 2800 ms + 120 ms tail + 350 ms quiet.
        let at = reported_at.expect("double clap");
        assert!((3270..=3290).contains(&at), "{at}");
    }

    #[test]
    fn ignores_single_triple_and_repeated_claps() {
        let mut single = room(5000);
        mix(&mut single, 2500, &clap(0.5, 1));
        assert!(doubles(&run(&single, Sensitivity::Normal)).is_empty());

        let mut triple = room(5000);
        for (i, at) in [2500, 2800, 3100].into_iter().enumerate() {
            mix(&mut triple, at, &clap(0.5, i as u64 + 1));
        }
        let events = run(&triple, Sensitivity::Normal);
        assert_eq!(claps(&events), 3, "{events:?}");
        assert!(doubles(&events).is_empty(), "{events:?}");

        // Applause-like rhythm: a clap every 300 ms for 3 s.
        let mut rhythm = room(7000);
        for (i, at) in (2000..5000).step_by(300).enumerate() {
            mix(&mut rhythm, at, &clap(0.4 + (i % 3) as f32 * 0.05, i as u64 + 1));
        }
        assert!(doubles(&run(&rhythm, Sensitivity::Normal)).is_empty());
    }

    #[test]
    fn ignores_claps_too_close_or_too_far_apart() {
        for gap in [90, 120, 700, 1200] {
            let events = run(&double_clap(gap, 0.4, 0.4), Sensitivity::Strict);
            assert!(doubles(&events).is_empty(), "gap {gap}: {events:?}");
        }
    }

    #[test]
    fn ignores_uneven_claps() {
        let events = run(&double_clap(300, 0.6, 0.08), Sensitivity::Strict);
        assert!(doubles(&events).is_empty());
        assert!(events.iter().any(|e| matches!(e, Event::NotADouble { reason: NotADouble::Uneven, .. })), "{events:?}");
    }

    #[test]
    fn ignores_a_double_clap_while_someone_talks() {
        let mut audio = room(8000);
        mix(&mut audio, 1500, &speech(5000, 0.3, 4));
        mix(&mut audio, 3500, &clap(0.5, 8));
        mix(&mut audio, 3800, &clap(0.5, 9));
        let events = run(&audio, Sensitivity::Strict);
        assert!(doubles(&events).is_empty(), "{events:?}");
    }

    #[test]
    fn ignores_talking() {
        for seed in 1..=4 {
            let mut audio = room(2000);
            mix(&mut audio, 1600, &speech(15_000, 0.5, seed));
            for sensitivity in [Sensitivity::Strict, Sensitivity::Normal] {
                let events = run(&audio, sensitivity);
                assert!(doubles(&events).is_empty(), "seed {seed} {sensitivity:?}: {:?}", events.iter().filter(|e| !matches!(e, Event::NotAClap { .. })).collect::<Vec<_>>());
            }
        }
    }

    #[test]
    fn ignores_typing() {
        let mut audio = room(25_000);
        let mut rng = Rng(5);
        let mut at = 1600u64;
        while at < 24_000 {
            mix(&mut audio, at, &keystroke(0.3 + rng.next().abs() * 0.4, at));
            at += 90 + (rng.next().abs() * 400.0) as u64;
            if rng.next() > 0.8 {
                at += 800; // thinking pause
            }
        }
        // In forgiving mode only the live check on keyboard input rules out keys.
        let events = run(&audio, Sensitivity::Strict);
        assert!(doubles(&events).is_empty());
        assert_eq!(claps(&events), 0, "keystrokes taken for claps");
        // Two isolated key presses look most like a double clap.
        let mut pair = room(5000);
        mix(&mut pair, 2500, &keystroke(0.5, 1));
        mix(&mut pair, 2800, &keystroke(0.5, 2));
        assert!(doubles(&run(&pair, Sensitivity::Strict)).is_empty());
    }

    #[test]
    fn ignores_knocks() {
        let mut audio = room(5000);
        mix(&mut audio, 2500, &knock(0.6, 1));
        mix(&mut audio, 2800, &knock(0.6, 2));
        // Strict only: forgiving mode goes by the pattern, so a double knock can wake NOVA.
        let events = run(&audio, Sensitivity::Strict);
        assert!(doubles(&events).is_empty());
        assert!(events.iter().all(|e| !matches!(e, Event::Clap { .. })), "{events:?}");
    }

    #[test]
    fn ignores_music() {
        for bpm in [90, 120, 150, 174] {
            let mut audio = room(2000);
            mix(&mut audio, 1600, &beat(20_000, bpm, 0.6));
            // Strict only: forgiving mode can mistake loud music from loudspeakers for claps.
            let events = run(&audio, Sensitivity::Strict);
            assert!(doubles(&events).is_empty(), "{bpm} bpm");
        }
    }

    #[test]
    fn waits_after_a_double_clap() {
        let mut audio = room(8000);
        for at in [2000, 2300, 3200, 3500] {
            mix(&mut audio, at, &clap(0.4, at));
        }
        // The second pair falls into the cooldown.
        assert_eq!(doubles(&run(&audio, Sensitivity::Strict)).len(), 1);
    }

    #[test]
    fn needs_the_noise_floor_first() {
        let mut audio = room(1400);
        mix(&mut audio, 200, &clap(0.5, 1));
        mix(&mut audio, 500, &clap(0.5, 2));
        assert!(run(&audio, Sensitivity::Normal).is_empty());
    }

    #[test]
    fn works_at_common_sample_rates() {
        for rate in [16_000u32, 44_100, 96_000] {
            // Resample the 48 kHz test audio by nearest neighbour; good enough for timing.
            let audio = double_clap(300, 0.4, 0.4);
            let resampled: Vec<f32> = (0..(audio.len() as u64 * rate as u64 / RATE as u64) as usize).map(|i| audio[(i as u64 * RATE as u64 / rate as u64) as usize]).collect();
            let mut detector = ClapDetector::new(rate, Sensitivity::Normal);
            detector.push(&resampled);
            assert_eq!(doubles(&detector.drain()).len(), 1, "{rate} Hz");
        }
    }

    #[test]
    fn survives_garbage_input() {
        let mut detector = ClapDetector::new(0, Sensitivity::Strict);
        detector.push(&[f32::NAN, f32::INFINITY, 1e30, -1e30, 0.0]);
        let _ = detector.drain();
        assert!(detector.noise_floor().is_finite());
    }
}
