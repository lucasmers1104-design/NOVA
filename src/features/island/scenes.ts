// The scenes Island Studio plays: made-up moments for every module, fed to the same
// IslandView the real island uses. The island's window plays them too, for a few
// seconds, when the Studio's "show on the desktop" is on.

import type { LyricLine } from "@/features/media/api";
import { EMPTY_DATA, type IslandData } from "./data";
import type { SceneId } from "./types";

export interface Scene {
  id: SceneId;
  label: string;
  /** The island is opened in this scene. */
  expanded: boolean;
  lyrics: boolean;
  /** The moment, for a scene that started at `startedAt` (ms). */
  data: (startedAt: number) => IslandData;
}

/** A cover that needs no file: two soft lights on a dusk gradient. */
const DEMO_COVER = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#12c2e9"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><circle cx="46" cy="20" r="14" fill="#fff" fill-opacity=".28"/><circle cx="20" cy="46" r="20" fill="#0b1024" fill-opacity=".35"/></svg>',
)}`;

const GIB = 1024 ** 3;

/** Lines written for the demo, timed like synced lyrics. */
export const DEMO_LYRICS: readonly LyricLine[] = [
  { atMs: 30_000, text: "Die Stadt wird leise unter mir" },
  { atMs: 35_000, text: "Ein Fenster Licht, sonst nichts mehr hier" },
  { atMs: 40_000, text: "Ich zähl die Sterne, einer fehlt" },
  { atMs: 45_000, text: "Und frag mich, wer ihn heute hält" },
  { atMs: 50_000, text: "Wir fliegen durch die Nacht" },
  { atMs: 55_000, text: "Bis der Morgen wieder lacht" },
  { atMs: 60_000, text: "♪" },
  { atMs: 66_000, text: "Die Straßen ziehen Linien aus Licht" },
  { atMs: 71_000, text: "Und keine davon führt zurück" },
];

function music(startedAt: number): IslandData {
  return {
    ...EMPTY_DATA,
    media: {
      artwork: DEMO_COVER,
      state: {
        sourceAppId: "Spotify.exe",
        title: "Nachtflug",
        artist: "Aurora Lane",
        album: "Lichter",
        status: "playing",
        canPlayPause: true,
        canNext: true,
        canPrevious: true,
        canSeek: true,
        positionMs: 42_000,
        durationMs: 201_000,
        sampledAtMs: startedAt,
        artworkKey: "demo",
      },
    },
  };
}

export const SCENES: readonly Scene[] = [
  { id: "idle", label: "Leerlauf", expanded: false, lyrics: false, data: () => EMPTY_DATA },
  { id: "music", label: "Musik", expanded: false, lyrics: false, data: music },
  { id: "lyrics", label: "Musik + Lyrics", expanded: true, lyrics: true, data: music },
  {
    id: "notification",
    label: "Benachrichtigung",
    expanded: false,
    lyrics: false,
    data: (startedAt) => ({
      ...EMPTY_DATA,
      notice: { notifId: "demo", app: "com.whatsapp", appName: "WhatsApp", title: "Lena", text: "Bin in zehn Minuten da, bringst du die Karten mit?", icon: null, posted: startedAt - 20_000 },
      noticeShownAt: startedAt,
    }),
  },
  {
    id: "ringing",
    label: "Eingehender Anruf",
    expanded: false,
    lyrics: false,
    data: () => ({ ...EMPTY_DATA, call: { callId: "demo", state: "ringing", name: "Mama", number: "+49 170 1234567", photo: null, canAnswer: true, canDecline: true } }),
  },
  {
    id: "call",
    label: "Laufender Anruf",
    expanded: false,
    lyrics: false,
    data: (startedAt) => ({
      ...EMPTY_DATA,
      call: { callId: "demo", state: "active", name: "Mama", number: "+49 170 1234567", photo: null, canAnswer: false, canDecline: true },
      callSince: startedAt - 83_000,
    }),
  },
  {
    id: "aiThinking",
    label: "KI denkt",
    expanded: false,
    lyrics: false,
    data: () => ({ ...EMPTY_DATA, ai: { state: "thinking", level: 0 }, aiNote: { reply: "", task: "Sucht in Downloads" } }),
  },
  {
    id: "aiReply",
    label: "KI antwortet",
    expanded: true,
    lyrics: false,
    data: () => ({
      ...EMPTY_DATA,
      ai: { state: "completed", level: 0 },
      aiNote: { reply: "Der Download ist in etwa 12 Minuten fertig: 8,4 von 31 GB sind da.", task: null },
      aiReplyShown: true,
    }),
  },
  {
    id: "system",
    label: "System",
    expanded: true,
    lyrics: false,
    data: (startedAt) => ({
      ...EMPTY_DATA,
      load: {
        hottest: { label: "CPU", celsius: 58, maxCelsius: null, criticalCelsius: null },
        snapshot: {
          timestampMs: startedAt,
          cpuUsage: 23,
          cpuPerCore: [],
          cpuFrequencyMhz: null,
          memoryUsed: 9.4 * GIB,
          memoryTotal: 16 * GIB,
          swapUsed: 0,
          swapTotal: 0,
          uptimeSeconds: null,
          gpus: [{ name: "GPU", vendor: null, usage: 41, memoryUsed: null, memoryTotal: null }],
          network: { rxPerSec: 12_400_000, txPerSec: 860_000, totalRx: 0, totalTx: 0 },
        },
      },
    }),
  },
];

export function sceneById(id: SceneId): Scene {
  return SCENES.find((scene) => scene.id === id) ?? SCENES[0]!;
}

/** The module a scene needs switched on to be visible at all. */
export const SCENE_MODULE: Record<SceneId, "music" | "notifications" | "calls" | "ai" | "system" | null> = {
  idle: null,
  music: "music",
  lyrics: "music",
  notification: "notifications",
  ringing: "calls",
  call: "calls",
  aiThinking: "ai",
  aiReply: "ai",
  system: "system",
};
