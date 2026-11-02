import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import { flushDashboardSaves } from "@/features/dashboard/store";
import { callNative, isDesktop } from "@/lib/native";
import { useSettings } from "@/stores/settings";

/**
 * Where releases are published unless the user sets their own source in
 * Settings → Updates: a public GitHub repository (owner/name) whose `releases/`
 * folder holds the installers and `latest.json`.
 */
export const DEFAULT_UPDATE_SOURCE = "lucasmers1104-design/NOVA";

/** Seconds between "update found" and the automatic install. */
export const AUTO_INSTALL_DELAY_S = 15;

export function effectiveUpdateSource(): string {
  return useSettings.getState().updateSource.trim() || DEFAULT_UPDATE_SOURCE;
}

/** Mirrors `UpdateInfo` in src-tauri/src/updates.rs. */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string | null;
}

type InstallEvent = { type: "progress"; downloaded: number; total: number | null } | { type: "installing" };

export type UpdateStatus = "idle" | "checking" | "upToDate" | "available" | "downloading" | "installing" | "error";

interface UpdateState {
  status: UpdateStatus;
  info: UpdateInfo | null;
  error: string | null;
  downloaded: number;
  total: number | null;
  /** Seconds left before the automatic install; null when no countdown runs. */
  countdown: number | null;
  /** The banner was dismissed with "Later" for this session. */
  postponed: boolean;
  check: (options: { automatic: boolean }) => Promise<void>;
  install: () => Promise<void>;
  tick: () => void;
  postpone: () => void;
}

export const useUpdates = create<UpdateState>()((set, get) => ({
  status: "idle",
  info: null,
  error: null,
  downloaded: 0,
  total: null,
  countdown: null,
  postponed: false,

  check: async ({ automatic }) => {
    const source = effectiveUpdateSource();
    if (!isDesktop()) return;
    if (!source) {
      set({ status: "error", error: "Set an update source in Settings → Updates first." });
      return;
    }
    if (get().status === "checking" || get().status === "downloading" || get().status === "installing") return;
    set({ status: "checking", error: null });
    try {
      const info = await callNative<UpdateInfo | null>("update_check", { source });
      if (!info) {
        set({ status: "upToDate", info: null, countdown: null });
        return;
      }
      set({ status: "available", info, postponed: false, countdown: automatic ? AUTO_INSTALL_DELAY_S : null });
    } catch (error) {
      // Automatic checks fail quietly (offline at boot is normal); manual checks show why.
      set({ status: automatic ? "idle" : "error", error: error instanceof Error ? error.message : String(error) });
    }
  },

  install: async () => {
    if (get().status !== "available") return;
    set({ status: "downloading", countdown: null, downloaded: 0, total: null });
    try {
      // Nothing may be lost when the installer closes the app.
      await flushDashboardSaves();
      const channel = new Channel<InstallEvent>();
      channel.onmessage = (event) => {
        if (event.type === "progress") set({ downloaded: event.downloaded, total: event.total });
        else set({ status: "installing" });
      };
      await callNative("update_install", { onEvent: channel });
      // Windows: the process exits inside update_install and the installer restarts NOVA.
      set({ status: "installing" });
    } catch (error) {
      set({ status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  },

  tick: () => {
    const { countdown } = get();
    if (countdown === null) return;
    if (countdown <= 1) {
      set({ countdown: 0 });
      void get().install();
    } else {
      set({ countdown: countdown - 1 });
    }
  },

  postpone: () => set({ postponed: true, countdown: null }),
}));
