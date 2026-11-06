import { Channel } from "@tauri-apps/api/core";
import { listen as listenTo } from "@tauri-apps/api/event";
import { create } from "zustand";
import { callNative } from "@/lib/native";
import { normalizeGerman } from "./speech/normalize.de";
import { type ReplySpeaker, type SpeakerHooks, StreamingSpeaker, WindowsSpeaker } from "./speech/streamingSpeaker";
import { addTime, count, mark, note } from "./speech/timings";
import type { AgentPrefs } from "./types";
import { setSpeaking } from "./wake";

/** Mirrors `VoiceEvent` in src-tauri/src/voice.rs. */
export type VoiceEvent =
  | { type: "listening"; language: string }
  | { type: "level"; value: number }
  | { type: "hypothesis"; text: string }
  | { type: "processing" }
  | { type: "result"; text: string }
  | { type: "noSpeech"; heard: boolean; switching: boolean }
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
  /** What NOVA just said around a spoken turn (a greeting, "one moment"), shown in the panel. */
  line: string | null;
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
  line: null,
  setLevel: (level) => set({ level }),
}));

const NO_WORDS = {
  de: {
    heard: "Ich habe dich gehört, aber keine Wörter verstanden. Sprich etwas näher am Mikrofon und versuch es noch mal.",
    silent: "Ich habe nichts gehört. Ist in Windows das richtige Mikrofon als Standard eingestellt?",
    switching: "Die Windows-Spracherkennung hört dich, liefert aber keine Wörter. Ich lade jetzt meine eigene Offline-Erkennung (etwa 670 MB) und nutze sie, sobald sie fertig ist. Den Fortschritt siehst du unter Einstellungen → Local AI & performance.",
  },
  en: {
    heard: "I heard you but couldn't make out any words. Move a little closer to the microphone and try again.",
    silent: "I didn't hear anything. Is the right microphone set as the default in Windows?",
    switching: "Windows speech recognition hears you but returns no words. I'm downloading my own offline recognizer (about 670 MB) and will use it once it's ready. You can follow the progress in Settings → Local AI & performance.",
  },
} as const;

/**
 * One spoken turn: opens the microphone until the user stops speaking (or
 * calls `stopListening`). Resolves with the recognized text, or null.
 */
