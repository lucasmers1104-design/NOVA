//! Checks NOVA's own speech engines on real models, outside the app:
//!
//!   cargo run --release --example speech_eval -- inspect <model.onnx>
//!   cargo run --release --example speech_eval -- parity     (in-process Piper vs piper.exe)
//!   cargo run --release --example speech_eval -- bench      (speed per device)
//!   cargo run --release --example speech_eval -- roundtrip  (voice → Parakeet → word error rate)
//!
//! Paths come from the environment: NOVA_RUNTIME (folder with onnxruntime.dll
//! and DirectML.dll), NOVA_VOICE_DIR (NOVA's voice folder with piper\ and
//! thorsten.onnx), NOVA_PHONEMIZE (nova-phonemize.exe), NOVA_PARAKEET
//! (Parakeet + Silero folder), optionally NOVA_VOICE_MODEL/NOVA_VOICE_CONFIG
//! for another Piper voice.

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::time::Instant;

use nova_lib::speech::piper::{Piper, PiperConfig};
use nova_lib::speech::runtime::{self, Device};
use nova_lib::speech::{phonemize, wav};

fn env_path(name: &str) -> PathBuf {
    std::env::var_os(name).map(PathBuf::from).unwrap_or_else(|| panic!("set {name}"))
}

fn corpus() -> Vec<String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("examples").join("data").join("speech_corpus_de.txt");
    std::fs::read_to_string(path).unwrap().lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect()
}

fn voice_paths() -> (PathBuf, PathBuf, PathBuf) {
    let dir = env_path("NOVA_VOICE_DIR");
    let model = std::env::var_os("NOVA_VOICE_MODEL").map(PathBuf::from).unwrap_or_else(|| dir.join("thorsten.onnx"));
    let config = std::env::var_os("NOVA_VOICE_CONFIG").map(PathBuf::from).unwrap_or_else(|| dir.join("thorsten.onnx.json"));
    (dir.join("piper"), model, config)
}

/// piper.exe on every line: (phoneme ids per sentence, WAV per line, seconds per line).
fn piper_exe(lines: &[String], noise_free: bool, scratch: &std::path::Path) -> (Vec<Vec<i64>>, Vec<PathBuf>, Vec<f64>) {
    let (espeak, model, config) = voice_paths();
    let mut command = std::process::Command::new(espeak.join("piper.exe"));
    command.arg("--model").arg(&model).arg("--config").arg(&config).args(["--json-input", "--debug"]).current_dir(&espeak);
    if noise_free {
        command.args(["--noise_scale", "0", "--noise_w", "0", "--sentence_silence", "0"]);
    } else {
        command.args(["--sentence_silence", "0.25"]);
    }
    let mut child = command.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().expect("piper.exe");
    let mut stdin = child.stdin.take().unwrap();
    let stdout = std::io::BufReader::new(child.stdout.take().unwrap());
    let stderr = child.stderr.take().unwrap();
    let ids = std::thread::spawn(move || {
        let mut all = Vec::new();
        for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some(list) = line.split("phoneme id(s): ").nth(1) {
                all.push(list.split(',').filter_map(|v| v.trim().parse::<i64>().ok()).collect::<Vec<_>>());
            }
        }
        all
    });
    let mut files = Vec::new();
    let mut seconds = Vec::new();
    let mut lines_out = stdout.lines();
    for (i, line) in lines.iter().enumerate() {
        let file = scratch.join(format!("exe-{i}.wav"));
        let started = Instant::now();
        writeln!(stdin, "{}", serde_json::json!({ "text": line, "output_file": file })).unwrap();
        stdin.flush().unwrap();
        lines_out.next();
        seconds.push(started.elapsed().as_secs_f64());
        files.push(file);
    }
    drop(stdin);
    let _ = child.wait();
    (ids.join().unwrap(), files, seconds)
}

fn correlation(a: &[f32], b: &[f32]) -> f64 {
    let n = a.len().min(b.len()) as f64;
    let mean = |x: &[f32]| x.iter().map(|&v| v as f64).sum::<f64>() / n;
    let (ma, mb) = (mean(&a[..n as usize]), mean(&b[..n as usize]));
    let (mut cov, mut va, mut vb) = (0.0, 0.0, 0.0);
    for i in 0..n as usize {
        let (x, y) = (a[i] as f64 - ma, b[i] as f64 - mb);
        cov += x * y;
        va += x * x;
        vb += y * y;
    }
    cov / (va.sqrt() * vb.sqrt()).max(1e-12)
}

