//! The ONNX Runtime NOVA's own speech runs on: Microsoft's DirectML build,
//! which runs a model on the CPU or on any DirectX 12 graphics card (NVIDIA,
//! AMD or Intel) — one runtime and one copy of every model for all of them.
//!
//! It is downloaded on demand and loaded by absolute path, together with its
//! own DirectML.dll, so neither Windows' older DirectML nor any other
//! onnxruntime.dll on the PC can be picked up instead. Once loaded it stays
//! loaded until NOVA exits.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use ort::environment::Environment;
use ort::ep;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use serde::{Deserialize, Serialize};

use super::catalog;

/// Where a model runs.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Device {
    Cpu { threads: usize },
    DirectMl { adapter: u32, name: String },
}

impl Device {
    pub fn label(&self) -> String {
        match self {
            Device::Cpu { threads: 1 } => "CPU · 1 thread".into(),
            Device::Cpu { threads } => format!("CPU · {threads} threads"),
            Device::DirectMl { name, .. } => format!("DirectML · {name}"),
        }
    }

    pub fn is_gpu(&self) -> bool {
        matches!(self, Device::DirectMl { .. })
    }
}

pub struct Runtime {
    pub env: Environment,
    /// Where DirectML.dll was really loaded from (it must be NOVA's copy).
    pub directml: Option<String>,
    pub info: String,
}

static RUNTIME: OnceLock<Result<Runtime, String>> = OnceLock::new();

pub fn folder(speech_dir: &Path) -> PathBuf {
    speech_dir.join(catalog::RUNTIME_FOLDER)
}

/// The runtime once it has been loaded in this process.
pub fn loaded() -> Option<&'static Runtime> {
    RUNTIME.get().and_then(|r| r.as_ref().ok())
}

/// Why loading failed in this process, if it did.
pub fn load_error() -> Option<String> {
    RUNTIME.get().and_then(|r| r.as_ref().err().cloned())
}

/// Loads the runtime from `dir` (once per process).
pub fn get(dir: &Path) -> Result<&'static Runtime, String> {
    RUNTIME.get_or_init(|| load(dir)).as_ref().map_err(Clone::clone)
}

#[cfg(windows)]
fn wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

/// Loads NOVA's DirectML.dll by its full path before ONNX Runtime asks for it
/// by name, and returns where it came from.
#[cfg(windows)]
fn preload_directml(dir: &Path) -> Option<String> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::System::LibraryLoader::{GetModuleFileNameW, GetModuleHandleW, LoadLibraryExW, LOAD_WITH_ALTERED_SEARCH_PATH};
    let path = wide(&dir.join("DirectML.dll"));
    // SAFETY: a NUL-terminated absolute path; the module stays loaded for the process.
    unsafe {
        let _ = LoadLibraryExW(PCWSTR(path.as_ptr()), None, LOAD_WITH_ALTERED_SEARCH_PATH).ok()?;
        let module = GetModuleHandleW(w!("DirectML.dll")).ok()?;
        let mut buffer = [0u16; 1024];
        let len = GetModuleFileNameW(Some(module), &mut buffer) as usize;
        Some(String::from_utf16_lossy(&buffer[..len]))
    }
}

#[cfg(not(windows))]
fn preload_directml(_dir: &Path) -> Option<String> {
    None
}

fn load(dir: &Path) -> Result<Runtime, String> {
    let dll = dir.join("onnxruntime.dll");
    if !dll.is_file() {
        return Err("The speech runtime isn't downloaded".into());
    }
    let directml = preload_directml(dir);
    if let Some(path) = &directml {
        if !Path::new(path).starts_with(dir) {
            return Err(format!("Windows loaded another DirectML.dll ({path})"));
        }
    }
    let env = ort::init_from(&dll).map_err(|e| format!("The speech runtime couldn't load: {e}"))?.with_name("NOVA").build().map_err(|e| format!("The speech runtime couldn't start: {e}"))?;
    Ok(Runtime { env, directml, info: ort::info().to_string() })
}