export async function listen(german = false, onTranscript?: (text: string) => void): Promise<string | null> {
  stopSpeaking();
  mark("listenCall");
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
        mark("speechEnd");
        useVoice.setState({ mode: "processing", level: 0 });
        break;
      case "result":
        mark("sttResult");
        result = event.text;
        useVoice.setState({ transcript: event.text });
        break;
      case "noSpeech":
        useVoice.setState({ error: NO_WORDS[german ? "de" : "en"][event.switching ? "switching" : event.heard ? "heard" : "silent"] });
        break;
      case "error":
        useVoice.setState({ error: event.message, errorSettings: event.settings });
        break;
      case "listening":
        mark("micReady");
        // Also back from "processing": Windows may have given up and the offline recognizer took over.
        useVoice.setState({ mode: "listening", ready: true });
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

/** `discard`: cancelled or closed, so nothing said so far is sent or complained about. */
export function stopListening(discard = false): void {
  void callNative("voice_stop", { discard }).catch(() => {});
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
    // "1. Foo" in a list is read "1: Foo", not as a sentence end.
    .replace(/^\s*(\d{1,3})[.)]\s+/gm, "$1: ")
    .replace(/(\*\*|__|\*|_)(.+?)\1/g, "$2")
    .replace(/[A-Za-z]:\\[^\s,;]+/g, "")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
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

const GERMAN = /\b(und|ich|nicht|der|die|das|ist|du|sie|mit|für|auf|eine?n?|dir|mir|dich|mich|bin|bist|kann|womit|hallo|moment|klar|geht|mach|bitte|danke|nein|gerne?|heute|wird|sind|hast|haben)\b|[äöüß]/i;
const ENGLISH = /\b(the|and|you|is|are|what|this|that|with|for|of|it|can|sure|got)\b/i;

/**
 * Whether NOVA's own (German) voice says `text`: chosen, or automatic and
 * the text is German — or, when NOVA talks German (`german`), the text is
 * at least not recognizably English ("Geht klar." has no telltale word).
 */
export function usesNovaVoice(text: string, preferred: string, german = false): boolean {
  if (preferred.startsWith("nova:")) return true;
  if (preferred !== "") return false;
  return GERMAN.test(text) || (german && !ENGLISH.test(text));
}

function pickVoice(text: string, preferred: string): SpeechSynthesisVoice | undefined {
  const all = voices();
  const chosen = preferred ? all.find((v) => v.name === preferred) : undefined;
  if (chosen) return chosen;
  const lang = GERMAN.test(text) ? "de" : "en";
  return all.find((v) => v.lang.toLowerCase().startsWith(lang) && v.localService) ?? all.find((v) => v.lang.toLowerCase().startsWith(lang)) ?? all.find((v) => v.default);
}

/**
 * What speaks now; anything still queued sees a newer turn and ends. Turn
 * numbers start at the clock so they keep growing across panel reloads (the
 * backend remembers which turns were stopped).
 */
let turn = Date.now();
let active: ReplySpeaker | null = null;
let audio: AudioContext | null = null;
/** A reply being spoken while it streams in (see speech/director.ts). */
let activeReply: { cancel: () => void } | null = null;

type SpeechPrefs = Pick<AgentPrefs, "voice" | "speechRate" | "speechVolume">;

/** NOVA's fixed lines (greetings, "one moment") made ahead, so they play at once. */
const madeAhead = new Map<string, ArrayBuffer>();
const aheadKey = (voice: string, text: string, rate: number) => `${voice}|${rate}|${text}`;

/** The NOVA voice id used for `preferred` ("" = automatic → Thorsten). */
function novaVoiceId(preferred: string): string {
  return preferred.startsWith("nova:") ? preferred : NOVA_VOICE;
}

function synthesizeChunk(text: string, rate: number, voice: string): Promise<ArrayBuffer> {
  const ready = madeAhead.get(aheadKey(voice, text, rate));
  // Playing detaches the buffer: hand out a copy.
  return ready ? Promise.resolve(ready.slice(0)) : callNative<ArrayBuffer>("tts_speak", { text, rate, voice, turn });
}

/**
 * Makes NOVA's fixed lines (greetings, "one moment", …) ahead of time, and
 * keeps its voice warm. `busy`: a reply is on its way; it goes first.
 */
export async function prepareNovaLines(language: string, rate: number, preferred = "", busy: () => boolean = () => false): Promise<void> {
  const voice = novaVoiceId(preferred);
  const lines = LINES[speaksGerman(language) ? "de" : "en"];
  for (const line of [...lines.greet, ...lines.ack, ...lines.confirm, ...lines.failed, ...lines.code]) {
    for (const chunk of speechChunks(normalizeGerman(speakableText(line)))) {
      const key = aheadKey(voice, chunk, rate);
      if (madeAhead.has(key)) continue;
      while (speechActive() || busy()) await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        madeAhead.set(key, await callNative<ArrayBuffer>("tts_speak", { text: chunk, rate, voice }));
      } catch {
        return;
      }
    }
  }
}

/**
 * Keeps "Hey NOVA" and the clap detector paused while NOVA speaks: renewed
 * while a long reply plays, let go a few seconds after the audio runs out (a
 * reply waiting for a tool or a confirmation) or right at the end.
 */
class SpeakingLease {
  private held = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private letGo: ReturnType<typeof setTimeout> | null = null;

  hold() {
    if (this.letGo) clearTimeout(this.letGo);
    this.letGo = null;
    if (this.held) return;
    this.held = true;
    setSpeaking(true);
    this.heartbeat = setInterval(() => setSpeaking(true), 30_000);
  }

  /** Lets go after `afterMs` unless audio comes back first. */
  release(afterMs = 0) {
    if (!this.held) return;
    if (this.letGo) clearTimeout(this.letGo);
    const go = () => {
      this.letGo = null;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      this.held = false;
      setSpeaking(false);
    };
    if (afterMs > 0) this.letGo = setTimeout(go, afterMs);
    else go();
  }
}

