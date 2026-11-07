//! Native system metrics backed by `sysinfo`.
//!
//! One `System` (plus GPU and network collectors) lives in managed state:
//! CPU, GPU and network rates are deltas between consecutive refreshes, so the
//! collectors must persist across calls. Every hardware value that a machine
//! may not expose is an `Option` — NOVA never invents a reading.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sysinfo::{
    Components, CpuRefreshKind, DiskKind, Disks, Gpus, Networks, ProcessRefreshKind, ProcessesToUpdate, System,
    MINIMUM_CPU_UPDATE_INTERVAL,
};

type CommandResult<T> = Result<T, String>;

const UNSUPPORTED: &str = "System metrics are not supported on this platform";

struct Monitor {
    sys: System,
    last_cpu_refresh: Instant,
    gpus: Option<GpuCollector>,
    networks: Option<Networks>,
    last_network_refresh: Instant,
    last_process_refresh: Option<Instant>,
}

/// sysinfo's Windows GPU collector holds raw D3DKMT adapter handles, so it is
/// not `Send`. Those kernel handles are process-wide (not thread-affine), and
/// the collector is only ever touched while holding the monitor mutex.
struct GpuCollector(Gpus);

// SAFETY: see above — exclusive access is guaranteed by `SystemMonitor::inner`.
unsafe impl Send for GpuCollector {}

pub struct SystemMonitor {
    inner: Mutex<Option<Monitor>>,
}

impl SystemMonitor {
    pub fn new() -> Self {
        let inner = System::new().ok().map(|mut sys| {
            // Loads the CPU list and primes the usage baseline, so the first
            // snapshot after MINIMUM_CPU_UPDATE_INTERVAL is already meaningful.
            sys.refresh_cpu_list(CpuRefreshKind::everything());
            sys.refresh_memory();
            Monitor {
                sys,
                last_cpu_refresh: Instant::now(),
                gpus: Gpus::new_with_refreshed_list().ok().map(GpuCollector),
                networks: Networks::new_with_refreshed_list().ok(),
                last_network_refresh: Instant::now(),
                last_process_refresh: None,
            }
        });
        Self { inner: Mutex::new(inner) }
    }

