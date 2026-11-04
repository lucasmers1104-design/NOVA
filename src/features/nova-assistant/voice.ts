import { Channel } from "@tauri-apps/api/core";
import { listen as listenTo } from "@tauri-apps/api/event";
import { create } from "zustand";
import { callNative } from "@/lib/native";
import type { AgentPrefs } from "./types";
import { setSpeaking } from "./wake";

/** Mirrors `VoiceEvent` in src-tauri/src/voice.rs. */
export type VoiceEvent =
  | { type: "listening"; language: string }
  | { type: "level"; value: number }
  | { type: "hypothesis"; text: string }
  | { type: "processing" }
  | { type: "result"; text: string }
  | { type: "noSpeech"; heard: boolean }
  | { type: "error"; message: string; settings: "privacy-speech" | "privacy-microphone" | "speech" | null };

/** Mirrors `VoiceInstall` in src-tauri/src/tts.rs: NOVA's own voice on this PC. */
export type NovaVoiceStatus = { state: "missing" } | { state: "downloading"; percent: number } | { state: "ready" } | { state: "failed"; message: string };

interface VoiceState {
  mode: "idle" | "listening" | "processing" | "speaking";
  /** The microphone is open (listening starts a moment after `mode` says so). */
  ready: boolean;
  /** Microphone level (listening) or speech activity (speaking), 0–1. */
  level: number;
  transcript: string;
  error: string | null;
  /** The Windows settings page that fixes `error`, if any. */
  errorSettings: "privacy-speech" | "privacy-microphone" | "speech" | null;
  /** NOVA's own voice: null until known. */
  novaVoice: NovaVoiceStatus | null;
  setLevel: (level: number) => void;
}

export const useVoice = create<VoiceState>()((set) => ({
  mode: "idle",
  ready: false,
  level: 0,
  transcript: "",
  error: null,
  errorSettings: null,
  novaVoice: null,
  setLevel: (level) => set({ level }),
}));

const NO_WORDS = {
  de: {
    heard: "Ich habe dich gehört, aber keine Wörter verstanden. Sprich etwas näher am Mikrofon und versuch es noch mal.",
    silent: "Ich habe nichts gehört. Ist in Windows das richtige Mikrofon als Standard eingestellt?",
  },
  en: {
    heard: "I heard you but couldn't make out any words. Move a little closer to the microphone and try again.",
    silent: "I didn't hear anything. Is the right microphone set as the default in Windows?",
  },
} as const;

/**
 * One spoken turn: opens the microphone until the user stops speaking (or
 * calls `stopListening`). Resolves with the recognized text, or null.
 */
export async function listen(german = false, onTranscript?: (text: string) => void): Promise<string | null> {
  stopSpeaking();
  useVoice.setState({ mode: "listening", ready: false, level: 0, transcript: "", error: null, errorSettings: null });
  let result: string | null = null;
  const channel = new Channel<VoiceEvent>();
  channel.onmessage = (event) => {
    switch (event.type) {
      case "level":
        useVoice.setState({ level: event.value });
        break;
      case "hypothesis":
        useVoice.setState({ transcript: event.text });
        onTranscript?.(event.text);
        break;
      case "processing":
        useVoice.setState({ mode: "processing", level: 0 });
        break;
      case "result":
        result = event.text;
        useVoice.setState({ transcript: event.text });
        break;
      case "noSpeech":
        useVoice.setState({ error: NO_WORDS[german ? "de" : "en"][event.heard ? "heard" : "silent"] });
        break;
      case "error":
        useVoice.setState({ error: event.message, errorSettings: event.settings });
        break;
      case "listening":
        useVoice.setState({ ready: true });
        break;
    }
  };
  try {
    await callNative("voice_listen", { onEvent: channel });
  } catch (error) {
    useVoice.setState({ error: error instanceof Error ? error.message : String(error) });
  }
  useVoice.setState({ mode: "idle", ready: false, level: 0 });
  return result;
}

export function openVoiceSettings(page: NonNullable<VoiceState["errorSettings"]>): void {
  void callNative("voice_open_settings", { page }).catch(() => {});
}

export function stopListening(): void {
  void callNative("voice_stop").catch(() => {});
}

// ---------------------------------------------------------------------------
// Spoken replies: NOVA's own voice (Thorsten, offline), or a Windows voice
// ---------------------------------------------------------------------------

/** The `voice` preference for NOVA's own voice. "" (automatic) also uses it for German. */
export const NOVA_VOICE = "nova:thorsten";