const lease = new SpeakingLease();

export interface ReplySpeakerOptions {
  /** Names the pieces in the turn timings ("reply", "greet", …). */
  label?: string;
  /** NOVA talks German now (its language setting). */
  german?: boolean;
  /** Pieces that go through `onPiece` (for shown lines and timings). */
  onPiece?: (tag: string, text: string, delayMs: number) => void;
}

/**
 * A speaker for one reply, chosen for its first piece: NOVA's own voice when
 * it is picked (or automatic and the text is German) and downloaded, else a
 * Windows voice. If NOVA's voice fails part-way, a Windows voice says the rest.
 */
export function createReplySpeaker(sample: string, prefs: SpeechPrefs, options: ReplySpeakerOptions = {}): { speaker: ReplySpeaker; nova: boolean } {
  const label = options.label ?? "reply";
  let fallback: ReplySpeaker | null = null;
  const hooks: SpeakerHooks = {
    onAudio: (playing) => {
      if (playing) {
        lease.hold();
        useVoice.setState({ mode: "speaking", level: 0.5, error: null });
      } else {
        // Waiting for more of the reply (a tool, a confirmation) lets the wake listener back in after a while.
        lease.release(8_000);
        if (useVoice.getState().mode === "speaking") useVoice.setState({ mode: "idle", level: 0 });
      }
    },
    onFirstAudio: () => mark(`${label}FirstAudio`),
    onLevel: (level) => useVoice.setState({ level }),
    onGap: (ms) => addTime("audioGapMs", ms),
    onPiece: (tag, text, delayMs) => {
      count("pieces");
      options.onPiece?.(tag, text, delayMs);
    },
  };
  const windows = (text: string, more: SpeakerHooks = hooks) =>
    new WindowsSpeaker((utterance) => {
      const voice = pickVoice(text, prefs.voice.startsWith("nova:") ? "" : prefs.voice);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      utterance.rate = prefs.speechRate;
      utterance.volume = prefs.speechVolume;
    }, more);

  const status = useVoice.getState().novaVoice;
  const wantsNova = usesNovaVoice(sample, prefs.voice, options.german);
  if (wantsNova && status?.state === "missing") void installNovaVoice();
  if (!wantsNova || status?.state !== "ready") {
    note("voice", "windows");
    return { speaker: windows(sample), nova: false };
  }
  const voice = novaVoiceId(prefs.voice);
  note("voice", voice);
  audio ??= new AudioContext();
  const context = audio;
  void context.resume().catch(() => {});
  const nova = new StreamingSpeaker(
    {
      synth: (text) => {
        const started = performance.now();
        return synthesizeChunk(text, prefs.speechRate, voice).then((wav) => {
          addTime("synthMs", performance.now() - started);
          return wav;
        });
      },
      cached: (text) => madeAhead.get(aheadKey(voice, text, prefs.speechRate))?.slice(0) ?? null,
      context: () => context,
    },
    prefs.speechVolume,
    {
      ...hooks,
      onFailed: (unsaid) => {
        count("voiceFailures");
        fallback ??= windows(unsaid.join(" "));
        for (const text of unsaid) fallback.enqueue(text);
      },
    },
  );
  // One object for the caller: the fallback takes over once NOVA's voice failed.
  const speaker: ReplySpeaker = {
    enqueue: (text, opts) => (fallback ? fallback.enqueue(text, opts) : nova.enqueue(text, opts)),
    finish: async () => {
      await nova.finish();
      if (fallback) await fallback.finish();
    },
    cancel: () => {
      nova.cancel();
      fallback?.cancel();
    },
    get busy() {
      return nova.busy || (fallback?.busy ?? false);
    },
  };
  return { speaker, nova: true };
}

/**
 * Reads `text` aloud. Resolves when finished or interrupted. `label` names
 * it in the turn timings; `german`: NOVA talks German now.
 */
