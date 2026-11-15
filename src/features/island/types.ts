import type { AssistantState } from "@/features/nova-assistant/types";

/** Mirrors `IslandTheme` and friends in src-tauri/src/island.rs. */
export type IslandTheme = "black" | "white" | "glass" | "custom";
export type IslandMode = "dotAndIsland" | "islandOnly";
export type IslandAnchor = "left" | "center" | "right";
export type IslandBorder = "off" | "fine" | "glow";
export type IslandMotionStyle = "springy" | "soft" | "minimal";

export interface IslandModules {
  music: boolean;
  notifications: boolean;
  calls: boolean;
  system: boolean;
  ai: boolean;
}

export type ModuleKey = keyof IslandModules;

/** What the closed pill can carry at its left and right end. */
export type SlotItem = "cover" | "visualizer" | "appIcon" | "clock" | "remaining" | "progress" | "aiStatus" | "none";

/** The states that have side slots of their own (the island's content kinds). */
export type SlotState = "music" | "call" | "ai" | "notification" | "system";

export interface SlotPair {
  left: SlotItem;
  right: SlotItem;
}

export type IslandSlots = Record<SlotState, SlotPair>;

/** The pill's shape and material. Whole numbers only, so Rust can clamp and compare them exactly. */
export interface IslandLook {
  /** Size in percent (replaces small / medium / large). */
  scale: number;
  /** Corner radius of the closed pill (px); the opened island adds 8. */
  radius: number;
  /** Height of the closed pill (px). */
  closedHeight: number;
  /** The material below applies with the theme "custom". */
  background: string;
  /** Opacity of the background in percent. */
  opacity: number;
  /** How matt the pane is, in percent: a veil over the glass (Windows can't blur what lies behind a transparent window). */
  frost: number;
  border: IslandBorder;
  /** Shadow strength in percent. */
  shadow: number;
  /** Colors the visualizer, progress and NOVA AI's glow; `null` follows NOVA's accent. */
  accent: string | null;
}

export interface IslandMotion {
  style: IslandMotionStyle;
  /** Tempo in percent: 200 is twice as fast. */
  speed: number;
}

/** A look to come back to: everything a preset card applies. */
export interface IslandPreset {
  id: string;
  name: string;
  theme: IslandTheme;
  look: IslandLook;
  motion: IslandMotion;
  slots: IslandSlots;
}

export interface IslandPrefs {
  enabled: boolean;
  theme: IslandTheme;
  mode: IslandMode;
  dotInIsland: boolean;
  anchor: IslandAnchor;
  /** Shift along the top edge from the anchor (px, right is positive). */
  offset: number;
  monitor: string | null;
  look: IslandLook;
  motion: IslandMotion;
  slots: IslandSlots;
  /** Who leads when several things happen at once, best first. Always all five modules. */
  order: ModuleKey[];
  /** A call leads whatever `order` says, and a ringing one is shown alone. */
  callsFirst: boolean;
  autoMinimize: boolean;
  minimizeAfter: number;
  notificationSeconds: number;
  hideInFullscreen: boolean;
  modules: IslandModules;
  hidePreviews: boolean;
  showCallerNumber: boolean;
  /** The user's own presets (the curated ones live in presets.ts). */
  presets: IslandPreset[];
}

/** The same limits as `IslandPrefs::sanitized` in island.rs. */
export const LIMITS = {
  scale: { min: 80, max: 130 },
  radius: { min: 6, max: 30 },
  closedHeight: { min: 30, max: 46 },
  opacity: { min: 30, max: 100 },
  frost: { min: 0, max: 100 },
  shadow: { min: 0, max: 100 },
  speed: { min: 50, max: 200 },
  offset: { min: -600, max: 600 },
  minimizeAfter: { min: 3, max: 30 },
  notificationSeconds: { min: 3, max: 30 },
  presets: 12,
  presetName: 40,
} as const;

export const DEFAULT_ORDER: readonly ModuleKey[] = ["calls", "ai", "notifications", "music", "system"];

