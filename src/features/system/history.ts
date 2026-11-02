import { create } from "zustand";
import { ratioPercent } from "@/lib/format";
import type { SystemSnapshot } from "./api";

export interface MetricSample {
  t: number;
  cpu: number;
  memory: number;
  /** Primary GPU utilization; null when the driver does not report it. */
  gpu: number | null;
  rx: number | null;
  tx: number | null;
}

/** Samples kept for the current session (5 minutes at the default 2 s interval). */
export const HISTORY_LIMIT = 150;

interface MetricHistoryState {
  samples: MetricSample[];
  record: (snapshot: SystemSnapshot) => void;
  clear: () => void;
}

/** Chooses the GPU to chart: the busiest one that reports utilization. */
export function primaryGpuUsage(snapshot: Pick<SystemSnapshot, "gpus">): number | null {
  const usages = (snapshot.gpus ?? []).map((g) => g.usage).filter((u): u is number => u !== null);
  return usages.length ? Math.max(...usages) : null;
}

export const useMetricHistory = create<MetricHistoryState>()((set) => ({
  samples: [],
  record: (snapshot) =>
    set((state) => {
      const last = state.samples.at(-1);
      if (last && last.t >= snapshot.timestampMs) return state;
      const sample: MetricSample = {
        t: snapshot.timestampMs,
        cpu: snapshot.cpuUsage,
        memory: ratioPercent(snapshot.memoryUsed, snapshot.memoryTotal),
        gpu: primaryGpuUsage(snapshot),
        rx: snapshot.network?.rxPerSec ?? null,
        tx: snapshot.network?.txPerSec ?? null,
      };
      return { samples: [...state.samples, sample].slice(-HISTORY_LIMIT) };
    }),
  clear: () => set({ samples: [] }),
}));