/** Markdown and symbols removed so replies read naturally. */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/(\*\*|__|\*|_)(.+?)\1/g, "$2")
    .replace(/[A-Za-z]:\\[^\s,;]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pieces NOVA's voice says one after another: whole sentences, very short
 * ones joined, very long ones cut at a comma (or a space), so the first one is
 * ready quickly.
 */
export function speechChunks(text: string, longest = 220): string[] {
  const chunks: string[] = [];
  for (const sentence of text.split(/(?<=[.!?…:;])\s+/)) {
    let rest = sentence.trim();
    while (rest.length > longest) {
      const cut = Math.max(rest.lastIndexOf(", ", longest), rest.lastIndexOf(" ", longest));
      const at = cut > longest / 3 ? cut + 1 : longest;
      chunks.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (!rest) continue;
    const last = chunks.length - 1;
    // Only very short sentences ride along with the one before; the first
    // piece stays on its own, so NOVA starts talking sooner. Each piece is
    // made while the one before plays.
    if (last > 0 && rest.length < 24 && chunks[last]!.length + rest.length < longest) chunks[last] += ` ${rest}`;
    else chunks.push(rest);
  }
  return chunks;
}

export function voices(): SpeechSynthesisVoice[] {
  return typeof speechSynthesis === "undefined" ? [] : speechSynthesis.getVoices();
}

const GERMAN = /\b(und|ich|nicht|der|die|das|ist|du|sie|mit|für|auf|eine?n?)\b|[äöüß]/i;

/** Whether NOVA's own voice says `text`: chosen, or automatic and the text is German. */
export function usesNovaVoice(text: string, preferred: string): boolean {
  return preferred === NOVA_VOICE || (preferred === "" && GERMAN.test(text));
}

function pickVoice(text: string, preferred: string): SpeechSynthesisVoice | undefined {
  const all = voices();
  const chosen = preferred ? all.find((v) => v.name === preferred) : undefined;
  if (chosen) return chosen;
  const lang = GERMAN.test(text) ? "de" : "en";
  return all.find((v) => v.lang.toLowerCase().startsWith(lang) && v.localService) ?? all.find((v) => v.lang.toLowerCase().startsWith(lang)) ?? all.find((v) => v.default);
}

/** Stops whatever NOVA says now; anything still queued sees a newer turn and ends. */
let turn = 0;
let decay: ReturnType<typeof setInterval> | null = null;
let playing: AudioBufferSourceNode | null = null;
let audio: AudioContext | null = null;

type SpeechPrefs = Pick<AgentPrefs, "voice" | "speechRate" | "speechVolume">;

/** Reads `text` aloud. Resolves when finished or interrupted. */
export async function speak(text: string, prefs: SpeechPrefs): Promise<void> {
  const spoken = speakableText(text);
  if (!spoken) return;
  stopSpeaking();
  const mine = ++turn;
  if (usesNovaVoice(spoken, prefs.voice)) {
    const status = useVoice.getState().novaVoice ?? (await refreshNovaVoice());
    if (mine !== turn) return;
    if (status?.state === "ready") {
      const rest = await speakWithNovaVoice(spoken, prefs, mine);
      if (rest === null || mine !== turn) return;
      // NOVA's voice failed part-way: a Windows voice says the rest.
      return speakWithWindows(rest, { ...prefs, voice: prefs.voice === NOVA_VOICE ? "" : prefs.voice });
    }
    if (status?.state === "missing") void installNovaVoice();
  }
  return speakWithWindows(spoken, prefs.voice === NOVA_VOICE ? { ...prefs, voice: "" } : prefs);
}

function began() {
  setSpeaking(true);
  useVoice.setState({ mode: "speaking", level: 0.5, error: null });
}

function ended() {
  if (decay) clearInterval(decay);
  decay = null;
  setSpeaking(false);
  useVoice.setState({ mode: "idle", level: 0 });
}

/** Says `spoken` sentence by sentence; resolves with what's left unsaid if the voice failed, else null. */
async function speakWithNovaVoice(spoken: string, prefs: SpeechPrefs, mine: number): Promise<string | null> {
  const chunks = speechChunks(spoken.slice(0, 4000));
  const synthesize = (chunk: string) => callNative<ArrayBuffer>("tts_speak", { text: chunk, rate: prefs.speechRate });
  audio ??= new AudioContext();
  const context = audio;
  await context.resume().catch(() => {});
  const gain = context.createGain();
  gain.gain.value = prefs.speechVolume;
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  gain.connect(analyser);
  analyser.connect(context.destination);
  const samples = new Uint8Array(analyser.fftSize);
  began();
  // The meter follows how loud the voice actually is.
  decay = setInterval(() => {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += ((s - 128) / 128) ** 2;
    useVoice.setState({ level: Math.min(1, Math.sqrt(sum / samples.length) * 4) });
  }, 70);
  try {
    // The next sentence is made while this one plays.
    let next = synthesize(chunks[0]!);
    for (let i = 0; i < chunks.length; i++) {
      let wav: ArrayBuffer;
      try {
        wav = await next;
      } catch {
        return mine === turn ? chunks.slice(i).join(" ") : null;
      }
      if (mine !== turn) return null;
      if (i + 1 < chunks.length) {
        next = synthesize(chunks[i + 1]!);
        next.catch(() => {});
      }
      const buffer = await context.decodeAudioData(wav);
      if (mine !== turn) return null;
      await new Promise<void>((resolve) => {
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(gain);
        source.onended = () => resolve();
        playing = source;
        source.start();
      });
      if (mine !== turn) return null;
    }
    return null;
  } finally {
    gain.disconnect();
    analyser.disconnect();
    if (mine === turn) {
      playing = null;
      ended();
    }
  }
}

function speakWithWindows(spoken: string, prefs: SpeechPrefs): Promise<void> {
  if (typeof speechSynthesis === "undefined") return Promise.resolve();
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(spoken.slice(0, 4000));
    const voice = pickVoice(spoken, prefs.voice);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.rate = prefs.speechRate;
    utterance.volume = prefs.speechVolume;
    const finish = () => {
      ended();
      resolve();
    };
    // Each word makes the visualizer jump; it settles between words.
    utterance.onboundary = () => useVoice.setState({ level: 0.6 + Math.random() * 0.4 });
    utterance.onstart = () => {
      began();
      decay = setInterval(() => useVoice.setState((s) => ({ level: Math.max(0.12, s.level * 0.8) })), 80);
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    speechSynthesis.speak(utterance);
  });
}

export function stopSpeaking(): void {
  turn++;
  if (typeof speechSynthesis !== "undefined" && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
  if (playing) {
    playing.onended = null;
    try {
      playing.stop();
    } catch {
      // Already finished.
    }
    playing = null;
  }
  if (decay) clearInterval(decay);
  decay = null;
  if (useVoice.getState().mode === "speaking") {
    setSpeaking(false);
    useVoice.setState({ mode: "idle", level: 0 });
  }
}

// ---------------------------------------------------------------------------
// NOVA's own voice: downloaded once
// ---------------------------------------------------------------------------

export async function refreshNovaVoice(): Promise<NovaVoiceStatus | null> {
  try {
    const status = await callNative<NovaVoiceStatus>("tts_status");
    useVoice.setState({ novaVoice: status });
    return status;
  } catch {
    return null;
  }
}

/** Starts downloading NOVA's voice (if it isn't there or coming already). */
export async function installNovaVoice(): Promise<void> {
  try {
    useVoice.setState({ novaVoice: await callNative<NovaVoiceStatus>("tts_install") });
  } catch (error) {
    useVoice.setState({ novaVoice: { state: "failed", message: error instanceof Error ? error.message : String(error) } });
  }
}

/** Keeps `useVoice().novaVoice` current; returns the unsubscribe function. */
export function watchNovaVoice(): () => void {
  void refreshNovaVoice();
  const stop = listenTo<NovaVoiceStatus>("tts://status", (event) => useVoice.setState({ novaVoice: event.payload }));
  return () => void stop.then((unlisten) => unlisten()).catch(() => {});
}

// ---------------------------------------------------------------------------
// What NOVA says around a spoken turn
// ---------------------------------------------------------------------------

const LINES = {
  de: {
    greet: ["Hey! Was kann ich für dich tun?", "Ich bin da. Was liegt an?", "Was kann ich heute für dich tun?", "Hi! Womit kann ich dir helfen?", "Schön, dich zu hören. Was brauchst du?"],
    ack: ["Alles klar, ich schau mir das direkt an. Einen Moment.", "Geht klar, ich kümmere mich drum.", "Okay, gib mir einen kurzen Moment.", "Mach ich, das ist gleich fertig.", "Alles klar, einen Moment bitte."],
  },
  en: {
    greet: ["Hey! What can I do for you?", "I'm here. What's up?", "What can I do for you today?", "Hi! How can I help?", "Good to hear you. What do you need?"],
    ack: ["On it, give me a moment.", "Sure, I'll take care of that.", "Okay, one moment please.", "Got it, this will be ready in a second.", "Alright, let me look into that."],
  },
} as const;

/** German when NOVA listens in German (or "auto" on a German system). */
export function speaksGerman(language: string, systemLanguage = typeof navigator === "undefined" ? "en" : navigator.language): boolean {
  return language.toLowerCase().startsWith("de") || (language === "auto" && systemLanguage.toLowerCase().startsWith("de"));
}

/** A friendly line: a greeting after waking, or an acknowledgement once a spoken request is sent. */
export function voiceLine(kind: "greet" | "ack", language: string, random = Math.random): string {
  const lines = LINES[speaksGerman(language) ? "de" : "en"][kind];
  return lines[Math.floor(random() * lines.length) % lines.length]!;
}
