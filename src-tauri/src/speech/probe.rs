//! Measuring NOVA's speech models in a separate process: `nova.exe
//! --speech-probe <task>` opens one model on one device, times it and prints
//! the result. A graphics driver that crashes or hangs takes only that
//! process down; NOVA then simply never uses DirectML for that model there.

use std::io::Read;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use super::bench::{Cache, Run};
use super::catalog::Engine;
use super::runtime::Device;

/// One measurement, as the probe process gets it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub item: String,
    pub engine: Engine,
    pub runtime: PathBuf,
    pub model: PathBuf,
    pub config: PathBuf,
    pub espeak: Option<PathBuf>,
    pub speaker: Option<String>,
    pub device: Device,
    /// A voice to make test speech with (for the recognizer).
    pub voice: Option<(PathBuf, PathBuf)>,
}

/// Sentences of different lengths: new lengths cost extra on a GPU.
const SENTENCES: [&str; 3] = [
    "Alles klar, ich schaue mir das gleich an.",
    "Ich habe drei Dateien gefunden, die zu deiner Suche passen, die neueste ist von gestern Abend.",
    "Dein Rechner ist gerade gut ausgelastet, am meisten braucht der Browser mit vielen offenen Tabs, danach kommt ein Windows-Update, das im Hintergrund installiert wird.",
];
const PROBE_LIMIT: Duration = Duration::from_secs(120);

fn peak_mb() -> u64 {
    #[cfg(windows)]
    {
        use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
        use windows::Win32::System::Threading::GetCurrentProcess;
        let mut counters = PROCESS_MEMORY_COUNTERS { cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32, ..Default::default() };
        // SAFETY: a correctly sized struct for the current process.
        if unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) }.is_ok() {
            return counters.PeakWorkingSetSize as u64 >> 20;
        }
    }
    0
}

fn measure(task: &Task) -> Result<(u64, u64, f64), String> {
    let runtime = super::runtime::get(&task.runtime)?;
    match task.engine {
        Engine::Piper | Engine::Kokoro => {
            let espeak = task.espeak.as_deref().ok_or("eSpeak NG is missing")?;
            let opened = Instant::now();
            let mut engine: Box<dyn super::TtsEngine> = if task.engine == Engine::Piper {
                Box::new(super::piper::Piper::open(runtime, &task.model, &task.config, &task.device, task.speaker.as_deref(), espeak)?)
            } else {
                Box::new(super::kokoro::Kokoro::open(runtime, &task.model, &task.config, &task.device, espeak)?)
            };
            let load = opened.elapsed().as_millis() as u64;
            let first = Instant::now();
            engine.synthesize("Guten Morgen, schön dich zu hören.", 1.0)?;
            let first = first.elapsed().as_millis() as u64;
            let (mut spent, mut audio) = (0.0, 0.0);
            for sentence in SENTENCES {
                let started = Instant::now();
                let pcm = engine.synthesize(sentence, 1.0)?;
                spent += started.elapsed().as_secs_f64();
                audio += pcm.seconds();
            }
            Ok((load, first, spent / audio.max(0.001)))
        }
        Engine::Parakeet => {
            // Test speech from a voice on the processor, then the recognizer on the device.
            let (model, config) = task.voice.as_ref().ok_or("No voice to make test speech with")?;
            let espeak = task.espeak.as_deref().ok_or("eSpeak NG is missing")?;
            let mut voice = super::piper::Piper::open(runtime, model, config, &Device::Cpu { threads: 2 }, None, espeak)?;
            let speech = voice.synthesize(SENTENCES[1], 1.0)?;
            let audio = super::wav::resample(&speech.samples, speech.rate, 16_000);
            drop(voice);
            let opened = Instant::now();
            let mut asr = super::stt::parakeet::Parakeet::open(runtime, &task.model, &task.device)?;
            let load = opened.elapsed().as_millis() as u64;
            let first = Instant::now();
            asr.transcribe(&audio)?;
            let first = first.elapsed().as_millis() as u64;
            let warm = Instant::now();
            asr.transcribe(&audio)?;
            Ok((load, first, warm.elapsed().as_secs_f64() / (audio.len() as f64 / 16_000.0)))
        }
        Engine::Onnx => Err("Nothing to measure".into()),
    }
}

