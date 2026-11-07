import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { notifyError } from "@/features/notifications/store";
import { callNative } from "@/lib/native";

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
  canSeek: boolean;
  positionMs: number | null;
  durationMs: number | null;
  sampledAtMs: number;
  artworkKey: string | null;
}

export interface VolumeState {
  level: number;
  muted: boolean;
}

export interface AudioApp {
  name: string;
  level: number;
  muted: boolean;
}

export interface OutputDevice {
  id: string;
  name: string;
  default: boolean;
}

export interface LyricLine {
  atMs: number | null;
  text: string;
}

export interface SleepTimer {
  id: number;
  endsAt: number;
}

export type MediaAction = "toggle" | "next" | "previous";

export const mediaKeys = {
  state: ["media", "state"] as const,
  artwork: (key: string | null) => ["media", "artwork", key] as const,
  volume: ["media", "volume"] as const,
  mixer: ["media", "mixer"] as const,
  outputs: ["media", "outputs"] as const,
  played: ["media", "played"] as const,
  sleep: ["media", "sleep"] as const,
  lyrics: (title: string, artist: string) => ["media", "lyrics", title, artist] as const,
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
    queryFn: () => callNative<MediaState | null>("media_state"),
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

export function useSeek() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (positionMs: number) => callNative<void>("media_seek", { positionMs: Math.round(positionMs) }),
    onSettled: () => setTimeout(() => void client.invalidateQueries({ queryKey: mediaKeys.state }), 250),
    onError: (error) => notifyError("The player didn't jump there", error),
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
    // One after another, so a fast drag can't end on an earlier value.
    scope: { id: "media-volume" },
    mutationFn: (change: { level?: number; muted?: boolean }) => callNative<VolumeState>("media_volume_set", change),
    onMutate: (change) => client.setQueryData<VolumeState>(mediaKeys.volume, (state) => (state ? { ...state, ...change } : state)),
    onSuccess: (state) => client.setQueryData(mediaKeys.volume, state),
    onError: (error) => notifyError("Couldn't change the volume", error),
  });
}

export function useMixer() {
  return useQuery({
    queryKey: mediaKeys.mixer,
    queryFn: () => callNative<AudioApp[]>("media_mixer"),
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
  });
}

export function useSetMixer() {
  const client = useQueryClient();
  return useMutation({
    scope: { id: "media-mixer" },
    mutationFn: (change: { name: string; level?: number; muted?: boolean }) => callNative<void>("media_mixer_set", change),
    onMutate: (change) => client.setQueryData<AudioApp[]>(mediaKeys.mixer, (apps) => apps?.map((app) => (app.name === change.name ? { ...app, ...change } : app))),
    onError: (error) => notifyError("Couldn't change the volume", error),
  });
}

export function useOutputs() {
  return useQuery({ queryKey: mediaKeys.outputs, queryFn: () => callNative<OutputDevice[]>("media_outputs"), refetchInterval: 15_000, refetchIntervalInBackground: false });
}

export function useSetOutput() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => callNative<void>("media_output_set", { id }),
    onSettled: () => void client.invalidateQueries({ queryKey: mediaKeys.outputs }),
    onError: (error) => notifyError("Couldn't switch the output", error),
  });
}

/** Asked only while the lyrics are open: the song's name goes to a public database. */
export function useLyrics(state: MediaState | null | undefined, enabled: boolean) {
  const title = state?.title ?? "";
  const artist = state?.artist ?? "";
  return useQuery({
    queryKey: mediaKeys.lyrics(title, artist),
    queryFn: () => callNative<LyricLine[]>("media_lyrics", { title, artist, durationMs: state?.durationMs ?? null }),
    enabled: enabled && title !== "",
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 60_000,
    retry: false,
  });
}

/** The line being sung at `positionMs`; -1 before the first. */
export function currentLine(lines: readonly LyricLine[], positionMs: number): number {
  let current = -1;
  for (const [index, line] of lines.entries()) {
    if (line.atMs === null || line.atMs > positionMs) break;
    current = index;
  }
  return current;
}

export function useSleepTimer() {
  return useQuery({ queryKey: mediaKeys.sleep, queryFn: () => callNative<SleepTimer | null>("media_sleep", { minutes: null }), refetchInterval: 30_000, refetchIntervalInBackground: false });
}

export function useSetSleepTimer() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (minutes: number) => callNative<SleepTimer | null>("media_sleep", { minutes }),
    onSuccess: (timer) => client.setQueryData(mediaKeys.sleep, timer),
    onError: (error) => notifyError("Couldn't set the sleep timer", error),
  });
}

export function usePlaySomething() {
  return useMutation({
    mutationFn: ({ service, query }: { service: "youtube" | "spotify"; query: string }) => callNative<string>("media_play", { service, query }),
    onError: (error) => notifyError("That didn't start", error),
  });
}

export interface PlayedEntry {
  title: string;
  artist: string;
  source: string;
  at: number;
}

export function usePlayed() {
  return useQuery({ queryKey: mediaKeys.played, queryFn: () => callNative<PlayedEntry[]>("media_played"), refetchInterval: 20_000, refetchIntervalInBackground: false });
}

export function useClearPlayed() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => callNative<void>("media_played_clear"),
    onSuccess: () => client.setQueryData(mediaKeys.played, []),
    onError: (error) => notifyError("Couldn't clear the list", error),
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
