/** Screen corner the dot sits in; also the panel corner it grows out of. */
export type DotCorner = "bottomRight" | "bottomLeft" | "topRight" | "topLeft";
/** Where the dot lives until it is dragged: in the taskbar or a desktop corner. */
export type DotPlacement = "taskbar" | "corner";
export type DotStyle = "glass" | "orb" | "solid" | "ring";

/** Mirrors `DotLook` in src-tauri/src/assistant.rs. */
export interface DotLook {
  style: DotStyle;
  /** Logical px, 16–56. */
  diameter: number;
  /** Opacity at rest in percent (25–100); hovering or activity shows it fully. */
  idleOpacity: number;
  /** "accent", "white" or "#rrggbb". */
  color: string;
  glow: boolean;
  breathe: boolean;
  icon: boolean;
  activity: boolean;
  /** Gap to the screen edges in a corner (logical px, 0–48). */
  edgeGap: number;
}

export const DEFAULT_DOT_LOOK: DotLook = { style: "glass", diameter: 24, idleOpacity: 70, color: "accent", glow: false, breathe: false, icon: true, activity: true, edgeGap: 12 };

/** Mirrors `AssistantStatus` in src-tauri/src/assistant.rs. */
export interface AssistantStatus {
  enabled: boolean;
  placement: DotPlacement;
  corner: DotCorner;
  look: DotLook;
  /** The taskbar can host the dot (it doesn't hide itself). */
  taskbarAvailable: boolean;
  /** Global shortcut such as "Ctrl+Alt+Space"; empty means none. */
  shortcut: string;
  /** Keep NOVA running for the assistant when the main window is closed. */
  background: boolean;
  /** Hide the dot while a fullscreen app, game or presentation is in front. */
  hideInFullscreen: boolean;
  /** The dot sits where the user dragged it instead of in `corner`. */
  customPosition: boolean;
  /** Why the saved shortcut couldn't be registered (e.g. taken by another app). */
  shortcutError: string | null;
  defaultShortcut: string;
  panelOpen: boolean;
}

export type AssistantPrefsUpdate = Pick<AssistantStatus, "enabled" | "placement" | "corner" | "look" | "shortcut" | "background" | "hideInFullscreen">;

export interface DotView {
  look: DotLook;
  panelOpen: boolean;
}

/** "Hey NOVA" or a double clap opened the panel; mirrors `WakeCall` in assistant.rs. */
export interface WakeCall {
  source: "phrase" | "clap";
  /** Start listening for a spoken request. */
  listen: boolean;
  /** Play the wake sound. */
  chime: boolean;
  /** A game fills the screen: answer by voice, without the panel. */
  headless?: boolean;
  /** What was said right after the call: goes straight to NOVA AI, without a greeting. */
  request?: string | null;
}

export interface PanelView {
  open: boolean;
  origin: DotCorner;
  wake: WakeCall | null;
}

/** Everything NOVA AI can be doing; drives the dot, the header and the screen reader. */
export type AssistantState =
  | "idle"
  | "activating"
  | "listening"
  | "processing"
  | "thinking"
  | "searching"
  | "analyzingScreen"
  | "executing"
  | "speaking"
  | "completed"
  | "error";

export type Risk = "safe" | "confirm" | "high";

export interface FileHit {
  path: string;
  name: string;
  ext: string;
  folder: string;
  kind: string;
  size: number;
  modified: number;
  snippet: string | null;
}

export interface SavedDocument {
  path: string;
  name: string;
  folder: string;
  size: number;
  format: "pdf" | "md" | "txt" | "html";
}

export type ToolCard =
  | { kind: "files"; hits: FileHit[]; source: "index" | "live" }
  | { kind: "document"; document: SavedDocument }
  | { kind: "screenshot"; label: string; dataUrl: string }
  | { kind: "app"; name: string }
  | { kind: "path"; path: string }
  | { kind: "link"; url: string; title: string }
  | { kind: "productivity"; label: string; detail: string }
  | { kind: "freed"; bytes: number; items: { label: string; bytes: number }[]; freeNow: number };

/** Mirrors `AgentEvent` in src-tauri/src/agent/mod.rs. */
export type AgentEvent =
  | { type: "status"; state: "thinking" | "searching" | "analyzingScreen" | "executing" | "completed" | "error"; detail: string | null }
  | { type: "text"; text: string }
  | { type: "toolStarted"; id: string; name: string; title: string; risk: Risk }
  | { type: "confirmRequired"; id: string; title: string; detail: string | null; risk: Risk }
  | { type: "toolFinished"; id: string; ok: boolean; summary: string; card: ToolCard | null }
  | { type: "usage"; provider: string; model: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd: number | null }
  | { type: "done" }
  | { type: "failed"; error: string };

export interface AttachmentView {
  label: string;
  kind: "image" | "text";
  preview: string | null;
}

export interface CaptureTargets {
  screens: { index: number; label: string; primary: boolean; width: number; height: number; current: boolean }[];
  window: string | null;
}

export type CaptureTarget = { kind: "screen"; index: number } | { kind: "window" };

export type ProviderId = "anthropic" | "openai" | "gemini";

export interface AgentPrefs {
  provider: ProviderId | null;
  models: Partial<Record<ProviderId, string>>;
  effort: "low" | "medium" | "high";
  monthlyLimitUsd: number | null;
  speakReplies: boolean;
  voice: string;
  speechRate: number;
  speechVolume: number;
  language: string;
  /** The microphone opens again after a reply to a spoken request. */
  keepListening: boolean;
  /** Tools run without asking first, at the user's own risk. */
  autoMode: boolean;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  unpricedRequests: number;
}

/** Mirrors `AgentStatus` in src-tauri/src/agent/mod.rs. */
export interface AgentStatus {
  prefs: AgentPrefs;
  activeProvider: string | null;
  activeModel: string | null;
  keys: Record<ProviderId, boolean>;
  usageThisMonth: UsageTotals;
  running: boolean;
}

export interface ActionEntry {
  id: number;
  at: number;
  tool: string;
  title: string;
  risk: Risk;
  status: "done" | "failed" | "declined";
  detail: string;
}

export interface FinderStatus {
  folders: { path: string; files: number; exists: boolean }[];
  content: boolean;
  progress: { running: boolean; scanned: number; indexed: number; current: string | null; lastFinished: number | null; error: string | null };
}

export const ASSISTANT_EVENTS = {
  /** → panel: show yourself, growing out of `origin`. */
  expand: "assistant://expand",
  /** → panel: play the exit animation, then report `generation` back. */
  collapse: "assistant://collapse",
  /** → dot: the panel opened or closed. */
  panel: "assistant://panel",
  /** → dot: its size changed. */
  dot: "assistant://dot",
  /** → everyone: assistant preferences changed. */
  prefs: "assistant://prefs",
  /** main → assistant windows: accent, glass or motion changed. */
  appearance: "nova://appearance",
  /** → main: show a page (and settings section). */
  navigate: "nova://navigate",
  /** panel → dot: what NOVA AI is doing right now. */
  activity: "assistant://activity",
  /** → everyone: NOVA AI provider, voice or limit settings changed. */
  agent: "assistant://agent",
  /** → everyone: NOVA Finder indexing progress. */
  finder: "finder://progress",
  /** → panel (already open): "Hey NOVA" or a double clap. */
  wake: "assistant://wake",
  /** → everyone: wake listening status changed. */
  wakeStatus: "wake://status",
  /** → main: what the wake listener heard (only during a test). */
  wakeHeard: "wake://heard",
} as const;
