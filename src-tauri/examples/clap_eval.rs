//! Runs the double-clap detector over WAV files and prints what it noticed.
//!
//!     cargo run --example clap_eval -- [--normal] file.wav [more.wav …]
//!
//! Handy for checking recordings of claps (they should be found) and of
//! everything else: speech, music, typing (nothing should be).

use nova_lib::wake::clap::{ClapDetector, Event, Sensitivity};

/// Reads PCM 16/24/32-bit or 32-bit float WAV as mono samples.
fn read_wav(path: &str) -> Result<(u32, Vec<f32>), String> {
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    if data.len() < 12 || &data[0..4] != b"RIFF" || &data[8..12] != b"WAVE" {
        return Err("not a WAV file".into());
    }
    let (mut format, mut channels, mut rate, mut bits) = (0u16, 0u16, 0u32, 0u16);
    let mut pos = 12;
    while pos + 8 <= data.len() {
        let id = &data[pos..pos + 4];
        let size = u32::from_le_bytes(data[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let body = &data[pos + 8..(pos + 8 + size).min(data.len())];
        if id == b"fmt " {
            format = u16::from_le_bytes([body[0], body[1]]);
            channels = u16::from_le_bytes([body[2], body[3]]);
            rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
            bits = u16::from_le_bytes([body[14], body[15]]);
            if format == 0xFFFE && body.len() >= 26 {
                format = u16::from_le_bytes([body[24], body[25]]);
            }
        } else if id == b"data" {
            let width = (bits / 8) as usize;
            let frame = width * channels.max(1) as usize;
            let mut out = Vec::with_capacity(body.len() / frame.max(1));
            for f in body.chunks_exact(frame) {
                let mut sum = 0.0;
                for c in f.chunks_exact(width) {
                    sum += match (format, bits) {
                        (3, 32) => f32::from_le_bytes(c.try_into().unwrap()),
                        (1, 16) => i16::from_le_bytes(c.try_into().unwrap()) as f32 / 32768.0,
                        (1, 24) => (i32::from_le_bytes([0, c[0], c[1], c[2]]) >> 8) as f32 / 8_388_608.0,
                        (1, 32) => i32::from_le_bytes(c.try_into().unwrap()) as f32 / 2_147_483_648.0,
                        (1, 8) => (c[0] as f32 - 128.0) / 128.0,
                        _ => return Err(format!("unsupported format {format}/{bits} bit")),
                    };
                }
                out.push(sum / channels.max(1) as f32);
            }
            return Ok((rate, out));
        }
        pos += 8 + size + (size & 1);
    }
    Err("no audio data".into())
}

fn main() {
    let mut sensitivity = Sensitivity::Strict;
    let verbose = std::env::var_os("CLAP_VERBOSE").is_some();
    let mut total = (0usize, 0usize, 0usize);
    for arg in std::env::args().skip(1) {
        if arg == "--normal" {
            sensitivity = Sensitivity::Normal;
            continue;
        }
        let (rate, audio) = match read_wav(&arg) {
            Ok(wav) => wav,
            Err(error) => {
                println!("{arg}: {error}");
                continue;
            }
        };
        // Two seconds of near-silence first, so the detector knows the noise floor.
        let mut detector = ClapDetector::new(rate, sensitivity);
        let lead = vec![0.0005f32; rate as usize * 2];
        detector.push(&lead);
        let mut claps = 0;
        let mut doubles = 0;
        let mut rejected = 0;
        for chunk in audio.chunks((rate / 100).max(1) as usize) {
            detector.push(chunk);
            for event in detector.drain() {
                match event {
                    Event::Clap { at_ms, level_db, features: f } => {
                        claps += 1;
                        println!("  {:>8} ms  clap ({level_db:.1} dB) rise {:.0} width {} low {:.2} high {:.2} focus {:.2} flat {:.3}", at_ms - 2000, f.rise_db, f.width_ms, f.low_share, f.high_share, f.focus, f.flatness);
                    }
                    Event::Double { first_ms, second_ms } => {
                        doubles += 1;
                        println!("  {:>8} ms  DOUBLE CLAP ({} ms gap)", first_ms - 2000, second_ms - first_ms);
                    }
                    Event::NotADouble { first_ms, reason, .. } => println!("  {:>8} ms  pair ignored: {reason:?}", first_ms - 2000),
                    Event::NotAClap { at_ms, level_db, reason, features: f } => {
                        rejected += 1;
                        if verbose {
                            println!("  {:>8} ms  not a clap: {reason:?} ({level_db:.1} dB) rise {:.0} width {} low {:.2} high {:.2} focus {:.2} flat {:.3}", at_ms.saturating_sub(2000), f.rise_db, f.width_ms, f.low_share, f.high_share, f.focus, f.flatness);
                        }
                    }
                }
            }
        }
        let seconds = audio.len() as f32 / rate as f32;
        println!("{arg}: {seconds:.1} s, {claps} clap(s), {doubles} double clap(s), {rejected} other sharp sounds");
        total = (total.0 + claps, total.1 + doubles, total.2 + rejected);
    }
    println!("TOTAL: {} clap(s), {} double clap(s), {} other sharp sounds", total.0, total.1, total.2);
}
