import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { callNative, isDesktop } from "@/lib/native";

/** Mirrors `TelemetryStatus` in src-tauri/src/telemetry.rs. */
export interface TelemetryStatus {
  needsDecision: boolean;
  accepted: boolean;
  decidedAt: number | null;
  installId: string | null;
  displayName: string | null;
  lastSent: number | null;
  lastError: string | null;
  waiting: number;
  privacyUrl: string;
  host: string;
}

export interface SentEvent {
  at: number;
  sentAt: number | null;
  body: Record<string, unknown>;
}

const STATUS_KEY = ["telemetry", "status"] as const;
const RECENT_KEY = ["telemetry", "recent"] as const;

export function useTelemetryStatus() {
  return useQuery({ queryKey: STATUS_KEY, queryFn: () => callNative<TelemetryStatus>("telemetry_status"), enabled: isDesktop(), refetchInterval: 30_000 });
}

export function useRecentEvents(enabled: boolean) {
  return useQuery({ queryKey: RECENT_KEY, queryFn: () => callNative<SentEvent[]>("telemetry_recent"), enabled: isDesktop() && enabled, refetchInterval: 30_000 });
}

export function useTelemetryDecision() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (accepted: boolean) => callNative<TelemetryStatus>("telemetry_decide", { accepted }),
    onSuccess: (status) => {
      client.setQueryData(STATUS_KEY, status);
      void client.invalidateQueries({ queryKey: RECENT_KEY });
    },
  });
}

export function useTelemetryName() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string | null) => callNative<TelemetryStatus>("telemetry_set_name", { name }),
    onSuccess: (status) => client.setQueryData(STATUS_KEY, status),
  });
}

/** Rust checks the kind and the name again and ignores all of it without consent. */
export function trackEvent(kind: "page" | "widget_add" | "update", name: string, value: number): void {
  if (isDesktop()) void callNative("telemetry_track", { kind, name, value }).catch(() => undefined);
}

/**
 * The consent popup comes first: "What's new" and an automatic update wait until it
 * is answered or dismissed. Dismissing it decides nothing, it comes back at the next start.
 */
export const useConsentPrompt = create<{ open: boolean; setOpen: (open: boolean) => void }>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