export const DEFAULT_SLOTS: IslandSlots = {
  music: { left: "cover", right: "visualizer" },
  call: { left: "appIcon", right: "remaining" },
  ai: { left: "aiStatus", right: "none" },
  notification: { left: "appIcon", right: "none" },
  system: { left: "none", right: "none" },
};

export const DEFAULT_LOOK: IslandLook = {
  scale: 100,
  radius: 22,
  closedHeight: 38,
  background: "#000000",
  opacity: 100,
  frost: 40,
  border: "fine",
  shadow: 60,
  accent: null,
};

export const DEFAULT_MOTION: IslandMotion = { style: "springy", speed: 100 };

/** Kept equal to `IslandPrefs::default()` in Rust by default-prefs.json, which both sides test against. */
export const DEFAULT_ISLAND_PREFS: IslandPrefs = {
  enabled: true,
  theme: "black",
  mode: "dotAndIsland",
  dotInIsland: true,
  anchor: "center",
  offset: 0,
  monitor: null,
  look: DEFAULT_LOOK,
  motion: DEFAULT_MOTION,
  slots: DEFAULT_SLOTS,
  order: [...DEFAULT_ORDER],
  callsFirst: true,
  autoMinimize: true,
  minimizeAfter: 6,
  notificationSeconds: 8,
  hideInFullscreen: true,
  modules: { music: true, notifications: true, calls: true, system: false, ai: true },
  hidePreviews: false,
  showCallerNumber: true,
  presets: [],
};

/** A notification forwarded by the phone; mirrors `PhoneNotice`. */
export interface PhoneNotice {
  notifId: string;
  app: string;
  appName: string;
  title: string;
  text: string;
  /** The app's logo as a `data:image/png|webp;base64,` URL (checked in Rust), or null. */
  icon: string | null;
  posted: number;
}

export type CallState = "ringing" | "active" | "ended";

/** A call on the phone; mirrors `PhoneCallView`. */
export interface PhoneCall {
  callId: string;
  state: CallState;
  name: string | null;
  number: string | null;
  photo: string | null;
  canAnswer: boolean;
  canDecline: boolean;
}

export type PhoneEvent = ({ kind: "notification" } & PhoneNotice) | ({ kind: "call" } & PhoneCall);

/** What `island_ready` hands the island's page. */
export interface IslandBoot {
  prefs: IslandPrefs;
  calls: PhoneCall[];
}

/** A connected display, for choosing where the island lives; mirrors `MonitorInfo`. */
export interface MonitorInfo {
  name: string;
  primary: boolean;
  /** Position and size on the virtual desktop (physical px). */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface IslandStatus {
  prefs: IslandPrefs;
  /** The primary display first. */
  monitors: MonitorInfo[];
  running: boolean;
}

/** What the panel tells the island about NOVA AI, besides the dot's activity. */
export interface AiNote {
  /** The latest reply, shortened; empty while none. */
  reply: string;
  /** The step NOVA is working on right now. */
  task: string | null;
}

export interface AiActivity {
  state: AssistantState;
  level: number;
}

/** The scenes Island Studio can play, on its stage and (briefly) on the real island. Mirrors `PreviewScene`. */
export type SceneId = "idle" | "music" | "lyrics" | "notification" | "ringing" | "call" | "aiThinking" | "aiReply" | "system";

export const ISLAND_EVENTS = {
  /** â†’ island: its preferences changed. */
  prefs: "island://prefs",
  /** â†’ island: a notification or call from the phone. */
  phone: "island://phone",
  /** â†’ island: the output's peak level (0â€“1) while the visualizer is on. */
  level: "island://level",
  /** panel â†’ island: the latest reply and the running step. */
  ai: "island://ai",
  /** â†’ island: the pointer is over the pill (`true`) or left it. */
  hover: "island://hover",
  /** â†’ island: play this scene from Island Studio for a moment (`null` ends it). */
  preview: "island://preview",
} as const;
