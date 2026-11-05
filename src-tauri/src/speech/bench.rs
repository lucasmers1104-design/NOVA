//! Measurements of how fast each of NOVA's speech models runs on each way
//! this PC offers (CPU with 1, 2 or all threads, DirectML per adapter), and
//! the choice of where a model runs that follows from them and the
//! performance mode. Measured in a separate process (see `probe`) so a bad
//! graphics driver can't take NOVA down; kept until the hardware, a driver,
//! the runtime or a model changes.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::hardware::Report;
use super::runtime::Device;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// The fastest setup that leaves the PC responsive.
    #[default]
    Auto,
    /// The fastest the PC can do; models stay loaded.
    Max,
    /// As little memory and processor time as possible.
    Low,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackendPref {
    #[default]
    Auto,
    Cpu,
    DirectMl,
}

/// One measured model on one device.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub item: String,
    pub device: Device,
    pub ok: bool,
    pub error: Option<String>,
    /// Opening the model.
    pub load_ms: u64,
    /// The first sentence (new input shapes cost extra, especially on a GPU).
    pub first_ms: u64,
    /// Time per second of audio, warm (0.25 = four times faster than real time).
    pub rtf: f64,
    /// Peak memory of the measuring process.
    pub peak_mb: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cache {
    pub key: String,
    /// Unix ms.
    pub at: i64,
    pub runs: Vec<Run>,
}

impl Cache {
    pub fn load(path: &Path) -> Option<Self> {
        serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
    }

    pub fn save(&self, path: &Path) {
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(path, json);
        }
    }

    fn fastest(&self, item: &str, fits: impl Fn(&Device) -> bool) -> Option<&Run> {
        self.runs.iter().filter(|r| r.ok && r.item == item && r.rtf > 0.0 && fits(&r.device)).min_by(|a, b| a.rtf.total_cmp(&b.rtf))
    }

    /// The fastest CPU setup for `item`.
    pub fn cpu(&self, item: &str) -> Option<&Run> {
        self.fastest(item, |d| !d.is_gpu())
    }

    /// The fastest GPU setup for `item` (on `adapter`, if given).
    pub fn gpu(&self, item: &str, adapter: Option<u32>) -> Option<&Run> {
        self.fastest(item, |d| matches!(d, Device::DirectMl { adapter: a, .. } if adapter.is_none_or(|x| x == *a)))
    }

    /// DirectML ran a model on `adapter` at all.
    pub fn directml_works(&self, adapter: u32) -> bool {
        self.runs.iter().any(|r| r.ok && matches!(r.device, Device::DirectMl { adapter: a, .. } if a == adapter))
    }
}

/// What the cache depends on: change any of it and NOVA measures again.
pub fn key(hardware: &Report, items: &[String]) -> String {
    format!("{}|{}|{}|{}", env!("CARGO_PKG_VERSION"), super::catalog::RUNTIME_FOLDER, hardware.key(), items.join(","))
}

/// How much faster the GPU must be before AUTO uses it (it shares the
/// graphics card with NOVA's windows and the desktop).
pub const GPU_ADVANTAGE: f64 = 0.8;