/// The probe process: runs one task and prints the result. Never shows a crash dialog.
pub fn run(request: &str) -> i32 {
    #[cfg(windows)]
    {
        use windows::Win32::System::Diagnostics::Debug::{SetErrorMode, SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX};
        // SAFETY: changes how this process reports errors, nothing else.
        unsafe { SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX) };
    }
    let task: Task = match serde_json::from_str(request) {
        Ok(task) => task,
        Err(e) => {
            println!("{}", serde_json::json!({ "error": e.to_string() }));
            return 2;
        }
    };
    let result = measure(&task);
    let run = match result {
        Ok((load_ms, first_ms, rtf)) => Run { item: task.item.clone(), device: task.device.clone(), ok: true, error: None, load_ms, first_ms, rtf, peak_mb: peak_mb() },
        Err(error) => Run { item: task.item.clone(), device: task.device.clone(), ok: false, error: Some(error), load_ms: 0, first_ms: 0, rtf: 0.0, peak_mb: peak_mb() },
    };
    println!("{}", serde_json::to_string(&run).unwrap_or_default());
    super::phonemize::stop();
    0
}

/// Runs one task in a probe process (below normal priority, no window).
pub fn spawn(task: &Task) -> Run {
    let failed = |error: String| Run { item: task.item.clone(), device: task.device.clone(), ok: false, error: Some(error), load_ms: 0, first_ms: 0, rtf: 0.0, peak_mb: 0 };
    let Ok(exe) = std::env::current_exe() else { return failed("NOVA can't find itself".into()) };
    let Ok(json) = serde_json::to_string(task) else { return failed("Bad task".into()) };
    let mut command = std::process::Command::new(exe);
    command.arg("--speech-probe").arg(json).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS
        command.creation_flags(0x0800_0000 | 0x0000_4000);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => return failed(format!("The measurement couldn't start: {e}")),
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut output = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    let _ = stdout.read_to_string(&mut output);
                }
                return output
                    .lines()
                    .rev()
                    .find_map(|line| serde_json::from_str::<Run>(line).ok())
                    .unwrap_or_else(|| failed(format!("The measurement stopped unexpectedly ({status})")));
            }
            Ok(None) if started.elapsed() > PROBE_LIMIT => {
                let _ = child.kill();
                let _ = child.wait();
                return failed("The measurement hung and was stopped".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return failed(e.to_string()),
        }
    }
}

/// Measures every installed model on the processor and on each graphics
/// adapter. `progress` gets {item, device, done, total}.
pub fn benchmark<R: Runtime>(app: &AppHandle<R>, progress: &dyn Fn(serde_json::Value)) -> Option<Cache> {
    let runtime = super::runtime_dir_for(app)?;
    let hardware = super::hardware(app).clone();
    let espeak = crate::tts::bundle_dir(app);
    let voice = crate::tts::bundled_voice(app).map(|v| (v.model, v.config));
    let mut devices = vec![Device::Cpu { threads: 1 }, Device::Cpu { threads: hardware.physical_cores }];
    if hardware.logical_cores > hardware.physical_cores {
        devices.push(Device::Cpu { threads: hardware.logical_cores });
    }
    devices.extend(hardware.adapters.iter().map(|a| Device::DirectMl { adapter: a.index, name: a.name.clone() }));
    let mut tasks = Vec::new();
    for target in super::bench_targets(app) {
        for device in &devices {
            // The recognizer is measured with the threads AUTO would use and on GPUs only.
            if target.item.engine == Engine::Parakeet && matches!(device, Device::Cpu { threads } if *threads != hardware.physical_cores) {
                continue;
            }
            tasks.push(Task {
                item: target.item.id.to_string(),
                engine: target.item.engine,
                runtime: runtime.clone(),
                model: target.model.clone(),
                config: target.config.clone(),
                espeak: espeak.clone(),
                speaker: target.item.speaker.map(str::to_string),
                device: device.clone(),
                voice: voice.clone(),
            });
        }
    }
    let total = tasks.len();
    let mut runs = Vec::with_capacity(total);
    for (done, task) in tasks.iter().enumerate() {
        progress(serde_json::json!({ "item": task.item, "device": task.device.label(), "done": done, "total": total }));
        runs.push(spawn(task));
    }
    progress(serde_json::json!({ "done": total, "total": total }));
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    Some(Cache { key: super::bench_key_for(app), at, runs })
}