    fn with_monitor<T>(&self, f: impl FnOnce(&mut Monitor) -> T) -> CommandResult<T> {
        let mut guard = self.inner.lock().map_err(|_| "System monitor is unavailable".to_string())?;
        let monitor = guard.as_mut().ok_or_else(|| UNSUPPORTED.to_string())?;
        Ok(f(monitor))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    os_name: Option<String>,
    os_version: Option<String>,
    kernel_version: Option<String>,
    host_name: Option<String>,
    arch: String,
    cpu_brand: Option<String>,
    physical_cores: Option<usize>,
    logical_cores: usize,
    total_memory: u64,
    user_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuSample {
    name: String,
    vendor: Option<String>,
    /// `None` until a second sample exists, or when the driver does not report it.
    usage: Option<f32>,
    memory_used: Option<u64>,
    memory_total: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSample {
    rx_per_sec: u64,
    tx_per_sec: u64,
    total_rx: u64,
    total_tx: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSnapshot {
    timestamp_ms: u64,
    cpu_usage: f32,
    cpu_per_core: Vec<f32>,
    cpu_frequency_mhz: Option<u64>,
    memory_used: u64,
    memory_total: u64,
    swap_used: u64,
    swap_total: u64,
    uptime_seconds: Option<u64>,
    gpus: Vec<GpuSample>,
    network: Option<NetworkSample>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageVolume {
    name: String,
    mount_point: String,
    file_system: String,
    total_bytes: u64,
    available_bytes: u64,
    kind: &'static str,
    removable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemperatureSensor {
    label: String,
    celsius: f32,
    max_celsius: Option<f32>,
    critical_celsius: Option<f32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessEntry {
    pid: u32,
    name: String,
    /// Share of total CPU capacity (0–100), not of a single core.
    cpu: f32,
    memory: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessList {
    /// True on the first call: CPU shares need a second sample to be meaningful.
    measuring: bool,
    processes: Vec<ProcessEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterface {
    name: String,
    mac: String,
    total_rx: u64,
    total_tx: u64,
    link_speed_bps: Option<u64>,
    up: bool,
}

fn collect_info(sys: &System) -> SystemInfo {
    SystemInfo {
        os_name: System::long_os_version().or_else(|_| System::name()).ok(),
        os_version: System::os_version().ok(),
        kernel_version: System::kernel_version().ok(),
        host_name: System::host_name().ok(),
        arch: System::cpu_arch(),
        cpu_brand: sys.cpus().first().map(|cpu| cpu.brand().trim().to_string()).filter(|b| !b.is_empty()),
        physical_cores: System::physical_core_count().ok(),
        logical_cores: sys.cpus().len(),
        total_memory: sys.total_memory(),
        user_name: std::env::var("USERNAME").ok().filter(|name| !name.is_empty()),
    }
}

fn is_virtual_interface(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ["loopback", "isatap", "teredo", "pseudo-interface"].iter().any(|p| lower.contains(p))
}

/// Groups interfaces by MAC address. Windows exposes filter-driver layers
/// (e.g. "WLAN-WFP Native MAC Layer …") as extra interfaces carrying the same
/// traffic; keeping one entry per MAC avoids double counting.
fn physical_interfaces(networks: &Networks) -> Vec<(String, &sysinfo::NetworkData)> {
    let mut by_mac: HashMap<String, (String, &sysinfo::NetworkData)> = HashMap::new();
    for (name, data) in networks {
        let name = name.to_string_lossy().into_owned();
        let mac = data.mac_address().to_string();
        if mac == "00:00:00:00:00:00" || is_virtual_interface(&name) {
            continue;
        }
        let entry = by_mac.entry(mac).or_insert((name.clone(), data));
        let better = data.total_received() + data.total_transmitted() > entry.1.total_received() + entry.1.total_transmitted()
            || (data.total_received() == entry.1.total_received() && name.len() < entry.0.len());
        if better {
            *entry = (name, data);
        }
    }
    let mut list: Vec<_> = by_mac.into_values().collect();
    list.sort_by(|a, b| a.0.cmp(&b.0));
    list
}

fn collect_snapshot(monitor: &mut Monitor) -> SystemSnapshot {
    // Refreshing faster than the minimum interval yields meaningless usage
    // deltas, so overlapping callers reuse the previous CPU reading.
    if monitor.last_cpu_refresh.elapsed() >= MINIMUM_CPU_UPDATE_INTERVAL {
        monitor.sys.refresh_cpu_specifics(CpuRefreshKind::nothing().with_usage().with_frequency());
        monitor.last_cpu_refresh = Instant::now();
    }
    monitor.sys.refresh_memory();

    let gpus = match monitor.gpus.as_mut() {
        Some(GpuCollector(gpus)) => {
            gpus.refresh(true);
            (&*gpus)
                .into_iter()
                .map(|gpu| GpuSample {
                    name: gpu.model().unwrap_or("Graphics adapter").trim().to_string(),
                    vendor: gpu.vendor().map(|v| v.trim().to_string()).filter(|v| !v.is_empty()),
                    usage: gpu.usage().filter(|u| u.is_finite()).map(|u| u.clamp(0.0, 100.0)),
                    memory_used: gpu.used_memory(),
                    memory_total: gpu.total_memory().filter(|t| *t > 0),
                })
                .collect()
        }
        None => Vec::new(),
    };

    let network = monitor.networks.as_mut().map(|networks| {
        let elapsed = monitor.last_network_refresh.elapsed().as_secs_f64().max(0.001);
        networks.refresh(true);
        monitor.last_network_refresh = Instant::now();
        let interfaces = physical_interfaces(networks);
        let (rx, tx, total_rx, total_tx) = interfaces.iter().fold((0, 0, 0, 0), |acc, (_, d)| {
            (acc.0 + d.received(), acc.1 + d.transmitted(), acc.2 + d.total_received(), acc.3 + d.total_transmitted())
        });
        NetworkSample {
            rx_per_sec: (rx as f64 / elapsed) as u64,
            tx_per_sec: (tx as f64 / elapsed) as u64,
            total_rx,
            total_tx,
        }
    });

    let sys = &monitor.sys;
    SystemSnapshot {
        timestamp_ms: unix_millis(),
        cpu_usage: sys.global_cpu_usage().clamp(0.0, 100.0),
        cpu_per_core: sys.cpus().iter().map(|cpu| cpu.usage().clamp(0.0, 100.0)).collect(),
        cpu_frequency_mhz: sys.cpus().iter().map(|cpu| cpu.frequency()).max().filter(|mhz| *mhz > 0),
        memory_used: sys.used_memory(),
        memory_total: sys.total_memory(),
        swap_used: sys.used_swap(),
        swap_total: sys.total_swap(),
        uptime_seconds: System::uptime().ok(),
        gpus,
        network,
    }
}

fn collect_processes(monitor: &mut Monitor) -> ProcessList {
    let measuring = monitor.last_process_refresh.is_none();
    let fresh_enough = monitor.last_process_refresh.is_some_and(|t| t.elapsed() < MINIMUM_CPU_UPDATE_INTERVAL);
    if !fresh_enough {
        monitor.sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );
        monitor.last_process_refresh = Some(Instant::now());
    }
    let cores = monitor.sys.cpus().len().max(1) as f32;
    let mut processes: Vec<ProcessEntry> = monitor
        .sys
        .processes()
        .values()
        .filter(|p| p.pid().as_u32() != 0)
        .map(|p| ProcessEntry {
            pid: p.pid().as_u32(),
            name: p.name().to_string_lossy().into_owned(),
            cpu: (p.cpu_usage() / cores).clamp(0.0, 100.0),
            memory: p.memory(),
        })
        .collect();
    processes.sort_by(|a, b| b.cpu.total_cmp(&a.cpu).then(b.memory.cmp(&a.memory)));
    ProcessList { measuring, processes }
}

fn collect_volumes() -> CommandResult<Vec<StorageVolume>> {
    let disks = Disks::new_with_refreshed_list().map_err(|e| format!("Unable to read storage volumes: {e}"))?;
    let mut volumes: Vec<StorageVolume> = (&disks)
        .into_iter()
        .map(|disk| StorageVolume {
            name: disk.name().to_string_lossy().trim().to_string(),
            mount_point: disk.mount_point().to_string_lossy().to_string(),
            file_system: disk.file_system().to_string_lossy().to_string(),
            total_bytes: disk.total_space(),
            available_bytes: disk.available_space().min(disk.total_space()),
            kind: match disk.kind() {
                DiskKind::SSD => "ssd",
                DiskKind::HDD => "hdd",
                DiskKind::Unknown(_) => "unknown",
            },
            removable: disk.is_removable(),
        })
        .filter(|volume| volume.total_bytes > 0)
        .collect();
    volumes.sort_by(|a, b| a.mount_point.cmp(&b.mount_point));
    Ok(volumes)
}

fn collect_temperatures() -> Vec<TemperatureSensor> {
    let Ok(components) = Components::new_with_refreshed_list() else { return Vec::new() };
    (&components)
        .into_iter()
        .filter_map(|c| {
            let celsius = c.temperature().filter(|t| t.is_finite() && *t > -50.0 && *t < 150.0)?;
            Some(TemperatureSensor {
                label: c.label().trim().to_string(),
                celsius,
                max_celsius: c.max().filter(|t| t.is_finite() && *t > 0.0),
                critical_celsius: c.critical().filter(|t| t.is_finite() && *t > 0.0),
            })
        })
        .collect()
}

fn unix_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Static info plus a live sample, for NOVA AI's `system_info` tool.
pub(crate) fn overview(monitor: &SystemMonitor) -> CommandResult<serde_json::Value> {
    monitor.with_monitor(|m| serde_json::json!({ "info": collect_info(&m.sys), "now": collect_snapshot(m) }))
}

/// "C:\ 120 GB free of 930 GB" per drive, for NOVA AI's `task_manager` tool.
pub(crate) fn volume_lines() -> Vec<String> {
    let gib = |bytes: u64| bytes as f64 / 1_073_741_824.0;
    collect_volumes().unwrap_or_default().iter().map(|v| format!("{} {:.0} GB free of {:.0} GB", v.mount_point, gib(v.available_bytes), gib(v.total_bytes))).collect()
}

#[tauri::command]
pub async fn system_info(monitor: tauri::State<'_, SystemMonitor>) -> CommandResult<SystemInfo> {
    monitor.with_monitor(|m| collect_info(&m.sys))
}

#[tauri::command]
pub async fn system_snapshot(monitor: tauri::State<'_, SystemMonitor>) -> CommandResult<SystemSnapshot> {
    monitor.with_monitor(collect_snapshot)
}

#[tauri::command]
pub async fn system_processes(monitor: tauri::State<'_, SystemMonitor>) -> CommandResult<ProcessList> {
    monitor.with_monitor(collect_processes)
}

#[tauri::command]
pub async fn system_network_interfaces(monitor: tauri::State<'_, SystemMonitor>) -> CommandResult<Vec<NetworkInterface>> {
    monitor.with_monitor(|m| {
        let Some(networks) = m.networks.as_ref() else { return Vec::new() };
        physical_interfaces(networks)
            .into_iter()
            .map(|(name, data)| NetworkInterface {
                name,
                mac: data.mac_address().to_string(),
                total_rx: data.total_received(),
                total_tx: data.total_transmitted(),
                link_speed_bps: data.receive_link_speed().or(data.transmit_link_speed()).filter(|s| *s > 0),
                up: matches!(data.operational_state(), sysinfo::InterfaceOperationalState::Up),
            })
            .collect()
    })
}

/// Temperature sensors exposed to unprivileged apps; often empty on Windows.
/// The hottest sensor Windows reports; `None` on the many PCs that don't tell.
pub fn hottest_sensor() -> Option<f32> {
    collect_temperatures().iter().map(|sensor| sensor.celsius).max_by(f32::total_cmp)
}

#[tauri::command]
pub async fn system_temperatures() -> CommandResult<Vec<TemperatureSensor>> {
    tauri::async_runtime::spawn_blocking(collect_temperatures).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn storage_volumes() -> CommandResult<Vec<StorageVolume>> {
    tauri::async_runtime::spawn_blocking(collect_volumes)
        .await
        .map_err(|e| format!("Storage scan failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_reports_plausible_values() {
        let monitor = SystemMonitor::new();
        std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL);
        let snapshot = monitor.with_monitor(collect_snapshot).expect("supported host");

        assert!((0.0..=100.0).contains(&snapshot.cpu_usage));
        assert!(!snapshot.cpu_per_core.is_empty());
        assert!(snapshot.memory_total > 0);
        assert!(snapshot.memory_used <= snapshot.memory_total);
        for gpu in &snapshot.gpus {
            assert!(gpu.usage.is_none_or(|u| (0.0..=100.0).contains(&u)));
        }
    }

    #[test]
    fn rapid_snapshots_keep_previous_cpu_reading() {
        let monitor = SystemMonitor::new();
        std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL);
        let first = monitor.with_monitor(collect_snapshot).unwrap();
        let second = monitor.with_monitor(collect_snapshot).unwrap();
        assert_eq!(first.cpu_usage, second.cpu_usage);
    }

    #[test]
    fn info_reports_cpu_topology() {
        let monitor = SystemMonitor::new();
        let info = monitor.with_monitor(|m| collect_info(&m.sys)).unwrap();
        assert!(info.logical_cores > 0);
        assert!(info.total_memory > 0);
        assert!(!info.arch.is_empty());
    }

    #[test]
    fn processes_are_listed_with_normalized_cpu() {
        let monitor = SystemMonitor::new();
        let first = monitor.with_monitor(collect_processes).unwrap();
        assert!(first.measuring);
        std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL);
        let second = monitor.with_monitor(collect_processes).unwrap();
        assert!(!second.measuring);
        assert!(!second.processes.is_empty());
        assert!(second.processes.iter().all(|p| (0.0..=100.0).contains(&p.cpu)));
        assert!(second.processes.windows(2).all(|w| w[0].cpu >= w[1].cpu));
    }

    #[test]
    fn volumes_never_report_more_free_space_than_capacity() {
        for volume in collect_volumes().unwrap() {
            assert!(volume.available_bytes <= volume.total_bytes);
        }
    }

    #[test]
    fn temperatures_are_plausible_when_present() {
        for sensor in collect_temperatures() {
            assert!(sensor.celsius > -50.0 && sensor.celsius < 150.0);
        }
    }

    #[test]
    fn virtual_interfaces_are_ignored() {
        assert!(is_virtual_interface("Loopback Pseudo-Interface 1"));
        assert!(is_virtual_interface("isatap.{1234}"));
        assert!(!is_virtual_interface("WLAN"));
    }

    #[test]
    fn payloads_use_camel_case_keys() {
        let volume = StorageVolume {
            name: "System".into(),
            mount_point: "C:\\".into(),
            file_system: "NTFS".into(),
            total_bytes: 100,
            available_bytes: 40,
            kind: "ssd",
            removable: false,
        };
        let json = serde_json::to_value(volume).unwrap();
        assert_eq!(json["mountPoint"], "C:\\");
        assert_eq!(json["availableBytes"], 40);
    }
}