fn parity() {
    let lines = corpus();
    let scratch = std::env::temp_dir().join("nova-speech-eval");
    std::fs::create_dir_all(&scratch).unwrap();
    let (espeak, model, config_path) = voice_paths();
    let config = PiperConfig::parse(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    // 1. Phoneme ids, sentence by sentence.
    let (exe_ids, _, _) = piper_exe(&lines, true, &scratch);
    let mut ours = Vec::new();
    for line in &lines {
        for sentence in phonemize::sentences(&espeak, &config.espeak_voice, line).unwrap() {
            ours.push(config.phoneme_ids(&sentence));
        }
    }
    let same = ours.iter().zip(&exe_ids).filter(|(a, b)| a == b).count();
    println!("phoneme ids: {same}/{} sentences identical (piper.exe {} sentences)", ours.len(), exe_ids.len());
    for (i, (a, b)) in ours.iter().zip(&exe_ids).enumerate().filter(|(_, (a, b))| a != b).take(5) {
        println!("  differs at sentence {i}:\n    ours {a:?}\n    exe  {b:?}");
    }
    // 2. Audio without noise: same length, same waveform (up to float differences between runtime versions).
    let runtime = runtime::get(&env_path("NOVA_RUNTIME")).unwrap();
    let mut piper = Piper::open(runtime, &model, &config_path, &Device::Cpu { threads: 2 }, None, &espeak).unwrap();
    let (_, files, _) = piper_exe(&lines, true, &scratch);
    let (mut equal_len, mut correlations) = (0, Vec::new());
    for (line, file) in lines.iter().zip(&files) {
        let exe = wav::from_wav(&std::fs::read(file).unwrap()).unwrap();
        let mut samples = Vec::new();
        for sentence in phonemize::sentences(&espeak, &config.espeak_voice, line).unwrap() {
            samples.extend(piper.synthesize_ids(config.phoneme_ids(&sentence), 1.0, Some((0.0, 0.0))).unwrap());
        }
        if samples.len() == exe.samples.len() {
            equal_len += 1;
        }
        correlations.push(correlation(&samples, &exe.samples));
    }
    correlations.sort_by(f64::total_cmp);
    println!(
        "noise-free audio: {equal_len}/{} lines with identical length; correlation min {:.4}, median {:.4}",
        lines.len(),
        correlations[0],
        correlations[correlations.len() / 2]
    );
}

fn bench() {
    let lines = corpus();
    let scratch = std::env::temp_dir().join("nova-speech-eval");
    std::fs::create_dir_all(&scratch).unwrap();
    let (espeak, model, config) = voice_paths();
    // piper.exe: time per line (warm process) over audio seconds.
    let (_, files, seconds) = piper_exe(&lines, false, &scratch);
    let audio: f64 = files.iter().map(|f| wav::from_wav(&std::fs::read(f).unwrap()).unwrap().seconds()).sum();
    let first = seconds[0];
    println!("piper.exe        first {:>5.0} ms  RTF {:.3}", first * 1000.0, seconds[1..].iter().sum::<f64>() / (audio - wav::from_wav(&std::fs::read(&files[0]).unwrap()).unwrap().seconds()));
    let runtime = runtime::get(&env_path("NOVA_RUNTIME")).unwrap();
    let mut devices = vec![Device::Cpu { threads: 1 }, Device::Cpu { threads: 2 }, Device::Cpu { threads: 4 }];
    devices.push(Device::DirectMl { adapter: 0, name: "adapter 0".into() });
    for device in devices {
        let opened = Instant::now();
        let mut piper = match Piper::open(runtime, &model, &config, &device, None, &espeak) {
            Ok(p) => p,
            Err(e) => {
                println!("{:<16} failed: {e}", device.label());
                continue;
            }
        };
        let load = opened.elapsed().as_millis();
        let first = Instant::now();
        piper.synthesize(&lines[0], 1.0).unwrap();
        let first = first.elapsed().as_millis();
        let (mut spent, mut audio) = (0.0, 0.0);
        for line in &lines[1..] {
            let started = Instant::now();
            let pcm = piper.synthesize(line, 1.0).unwrap();
            spent += started.elapsed().as_secs_f64();
            audio += pcm.seconds();
        }
        println!("{:<16} load {load:>5} ms  first {first:>5} ms  RTF {:.3}", device.label(), spent / audio);
    }
}

/// Lowercase words without punctuation, for the word error rate.
fn words(text: &str) -> Vec<String> {
    text.to_lowercase().split(|c: char| !c.is_alphanumeric() && c != '\'').filter(|w| !w.is_empty()).map(str::to_string).collect()
}

fn word_errors(reference: &[String], hypothesis: &[String]) -> usize {
    let mut row: Vec<usize> = (0..=hypothesis.len()).collect();
    for (i, r) in reference.iter().enumerate() {
        let mut previous = row[0];
        row[0] = i + 1;
        for (j, h) in hypothesis.iter().enumerate() {
            let substitution = previous + usize::from(r != h);
            previous = row[j + 1];
            row[j + 1] = substitution.min(row[j] + 1).min(row[j + 1] + 1);
        }
    }
    row[hypothesis.len()]
}

fn roundtrip() {
    let lines = corpus();
    let (espeak, model, config) = voice_paths();
    let runtime = runtime::get(&env_path("NOVA_RUNTIME")).unwrap();
    // NOVA_KOKORO_DIR (model.onnx + voice.npy) checks the Kokoro voice instead of Piper.
    let mut voice: Box<dyn nova_lib::speech::TtsEngine> = match std::env::var_os("NOVA_KOKORO_DIR").map(PathBuf::from) {
        Some(dir) => Box::new(nova_lib::speech::kokoro::Kokoro::open(runtime, &dir.join("model.onnx"), &dir.join("voice.npy"), &Device::Cpu { threads: 2 }, &espeak).unwrap()),
        None => Box::new(Piper::open(runtime, &model, &config, &Device::Cpu { threads: 2 }, None, &espeak).unwrap()),
    };
    let parakeet_dir = env_path("NOVA_PARAKEET");
    let opened = Instant::now();
    let mut asr = nova_lib::speech::stt::parakeet::Parakeet::open(runtime, &parakeet_dir, &Device::Cpu { threads: 2 }).unwrap();
    println!("Parakeet loaded in {} ms", opened.elapsed().as_millis());
    let (mut errors, mut total, mut decode, mut audio) = (0, 0, 0.0, 0.0);
    for line in &lines {
        let pcm = voice.synthesize(line, 1.0).unwrap();
        let samples = wav::resample(&pcm.samples, pcm.rate, 16_000);
        let started = Instant::now();
        let text = asr.transcribe(&samples).unwrap();
        decode += started.elapsed().as_secs_f64();
        audio += samples.len() as f64 / 16_000.0;
        let (reference, hypothesis) = (words(line), words(&text));
        let e = word_errors(&reference, &hypothesis);
        if e > 0 {
            println!("  {e} error(s): “{line}” → “{text}”");
        }
        errors += e;
        total += reference.len();
    }
    println!("word error rate {:.1} % ({errors}/{total}); Parakeet RTF {:.3}", 100.0 * errors as f64 / total as f64, decode / audio);
}

fn inspect(model: &str) {
    let runtime = runtime::get(&env_path("NOVA_RUNTIME")).unwrap();
    println!("{}", runtime.info);
    println!("DirectML loaded from {:?}", runtime.directml);
    let session = runtime::session(runtime, std::path::Path::new(model), &Device::Cpu { threads: 1 }).unwrap();
    for input in session.inputs() {
        println!("input  {} {:?}", input.name(), input.dtype());
    }
    for output in session.outputs() {
        println!("output {} {:?}", output.name(), output.dtype());
    }
}

/// How long opening a model takes, cold and from the optimized-graph cache.
fn load(model: &str) {
    let runtime = runtime::get(&env_path("NOVA_RUNTIME")).unwrap();
    let model = std::path::Path::new(model);
    for round in 0..3 {
        let started = Instant::now();
        let session = runtime::session(runtime, model, &Device::Cpu { threads: 2 }).unwrap();
        let plain = started.elapsed().as_millis();
        drop(session);
        let started = Instant::now();
        let session = runtime::session_cached(runtime, model, &Device::Cpu { threads: 2 }).unwrap();
        println!("round {round}: plain {plain} ms, cached {} ms", started.elapsed().as_millis());
        drop(session);
    }
    use ort::session::builder::GraphOptimizationLevel as Level;
    for (name, level, prepack) in [("disable", Level::Disable, true), ("disable, no prepacking", Level::Disable, false), ("all, no prepacking", Level::All, false)] {
        let started = Instant::now();
        let mut builder = ort::session::Session::builder(&runtime.env).unwrap().with_optimization_level(level).unwrap().with_intra_threads(2).unwrap();
        if !prepack {
            builder = builder.with_config_entry("session.disable_prepacking", "1").unwrap();
        }
        let session = builder.commit_from_file(model).unwrap();
        println!("{name}: {} ms", started.elapsed().as_millis());
        drop(session);
    }
    let started = Instant::now();
    let bytes = std::fs::read(model).unwrap();
    let read = started.elapsed().as_millis();
    let session = ort::session::Session::builder(&runtime.env).unwrap().with_optimization_level(Level::Disable).unwrap().commit_from_memory(&bytes).unwrap();
    println!("from memory: read {read} ms, total {} ms", started.elapsed().as_millis());
    drop(session);
    let started = Instant::now();
    let session = ort::session::Session::builder(&runtime.env).unwrap().commit_from_file(model).unwrap();
    println!("defaults: {} ms", started.elapsed().as_millis());
    drop(session);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("load") => load(args.get(1).expect("model path")),
        Some("inspect") => inspect(args.get(1).expect("model path")),
        Some("parity") => parity(),
        Some("bench") => bench(),
        Some("roundtrip") => roundtrip(),
        _ => eprintln!("usage: speech_eval inspect <model> | parity | bench | roundtrip"),
    }
}
