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
  noSuddenStart: "kein plötzlicher Anfang",
  tooLong: "hielt an, wie eine Stimme oder Musik",
  tooShort: "ein Klick, zu kurz für ein Klatschen",
  tooDull: "zu dumpf, wie ein Klopfen",
  tooMuffled: "zu gedämpft",
  tonal: "klang wie ein Ton oder ein Glas",
};

export const PAUSE_LABELS: Record<WakePause, string> = {
  muted: "Pausiert über das Menü des Punkts: Das Mikrofon ist aus",
  dictation: "Pausiert, solange du diktierst",
  speaking: "Pausiert, solange NOVA spricht",
  locked: "Pausiert, solange der PC gesperrt ist",
  fullscreen: "Pausiert, solange eine Präsentation oder Vollbild-App läuft",
};

/** One line describing a listener's state, for Settings. */
export function listenerLabel(listener: WakeListener): string {
  switch (listener.state) {
    case "off":
      return "Aus";
    case "starting":
      return "Startet …";
    case "listening":
      return "Hört zu";
    case "paused":
      return PAUSE_LABELS[listener.reason];
    case "unavailable":
      return listener.message;
  }
}

/** How sure Windows was about what it heard. */
const CONFIDENCE = { high: "sicher", medium: "mittel", low: "unsicher", rejected: "abgelehnt" } as const;

/** Describes a heard event for the test log in Settings, or null for events it doesn't list. */
export function describeHeard(heard: Heard): { text: string; tone: "good" | "muted" | "warn" } | null {
  switch (heard.kind) {
    case "level":
      return null;
    case "phrase":
      return heard.accepted
        ? { text: `„Hey NOVA“ gehört (${CONFIDENCE[heard.confidence]}): NOVA würde sich öffnen`, tone: "good" }
        : { text: `„${heard.text}“ gehört (${CONFIDENCE[heard.confidence]}): ignoriert`, tone: "muted" };
    case "clap":
      return { text: `Klatschen (${Math.round(heard.levelDb)} dB)`, tone: "muted" };
    case "notAClap":
      return { text: `Scharfes Geräusch, kein Klatschen: ${NOT_A_CLAP[heard.reason]}`, tone: "muted" };
    case "notADouble":
      return { text: heard.reason === "uneven" ? "Zweimal geklatscht, aber einmal viel lauter: ignoriert" : "Klatschen mit anderen Geräuschen drumherum: ignoriert", tone: "warn" };
    case "double":
      if (heard.veto === "typing") return { text: "Doppelklatschen beim Tippen oder Klicken: ignoriert", tone: "warn" };
      if (heard.veto === "speakers") return { text: "Doppelklatschen aus den Lautsprechern: ignoriert", tone: "warn" };
      if (heard.veto === "paused") return { text: "Doppelklatschen während einer Pause: ignoriert", tone: "warn" };
      return { text: "Doppelklatschen: NOVA würde sich öffnen", tone: "good" };
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