/// Where `item` runs, and why.
pub fn choose(mode: Mode, backend: BackendPref, adapter: Option<u32>, cache: Option<&Cache>, item: &str, hardware: &Report, directml_blocked: Option<&str>) -> (Device, String) {
    let measured_cpu = cache.and_then(|c| c.cpu(item));
    let threads = match mode {
        Mode::Low => 1,
        Mode::Max => measured_cpu.map(|r| match r.device {
            Device::Cpu { threads } => threads,
            _ => hardware.physical_cores,
        }).unwrap_or(hardware.physical_cores),
        Mode::Auto => hardware.physical_cores.min(4),
    };
    let cpu = Device::Cpu { threads };
    if mode == Mode::Low {
        return (cpu, "Low resource mode: processor only, one thread".into());
    }
    if backend == BackendPref::Cpu {
        return (cpu, "Processor chosen in Settings".into());
    }
    if let Some(why) = directml_blocked {
        return (cpu, format!("DirectML is off: {why}"));
    }
    let gpu = cache.and_then(|c| c.gpu(item, if backend == BackendPref::DirectMl { adapter } else { None }));
    let Some(gpu) = gpu else {
        let why = match cache {
            None => "Not measured yet: processor until then",
            Some(c) if c.runs.iter().any(|r| r.device.is_gpu() && r.item == item) => "DirectML didn't work for this model on this PC",
            Some(_) => "No graphics card that runs this model",
        };
        return (cpu, why.into());
    };
    if backend == BackendPref::DirectMl {
        return (gpu.device.clone(), "Graphics card chosen in Settings".into());
    }
    let Some(cpu_run) = measured_cpu else { return (gpu.device.clone(), "Graphics card (processor not measured)".into()) };
    let limit = if mode == Mode::Max { 1.0 } else { GPU_ADVANTAGE };
    if gpu.rtf <= cpu_run.rtf * limit {
        (gpu.device.clone(), format!("Graphics card is faster ({:.2} vs {:.2} s per second of speech)", gpu.rtf, cpu_run.rtf))
    } else {
        (cpu, format!("Processor is faster here ({:.2} vs {:.2} s per second of speech)", cpu_run.rtf, gpu.rtf))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hardware() -> Report {
        Report {
            cpu: "Intel(R) Core(TM) i3-6006U".into(),
            physical_cores: 2,
            logical_cores: 4,
            avx2: true,
            avx512: false,
            memory_total: 8 << 30,
            memory_available: 3 << 30,
            adapters: Vec::new(),
            cuda: false,
            rocm: false,
            vulkan: true,
        }
    }

    fn run(device: Device, rtf: f64, ok: bool) -> Run {
        Run { item: "thorsten".into(), device, ok, error: None, load_ms: 900, first_ms: 400, rtf, peak_mb: 200 }
    }

    fn gpu() -> Device {
        Device::DirectMl { adapter: 0, name: "GPU".into() }
    }

    #[test]
    fn chooses_by_measurement_not_by_brand() {
        let hw = hardware();
        let slow_gpu = Cache { key: "k".into(), at: 0, runs: vec![run(Device::Cpu { threads: 2 }, 0.25, true), run(gpu(), 0.6, true)] };
        assert_eq!(choose(Mode::Auto, BackendPref::Auto, None, Some(&slow_gpu), "thorsten", &hw, None).0, Device::Cpu { threads: 2 });
        let fast_gpu = Cache { key: "k".into(), at: 0, runs: vec![run(Device::Cpu { threads: 2 }, 0.25, true), run(gpu(), 0.1, true)] };
        assert_eq!(choose(Mode::Auto, BackendPref::Auto, None, Some(&fast_gpu), "thorsten", &hw, None).0, gpu());
        // Only a little faster: AUTO stays on the processor, MAX takes it.
        let close = Cache { key: "k".into(), at: 0, runs: vec![run(Device::Cpu { threads: 2 }, 0.25, true), run(gpu(), 0.22, true)] };
        assert!(!choose(Mode::Auto, BackendPref::Auto, None, Some(&close), "thorsten", &hw, None).0.is_gpu());
        assert!(choose(Mode::Max, BackendPref::Auto, None, Some(&close), "thorsten", &hw, None).0.is_gpu());
        // Low resource and a crashed driver always mean the processor.
        assert_eq!(choose(Mode::Low, BackendPref::DirectMl, Some(0), Some(&fast_gpu), "thorsten", &hw, None).0, Device::Cpu { threads: 1 });
        assert!(!choose(Mode::Auto, BackendPref::DirectMl, Some(0), Some(&fast_gpu), "thorsten", &hw, Some("crashed")).0.is_gpu());
        // Never measured: processor; a failed GPU run never counts.
        assert!(!choose(Mode::Max, BackendPref::DirectMl, None, None, "thorsten", &hw, None).0.is_gpu());
        let broken = Cache { key: "k".into(), at: 0, runs: vec![run(gpu(), 0.01, false)] };
        assert!(!choose(Mode::Max, BackendPref::Auto, None, Some(&broken), "thorsten", &hw, None).0.is_gpu());
        assert!(!broken.directml_works(0) && fast_gpu.directml_works(0));
    }
}