/// Opens `model` for `device`. On a GPU, DirectML wants fixed memory plans
/// off and one operation at a time.
pub fn session(runtime: &Runtime, model: &Path, device: &Device) -> Result<Session, String> {
    open(runtime, model, device, GraphOptimizationLevel::All, None)
}

/// Vector instructions the optimized graph was made for.
fn cpu_tag() -> &'static str {
    #[cfg(target_arch = "x86_64")]
    {
        if std::arch::is_x86_feature_detected!("avx512f") {
            return "avx512";
        }
        if std::arch::is_x86_feature_detected!("avx2") {
            return "avx2";
        }
    }
    "base"
}

/// Where the optimized graph of `model` is kept (it fits this runtime and processor only).
pub fn optimized_path(model: &Path) -> PathBuf {
    let stem = model.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    model.with_file_name(format!("{stem}.{}.{}.opt.onnx", catalog::RUNTIME_FOLDER, cpu_tag()))
}

/// Like `session`, but on the processor the optimized graph is kept next to
/// the model: optimizing a voice takes seconds on a small PC, loading the
/// result a fraction of that.
pub fn session_cached(runtime: &Runtime, model: &Path, device: &Device) -> Result<Session, String> {
    if device.is_gpu() {
        return session(runtime, model, device);
    }
    let cache = optimized_path(model);
    if cache.is_file() {
        match open(runtime, &cache, device, GraphOptimizationLevel::Disable, None) {
            Ok(session) => return Ok(session),
            Err(_) => {
                let _ = std::fs::remove_file(&cache);
            }
        }
    }
    let partial = cache.with_extension("part");
    let session = open(runtime, model, device, GraphOptimizationLevel::All, Some(&partial))?;
    if std::fs::rename(&partial, &cache).is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    Ok(session)
}

fn open(runtime: &Runtime, model: &Path, device: &Device, level: GraphOptimizationLevel, save_optimized: Option<&Path>) -> Result<Session, String> {
    let fail = |e: ort::Error<_>| e.to_string();
    let mut builder = Session::builder(&runtime.env)
        .map_err(|e| e.to_string())?
        .with_optimization_level(level)
        .map_err(fail)?
        .with_inter_threads(1)
        .map_err(fail)?
        // Spinning threads would take the CPU from everything else on a small PC.
        .with_intra_op_spinning(false)
        .map_err(fail)?
        .with_inter_op_spinning(false)
        .map_err(fail)?;
    if let Some(path) = save_optimized {
        builder = builder.with_optimized_model_path(path).map_err(fail)?;
    }
    builder = match device {
        Device::Cpu { threads } => builder.with_intra_threads((*threads).max(1)).map_err(fail)?.with_execution_providers([ep::CPU::default().with_arena_allocator(false).build()]).map_err(fail)?,
        Device::DirectMl { adapter, .. } => builder
            .with_intra_threads(1)
            .map_err(fail)?
            .with_memory_pattern(false)
            .map_err(fail)?
            .with_parallel_execution(false)
            .map_err(fail)?
            .with_execution_providers([ep::DirectML::default().with_device_id(*adapter as i32).build().error_on_failure()])
            .map_err(fail)?,
    };
    builder.commit_from_file(model).map_err(|e| format!("Couldn't open {}: {e}", model.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devices_describe_themselves() {
        assert_eq!(Device::Cpu { threads: 2 }.label(), "CPU · 2 threads");
        assert_eq!(Device::DirectMl { adapter: 0, name: "Intel(R) HD Graphics 520".into() }.label(), "DirectML · Intel(R) HD Graphics 520");
        let json = serde_json::to_value(Device::DirectMl { adapter: 1, name: "GPU".into() }).unwrap();
        assert_eq!(json, serde_json::json!({ "kind": "directMl", "adapter": 1, "name": "GPU" }));
        assert_eq!(serde_json::from_value::<Device>(json).unwrap(), Device::DirectMl { adapter: 1, name: "GPU".into() });
    }
}
