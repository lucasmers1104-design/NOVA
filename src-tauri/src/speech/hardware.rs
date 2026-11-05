//! What this PC offers NOVA's speech engines: the processor (and its vector
//! instructions), memory, every graphics adapter with its driver, and which
//! ways of running a model exist. Nothing here decides by brand: DirectML is
//! only used after a model actually ran on the adapter (see `probe`).

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Adapter {
    /// DXGI's adapter index (what DirectML calls the device id).
    pub index: u32,
    pub name: String,
    pub vendor: &'static str,
    pub vendor_id: u32,
    pub device_id: u32,
    pub dedicated_memory: u64,
    pub shared_memory: u64,
    pub driver: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub cpu: String,
    pub physical_cores: usize,
    pub logical_cores: usize,
    pub avx2: bool,
    pub avx512: bool,
    pub memory_total: u64,
    pub memory_available: u64,
    pub adapters: Vec<Adapter>,
    /// Present on the PC, but NOVA doesn't use them (DirectML covers every GPU).
    pub cuda: bool,
    pub rocm: bool,
    pub vulkan: bool,
}

impl Report {
    /// A cache key: changes when the hardware or a driver changes.
    pub fn key(&self) -> String {
        let adapters: Vec<String> = self.adapters.iter().map(|a| format!("{:04x}:{:04x}:{}", a.vendor_id, a.device_id, a.driver.as_deref().unwrap_or("?"))).collect();
        format!("{}|{}|{}", self.cpu, self.logical_cores, adapters.join(","))
    }
}

pub fn vendor_name(id: u32) -> &'static str {
    match id {
        0x10DE => "NVIDIA",
        0x1002 | 0x1022 => "AMD",
        0x8086 => "Intel",
        0x1414 => "Microsoft",
        0x5143 => "Qualcomm",
        _ => "Unknown",
    }
}

/// A DXGI driver version (UMD) as Windows shows it: 24.20.100.6286.
pub fn driver_version(raw: i64) -> String {
    let raw = raw as u64;
    format!("{}.{}.{}.{}", raw >> 48, (raw >> 32) & 0xFFFF, (raw >> 16) & 0xFFFF, raw & 0xFFFF)
}

#[cfg(windows)]
fn adapters() -> Vec<Adapter> {
    use windows::core::Interface;
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIDevice, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
    let mut out = Vec::new();
    // SAFETY: plain COM calls; the factory and adapters are released when dropped.
    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else { return out };
        let mut index = 0;
        while let Ok(adapter) = factory.EnumAdapters1(index) {
            if let Ok(desc) = adapter.GetDesc1() {
                let software = desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0;
                if !software {
                    let len = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
                    out.push(Adapter {
                        index,
                        name: String::from_utf16_lossy(&desc.Description[..len]).trim().to_string(),
                        vendor: vendor_name(desc.VendorId),
                        vendor_id: desc.VendorId,
                        device_id: desc.DeviceId,
                        dedicated_memory: desc.DedicatedVideoMemory as u64,
                        shared_memory: desc.SharedSystemMemory as u64,
                        driver: adapter.CheckInterfaceSupport(&IDXGIDevice::IID).ok().map(driver_version),
                    });
                }
            }
            index += 1;
        }
    }
    out
}

#[cfg(not(windows))]
fn adapters() -> Vec<Adapter> {
    Vec::new()
}

fn system_library(name: &str) -> bool {
    let root = std::env::var_os("SystemRoot").map(std::path::PathBuf::from).unwrap_or_else(|| "C:\\Windows".into());
    root.join("System32").join(name).is_file()
}

/// Looks at the PC (about 50–100 ms).
pub fn detect() -> Report {
    use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};
    let sys = System::new_with_specifics(RefreshKind::nothing().with_cpu(CpuRefreshKind::nothing()).with_memory(MemoryRefreshKind::everything())).ok();
    let cpus = sys.as_ref().map(|s| s.cpus()).unwrap_or_default();
    let cpu = cpus.first().map(|c| c.brand().trim().to_string()).filter(|b| !b.is_empty()).unwrap_or_else(|| "Unknown processor".into());
    let logical = cpus.len().max(1);
    #[cfg(target_arch = "x86_64")]
    let (avx2, avx512) = (std::arch::is_x86_feature_detected!("avx2"), std::arch::is_x86_feature_detected!("avx512f"));
    #[cfg(not(target_arch = "x86_64"))]
    let (avx2, avx512) = (false, false);
    Report {
        cpu,
        physical_cores: System::physical_core_count().unwrap_or(logical).max(1),
        logical_cores: logical,
        avx2,
        avx512,
        memory_total: sys.as_ref().map_or(0, |s| s.total_memory()),
        memory_available: sys.as_ref().map_or(0, |s| s.available_memory()),
        adapters: adapters(),
        cuda: system_library("nvcuda.dll"),
        rocm: system_library("amdhip64.dll") || system_library("amdhip64_6.dll") || std::env::var_os("HIP_PATH").is_some(),
        vulkan: system_library("vulkan-1.dll"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_driver_versions_like_windows() {
        let raw = (24i64 << 48) | (20i64 << 32) | (100i64 << 16) | 6286;
        assert_eq!(driver_version(raw), "24.20.100.6286");
        assert_eq!(vendor_name(0x8086), "Intel");
        assert_eq!(vendor_name(0x10DE), "NVIDIA");
        assert_eq!(vendor_name(0x1002), "AMD");
    }

    #[test]
    fn detects_this_pc() {
        let report = detect();
        assert!(report.logical_cores >= 1 && report.memory_total > 0);
        assert!(report.key().contains(&report.cpu));
    }
}
