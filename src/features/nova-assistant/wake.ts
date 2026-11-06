import { callNative } from "@/lib/native";

/** Mirrors the wake types in src-tauri/src/wake/mod.rs. */
export type WakeSensitivity = "strict" | "normal";
export type AfterWake = "listen" | "open";

export interface WakePrefs {
  /** Wake on "Hey NOVA". */
  phrase: boolean;
  phraseSensitivity: WakeSensitivity;
  /** Wake on a double clap. */
  clap: boolean;
  clapSensitivity: WakeSensitivity;
  afterWake: AfterWake;
  /** A short sound when NOVA wakes. */
  chime: boolean;
  /** Keep listening in games and fullscreen apps: NOVA answers by voice, without its window. */
  inGames: boolean;
  /** Paused from the dot's menu: the microphone is closed until resumed. */
  muted: boolean;
}

export type WakePause = "muted" | "dictation" | "speaking" | "locked" | "fullscreen";
export type SettingsPage = "privacy-speech" | "privacy-microphone" | "speech";

export type WakeListener =
  | { state: "off" }
  | { state: "starting" }
  | { state: "listening" }
  | { state: "paused"; reason: WakePause }
  | { state: "unavailable"; message: string; settings: SettingsPage | null };

export interface WakeStatus {
  prefs: WakePrefs;
  phrase: WakeListener;
  clap: WakeListener;
  /** Listening after waking needs Windows' online speech recognition. */
  dictation: boolean;
  testing: boolean;
}

export type NotAClap = "noSuddenStart" | "tooLong" | "tooShort" | "tooDull" | "tooMuffled" | "tonal";

/** What the wake listener heard; only sent while a test runs in Settings. */
export type Heard =
  | { kind: "level"; value: number }
  | { kind: "phrase"; text: string; confidence: "high" | "medium" | "low" | "rejected"; accepted: boolean }
  | { kind: "clap"; levelDb: number }
  | { kind: "notAClap"; levelDb: number; reason: NotAClap }
  | { kind: "notADouble"; reason: "uneven" | "notQuiet" }
  | { kind: "double"; veto: "typing" | "speakers" | "paused" | null };

export const wakeStatus = () => callNative<WakeStatus>("wake_status");
export const configureWake = (prefs: WakePrefs) => callNative<WakeStatus>("wake_configure", { prefs });
/** Shows what NOVA hears for two minutes; nothing opens meanwhile. */
export const testWake = (on: boolean) => callNative<WakeStatus>("wake_test", { on });
/** NOVA's own voice must not wake it. */
export const setSpeaking = (speaking: boolean) => void callNative<void>("wake_set_speaking", { speaking }).catch(() => {});

export const NOT_A_CLAP: Record<NotAClap, string> = {
  noSuddenStart: "didn't start suddenly",
  tooLong: "kept going, like a voice or music",
  tooShort: "a click, too short for a clap",
  tooDull: "too dull, like a knock",
  tooMuffled: "too muffled",
  tonal: "rang like a tone or a glass",
};

export const PAUSE_LABELS: Record<WakePause, string> = {
  muted: "Paused from the dot's menu — the microphone is off",
  dictation: "Paused while you dictate",
  speaking: "Paused while NOVA speaks",
  locked: "Paused while the PC is locked",
  fullscreen: "Paused while a presentation or fullscreen app runs",
};

/** One line describing a listener's state. */
export function listenerLabel(listener: WakeListener): string {
  switch (listener.state) {
    case "off":
      return "Off";
    case "starting":
      return "Starting…";
    case "listening":
      return "Listening";
    case "paused":
      return PAUSE_LABELS[listener.reason];
    case "unavailable":
      return listener.message;
  }
}

/** Describes a heard event for the test log, or null for events it doesn't list. */
export function describeHeard(heard: Heard): { text: string; tone: "good" | "muted" | "warn" } | null {
  switch (heard.kind) {
    case "level":
      return null;
    case "phrase":
      return heard.accepted
        ? { text: `Heard “Hey NOVA” (${heard.confidence} confidence) — NOVA would open`, tone: "good" }
        : { text: `Heard “${heard.text}” (${heard.confidence}) — ignored`, tone: "muted" };
    case "clap":
      return { text: `Clap (${Math.round(heard.levelDb)} dB)`, tone: "muted" };
    case "notAClap":
      return { text: `Sharp sound, not a clap: ${NOT_A_CLAP[heard.reason]}`, tone: "muted" };
    case "notADouble":
      return { text: heard.reason === "uneven" ? "Two claps, but one was much louder — ignored" : "Claps with other sound around them — ignored", tone: "warn" };
    case "double":
      if (heard.veto === "typing") return { text: "Double clap while typing or clicking — ignored", tone: "warn" };
      if (heard.veto === "speakers") return { text: "Double clap from the speakers — ignored", tone: "warn" };
      if (heard.veto === "paused") return { text: "Double clap while paused — ignored", tone: "warn" };
      return { text: "Double clap — NOVA would open", tone: "good" };
  }
}

/** A soft two-note chime, synthesized (no sound file). Resolves when it has faded. */
export function playChime(volume = 0.16): Promise<void> {
  const Context = typeof window === "undefined" ? undefined : window.AudioContext;
  if (!Context) return Promise.resolve();
  const audio = new Context();
  const start = audio.currentTime + 0.02;
  for (const [frequency, delay] of [
    [784, 0],
    [1175, 0.1],
  ] as const) {
    const tone = audio.createOscillator();
    const gain = audio.createGain();
    tone.type = "sine";
    tone.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start + delay);
    gain.gain.linearRampToValueAtTime(volume, start + delay + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + delay + 0.32);
    tone.connect(gain).connect(audio.destination);
    tone.start(start + delay);
    tone.stop(start + delay + 0.35);
  }
  return new Promise((resolve) =>
    setTimeout(() => {
      void audio.close();
      resolve();
    }, 480),
  );
}
