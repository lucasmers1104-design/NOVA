import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { notifyError } from "@/features/notifications/store";
import { callNative } from "@/lib/native";
import { nativeStorage } from "@/lib/persistence";

/** Mirrors `MediaState` in src-tauri/src/media.rs. */
export interface MediaState {
  sourceAppId: string;
  title: string;
  artist: string;
  album: string;
  status: "playing" | "paused" | "stopped" | "changing" | "opened" | "closed";
  canPlayPause: boolean;
  canNext: boolean;
  canPrevious: boolean;
  positionMs: number | null;
  durationMs: number | null;
  sampledAtMs: number;
  artworkKey: string | null;
}

export interface VolumeState {
  level: number;
  muted: boolean;
}

export type MediaAction = "toggle" | "next" | "previous";

export const mediaKeys = {
  state: ["media", "state"] as const,
  artwork: (key: string | null) => ["media", "artwork", key] as const,
  volume: ["media", "volume"] as const,
};

const KNOWN_SOURCES: [RegExp, string][] = [
  [/spotify/i, "Spotify"],
  [/zunemusic|mediaplayer/i, "Media Player"],
  [/msedge/i, "Microsoft Edge"],
  [/chrome/i, "Google Chrome"],
  [/firefox/i, "Firefox"],
  [/vlc/i, "VLC"],
  [/brave/i, "Brave"],
  [/opera/i, "Opera"],
  [/itunes|applemusic/i, "Apple Music"],
  [/tidal/i, "TIDAL"],
  [/deezer/i, "Deezer"],
];

/** "Spotify.exe" → "Spotify"; "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic" → "Media Player". */
export function sourceAppName(id: string): string {
  for (const [pattern, name] of KNOWN_SOURCES) if (pattern.test(id)) return name;
  const base = id.split("!")[0]!.split("_")[0]!.split(/[\\/]/).pop() ?? id;
  const cleaned = base.replace(/\.exe$/i, "").split(".").pop() ?? base;
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : "Unknown player";
}

export function useMediaState(enabled = true) {
  return useQuery({
    queryKey: mediaKeys.state,
    queryFn: async () => {
      const state = await callNative<MediaState | null>("media_state");
      if (state?.title) useMediaHistory.getState().record(state);
      return state;
    },
    enabled,
    refetchInterval: 1500,
    refetchIntervalInBackground: false,
  });
}

export function useArtwork(key: string | null) {
  return useQuery({
    queryKey: mediaKeys.artwork(key),
    queryFn: () => callNative<string | null>("media_artwork"),
    enabled: key !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
    retry: false,
  });
}

export function useMediaControl() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: MediaAction) => callNative<void>("media_control", { action }),
    onSettled: () => setTimeout(() => void client.invalidateQueries({ queryKey: mediaKeys.state }), 250),
    onError: (error) => notifyError("The player didn't respond", error),
  });
}

export function useVolume() {
  return useQuery({
    queryKey: mediaKeys.volume,
    queryFn: () => callNative<VolumeState>("media_volume"),
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
  });
}

export function useSetVolume() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (change: { level?: number; muted?: boolean }) => callNative<VolumeState>("media_volume_set", change),
    onSuccess: (state) => client.setQueryData(mediaKeys.volume, state),
    onError: (error) => notifyError("Couldn't change the volume", error),
  });
}

/** Current position, advanced locally between polls while playing. */
export function useLivePosition(state: MediaState | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  const playing = state?.status === "playing";
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [playing]);
  if (!state || state.positionMs === null) return null;
  const elapsed = playing ? Math.max(0, now - state.sampledAtMs) : 0;
  const position = state.positionMs + elapsed;
  return state.durationMs !== null ? Math.min(position, state.durationMs) : position;
}

export function formatTrackTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export interface HistoryEntry {
  title: string;
  artist: string;
  source: string;
  at: number;
}

interface MediaHistoryState {
  entries: HistoryEntry[];
  record: (state: MediaState) => void;
  clear: () => void;
}

/** Tracks seen while NOVA was running (newest first). */
export const useMediaHistory = create<MediaHistoryState>()(
  persist(
    (set) => ({
      entries: [],
      record: (state) =>
        set((s) => {
          const latest = s.entries[0];
          if (latest && latest.title === state.title && latest.artist === state.artist) return s;
          const entry: HistoryEntry = { title: state.title, artist: state.artist, source: sourceAppName(state.sourceAppId), at: Date.now() };
          return { entries: [entry, ...s.entries].slice(0, 25) };
        }),
      clear: () => set({ entries: [] }),
    }),
    {
      name: "nova.media",
      storage: createJSONStorage(() => nativeStorage),
      partialize: (s) => ({ entries: s.entries }),
      merge: (persisted, current) => {
        const raw = (persisted as { entries?: unknown } | null)?.entries;
        const entries = Array.isArray(raw)
          ? raw.filter((e): e is HistoryEntry => typeof e?.title === "string" && typeof e?.at === "number").slice(0, 25)
          : [];
        return { ...current, entries };
      },
    },
  ),
);
