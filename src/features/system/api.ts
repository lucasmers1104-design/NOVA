import { useQuery } from "@tanstack/react-query";
import { callNative } from "@/lib/native";
import { useSettings } from "@/stores/settings";
import { useMetricHistory } from "./history";

/** Mirrors `SystemInfo` in src-tauri/src/system.rs. */
export interface SystemInfo {
  osName: string | null;
  osVersion: string | null;
  kernelVersion: string | null;
  hostName: string | null;
  arch: string;
  cpuBrand: string | null;
  physicalCores: number | null;
  logicalCores: number;
  totalMemory: number;
  userName: string | null;
}

/** Mirrors `GpuSample` in src-tauri/src/system.rs. Every metric is optional: drivers differ. */
export interface GpuSample {
  name: string;
  vendor: string | null;
  usage: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
}

export interface NetworkSample {
  rxPerSec: number;
  txPerSec: number;
  totalRx: number;
  totalTx: number;
}

/** Mirrors `SystemSnapshot` in src-tauri/src/system.rs. */
export interface SystemSnapshot {
  timestampMs: number;
  cpuUsage: number;
  cpuPerCore: number[];
  cpuFrequencyMhz: number | null;
  memoryUsed: number;
  memoryTotal: number;
  swapUsed: number;
  swapTotal: number;
  uptimeSeconds: number | null;
  gpus: GpuSample[];
  network: NetworkSample | null;
}

export interface ProcessEntry {
  pid: number;
  name: string;
  cpu: number;
  memory: number;
}

export interface ProcessList {
  measuring: boolean;
  processes: ProcessEntry[];
}

export interface TemperatureSensor {
  label: string;
  celsius: number;
  maxCelsius: number | null;
  criticalCelsius: number | null;
}

export interface NetworkInterface {
  name: string;
  mac: string;
  totalRx: number;
  totalTx: number;
  linkSpeedBps: number | null;
  up: boolean;
}

/** Mirrors `StorageVolume` in src-tauri/src/system.rs. */
export interface StorageVolume {
  name: string;
  mountPoint: string;
  fileSystem: string;
  totalBytes: number;
  availableBytes: number;
  kind: "ssd" | "hdd" | "unknown";
  removable: boolean;
}

export const systemKeys = {
  info: ["system", "info"] as const,
  snapshot: ["system", "snapshot"] as const,
  storage: ["system", "storage"] as const,
  processes: ["system", "processes"] as const,
  temperatures: ["system", "temperatures"] as const,
  interfaces: ["system", "interfaces"] as const,
};

const STORAGE_REFRESH_MS = 60_000;

export function useSystemInfo() {
  return useQuery({
    queryKey: systemKeys.info,
    queryFn: () => callNative<SystemInfo>("system_info"),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Live metrics. Polling pauses automatically while the window is hidden or
 * minimized, and stops entirely when no mounted component needs the data.
 */
export function useSystemSnapshot() {
  const interval = useSettings((s) => s.refreshIntervalMs);
  return useQuery({
    queryKey: systemKeys.snapshot,
    queryFn: async () => {
      const snapshot = await callNative<SystemSnapshot>("system_snapshot");
      // Recorded here (once per fetch) rather than in components, so several
      // widgets observing the same query never record duplicate samples.
      useMetricHistory.getState().record(snapshot);
      return snapshot;
    },
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
}

/** Process list; only polled while a component showing it is mounted and not paused. */
export function useProcesses(paused = false) {
  const interval = useSettings((s) => s.refreshIntervalMs);
  return useQuery({
    queryKey: systemKeys.processes,
    queryFn: () => callNative<ProcessList>("system_processes"),
    refetchInterval: paused ? false : Math.max(interval, 2000),
    refetchIntervalInBackground: false,
  });
}

/** Temperature sensors are read through WMI, which is slow; poll gently. */
export function useTemperatures() {
  return useQuery({
    queryKey: systemKeys.temperatures,
    queryFn: () => callNative<TemperatureSensor[]>("system_temperatures"),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}

export function useNetworkInterfaces() {
  return useQuery({
    queryKey: systemKeys.interfaces,
    queryFn: () => callNative<NetworkInterface[]>("system_network_interfaces"),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}

export function useStorageVolumes() {
  return useQuery({
    queryKey: systemKeys.storage,
    queryFn: () => callNative<StorageVolume[]>("storage_volumes"),
    refetchInterval: STORAGE_REFRESH_MS,
    refetchIntervalInBackground: false,
  });
}
