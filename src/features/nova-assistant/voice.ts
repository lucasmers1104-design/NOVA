import { Channel } from "@tauri-apps/api/core";
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
  | { type: "noSpeech" }
  | { type: "error"; message: string; settings: "privacy-speech" | "privacy-microphone" | "speech" | null };

interface VoiceState {
  mode: "idle" | "listening" | "processing" | "speaking";
  /** Microphone level (listening) or speech activity (speaking), 0–1. */
  level: number;
  transcript: string;
  error: string | null;
  /** The Windows settings page that fixes `error`, if any. */
  errorSettings: "privacy-speech" | "privacy-microphone" | "speech" | null;
  setLevel: (level: number) => void;
}

export const useVoice = create<VoiceState>()((set) => ({
  mode: "idle",
  level: 0,
  transcript: "",
  error: null,
  errorSettings: null,
  setLevel: (level) => set({ level }),
}));

/**
 * Push-to-talk: opens the microphone until the user stops speaking (or calls
 * `stopListening`). Resolves with the recognized text, or null.
 */
export async function listen(onTranscript?: (text: string) => void): Promise<string | null> {
  stopSpeaking();
  useVoice.setState({ mode: "listening", level: 0, transcript: "", error: null, errorSettings: null });
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
        useVoice.setState({ error: "I didn't hear anything." });
        break;
      case "error":
        useVoice.setState({ error: event.message, errorSettings: event.settings });
        break;
      case "listening":
        break;
    }
  };
  try {
    await callNative("voice_listen", { onEvent: channel });
  } catch (error) {
    useVoice.setState({ error: error instanceof Error ? error.message : String(error) });
  }
  useVoice.setState({ mode: "idle", level: 0 });
  return result;
}

export function openVoiceSettings(page: NonNullable<VoiceState["errorSettings"]>): void {
  void callNative("voice_open_settings", { page }).catch(() => {});
}

export function stopListening(): void {
  void callNative("voice_stop").catch(() => {});
}

// ---------------------------------------------------------------------------
// Spoken replies (Windows voices through the webview's speech synthesis)
// ---------------------------------------------------------------------------

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

export function voices(): SpeechSynthesisVoice[] {
  return typeof speechSynthesis === "undefined" ? [] : speechSynthesis.getVoices();
}

const GERMAN = /\b(und|ich|nicht|der|die|das|ist|du|sie|mit|für|auf|eine?n?)\b|[äöüß]/i;

function pickVoice(text: string, preferred: string): SpeechSynthesisVoice | undefined {
  const all = voices();
  const chosen = preferred ? all.find((v) => v.name === preferred) : undefined;
  if (chosen) return chosen;
  const lang = GERMAN.test(text) ? "de" : "en";
  return all.find((v) => v.lang.toLowerCase().startsWith(lang) && v.localService) ?? all.find((v) => v.lang.toLowerCase().startsWith(lang)) ?? all.find((v) => v.default);
}

let decay: ReturnType<typeof setInterval> | null = null;

/** Reads `text` aloud. Resolves when finished or interrupted. */
export function speak(text: string, prefs: Pick<AgentPrefs, "voice" | "speechRate" | "speechVolume">): Promise<void> {
  const spoken = speakableText(text);
  if (!spoken || typeof speechSynthesis === "undefined") return Promise.resolve();
  stopSpeaking();
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
      if (decay) clearInterval(decay);
      decay = null;
      setSpeaking(false);
      useVoice.setState({ mode: "idle", level: 0 });
      resolve();
    };
    // Each word makes the visualizer jump; it settles between words.
    utterance.onboundary = () => useVoice.setState({ level: 0.6 + Math.random() * 0.4 });
    utterance.onstart = () => {
      setSpeaking(true);
      useVoice.setState({ mode: "speaking", level: 0.5, error: null });
      decay = setInterval(() => useVoice.setState((s) => ({ level: Math.max(0.12, s.level * 0.8) })), 80);
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    speechSynthesis.speak(utterance);
  });
}

export function stopSpeaking(): void {
  if (typeof speechSynthesis !== "undefined" && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
  if (decay) clearInterval(decay);
  decay = null;
  if (useVoice.getState().mode === "speaking") useVoice.setState({ mode: "idle", level: 0 });
}