export async function speak(text: string, prefs: SpeechPrefs, label = "reply", german = false): Promise<void> {
  const spoken = speakableText(text);
  if (!spoken) return;
  stopSpeaking();
  const mine = ++turn;
  mark(`${label}SpeakCall`);
  const { speaker, nova } = createReplySpeaker(spoken, prefs, { label, german });
  active = speaker;
  for (const chunk of speechChunks(nova ? normalizeGerman(spoken) : spoken)) speaker.enqueue(chunk);
  await speaker.finish();
  if (mine !== turn) return;
  active = null;
  lease.release();
  mark(`${label}End`);
  if (useVoice.getState().mode === "speaking") useVoice.setState({ mode: "idle", level: 0 });
}

/** The reply director registers what it is speaking, so `stopSpeaking` reaches it. */
export function setActiveReply(reply: { cancel: () => void } | null): void {
  activeReply = reply;
}

/** Called by the director when a reply has been said completely. */
export function replySpoken(): void {
  lease.release();
}

/**
 * Whether `text` can be said right away: a Windows voice can, NOVA's voice
 * only once the line was made ahead (otherwise it would hold up the reply).
 */
export function lineReady(text: string, prefs: SpeechPrefs): boolean {
  const spoken = speakableText(text);
  if (!usesNovaVoice(spoken, prefs.voice) || useVoice.getState().novaVoice?.state !== "ready") return true;
  const voice = novaVoiceId(prefs.voice);
  return speechChunks(normalizeGerman(spoken)).every((chunk) => madeAhead.has(aheadKey(voice, chunk, prefs.speechRate)));
}

/** Something is being said, or a reply is still being spoken as it arrives. */
export function speechActive(): boolean {
  return activeReply !== null || (active?.busy ?? false) || useVoice.getState().mode === "speaking";
}

/** A new turn number; work for older turns is dropped. */
export function nextSpeechTurn(): number {
  return ++turn;
}

export function speechTurn(): number {
  return turn;
}

/** Stops whatever NOVA says now, including a reply still streaming in. */
export function stopSpeaking(): void {
  const stopped = turn;
  turn++;
  void callNative("tts_cancel", { turn: stopped }).catch(() => {});
  if (typeof speechSynthesis !== "undefined" && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
  active?.cancel();
  active = null;
  const reply = activeReply;
  activeReply = null;
  reply?.cancel();
  lease.release();
  if (useVoice.getState().mode === "speaking") useVoice.setState({ mode: "idle", level: 0 });
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
    // Short: they only play when the answer takes a moment, and the answer waits until they are said.
    ack: ["Einen Moment.", "Alles klar, Moment.", "Mach ich.", "Okay, Moment.", "Geht klar."],
    confirm: ["Bitte bestätige das kurz im Fenster."],
    failed: ["Da ist leider etwas schiefgegangen."],
    code: ["Den Code findest du im Chat."],
  },
  en: {
    greet: ["Hey! What can I do for you?", "I'm here. What's up?", "What can I do for you today?", "Hi! How can I help?", "Good to hear you. What do you need?"],
    ack: ["One moment.", "On it.", "Sure, one sec.", "Okay, one moment.", "Got it."],
    confirm: ["Please confirm that in the window."],
    failed: ["Sorry, something went wrong."],
    code: ["You'll find the code in the chat."],
  },
} as const;

/** German when NOVA listens in German (or "auto" on a German system). */
export function speaksGerman(language: string, systemLanguage = typeof navigator === "undefined" ? "en" : navigator.language): boolean {
  return language.toLowerCase().startsWith("de") || (language === "auto" && systemLanguage.toLowerCase().startsWith("de"));
}

/**
 * A line NOVA says around a spoken turn: a greeting after waking, an
 * acknowledgement once a spoken request is sent, a request to confirm, a
 * failure, or a pointer to code it won't read out.
 */
export function voiceLine(kind: keyof (typeof LINES)["de"], language: string, random = Math.random): string {
  const lines = LINES[speaksGerman(language) ? "de" : "en"][kind];
  return lines[Math.floor(random() * lines.length) % lines.length]!;
}
