import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { callNative } from "@/lib/native";

/** Mirrors `ScanStatus` in src-tauri/src/scan.rs. */
export interface ScanStatus {
  state: "idle" | "running" | "clean" | "threats" | "failed" | "cancelled";
  kind: "quick" | "full" | null;
  startedAt: number;
  finishedAt: number;
  threats: string[];
  message: string | null;
}

const IDLE: ScanStatus = { state: "idle", kind: null, startedAt: 0, finishedAt: 0, threats: [], message: null };

export const useScan = create<{ status: ScanStatus; dismissed: boolean }>()(() => ({ status: IDLE, dismissed: false }));

export const cancelScan = () => callNative<void>("scan_cancel");
export const openWindowsSecurity = () => callNative<void>("scan_open_security");
export const dismissScan = () => useScan.setState({ dismissed: true });

/** Keeps `useScan` current; returns the unsubscribe function. */
export function watchScan(onFinished?: (status: ScanStatus) => void): () => void {
  void callNative<ScanStatus>("scan_status").then((status) => useScan.setState({ status }), () => {});
  const stop = listen<ScanStatus>("scan://status", ({ payload }) => {
    useScan.setState({ status: payload, dismissed: false });
    if (payload.state !== "running") onFinished?.(payload);
  });
  return () => void stop.then((unlisten) => unlisten()).catch(() => {});
}

/** "1:05" from milliseconds. */
export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}
