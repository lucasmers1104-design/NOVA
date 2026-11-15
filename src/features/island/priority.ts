// What Nova Island shows: at most two things at once, the most relevant one leading.
// Pure functions, so the rules are tested without a window (priority.test.ts).

import type { AssistantState } from "@/features/nova-assistant/types";
import { DEFAULT_ORDER, type IslandModules, type ModuleKey, type PhoneCall, type PhoneNotice, type SlotItem, type SlotPair, type SlotState } from "./types";

export type ContentKind = SlotState;

export interface IslandInputs {
  modules: IslandModules;
  /** The user's ranking, best first (Island Studio → priority). */
  order: readonly ModuleKey[];
  /** A call leads whatever the ranking says. */
  callsFirst: boolean;
  call: PhoneCall | null;
  ai: AssistantState;
  /** NOVA AI just answered and the reply is still worth showing. */
  aiReply: boolean;
  notification: PhoneNotice | null;
  /** Something plays or is paused in a player Windows knows. */
  music: "playing" | "paused" | null;
}

export interface Arrangement {
  primary: ContentKind | null;
  secondary: ContentKind | null;
}

const QUIET: readonly AssistantState[] = ["idle", "completed"];

const KIND: Record<ModuleKey, ContentKind> = { calls: "call", ai: "ai", notifications: "notification", music: "music", system: "system" };

/** NOVA AI is doing something the island should say. */
export function aiBusy(state: AssistantState): boolean {
  return !QUIET.includes(state);
}

/** Every module exactly once: what the list names first, then whatever it left out. */
export function normalizeOrder(order: readonly string[]): ModuleKey[] {
  const known = order.filter((key): key is ModuleKey => (DEFAULT_ORDER as readonly string[]).includes(key));
  return [...new Set([...known, ...DEFAULT_ORDER])];
}

/**
 * The rank follows `order` (by default: a call › NOVA AI at work › a phone notification ›
 * music › system). A ringing call that leads is shown alone; paused music only fills a
 * free place, wherever music stands in the ranking.
 */
export function arrange(inputs: IslandInputs): Arrangement {
  const { modules } = inputs;
  const order = normalizeOrder(inputs.order);
  if (inputs.callsFirst) order.sort((a, b) => Number(b === "calls") - Number(a === "calls"));
  const present: Record<ModuleKey, boolean> = {
    calls: inputs.call !== null && inputs.call.state !== "ended",
    ai: aiBusy(inputs.ai) || inputs.aiReply,
    notifications: inputs.notification !== null,
    music: inputs.music === "playing",
    system: true,
  };
  const ranked = order.filter((key) => modules[key] && present[key]).map((key) => KIND[key]);
  if (modules.music && inputs.music === "paused") ranked.push("music");
  const primary = ranked[0] ?? null;
  if (primary === "call" && inputs.call?.state === "ringing") return { primary, secondary: null };
  return { primary, secondary: ranked[1] ?? null };
}

/** The largest pill there is (logical px, before the size setting); island.rs sizes the window for it. */
export const MAX_PILL = { width: 460, height: 320 } as const;

/** Room each slot item takes in the closed pill (px), without the gap beside it. */
const SLOT_WIDTH: Record<SlotItem, number> = { cover: 24, visualizer: 20, appIcon: 24, clock: 36, remaining: 34, progress: 20, aiStatus: 22, none: 0 };
const SLOT_GAP = 9;
/** The closed pill's width without its side slots. */
const CORE_WIDTH: Record<ContentKind, number> = { call: 160, ai: 239, notification: 287, music: 206, system: 244 };

/** What a slot can show in each state: the remaining time of a system readout, say, doesn't exist. */
const UNSUPPORTED: Partial<Record<SlotItem, readonly ContentKind[]>> = {
  remaining: ["ai", "system"],
  progress: ["call"],
};

export function slotSupported(item: SlotItem, state: ContentKind): boolean {
  return !UNSUPPORTED[item]?.includes(state);
}

/** What a slot really shows: nothing where the item makes no sense, or where the island's own dot already says it. */
export function effectiveSlot(item: SlotItem, state: ContentKind, dot: boolean): SlotItem {
  if (!slotSupported(item, state)) return "none";
  if (item === "aiStatus" && dot) return "none";
  return item;
}

export interface PillOptions {
  /** The NOVA dot sits in the island. */
  dot: boolean;
  lyrics: boolean;
  ringing: boolean;
  /** The leading content's side slots. */
  slots?: SlotPair;
  /** Height of the closed pill. */
  closedHeight?: number;
}

/** The pill's size (logical px) for what it shows. */
export function pillSize(arrangement: Arrangement, expanded: boolean, options: PillOptions): { width: number; height: number } {
  const { primary } = arrangement;
  if (options.ringing) return { width: 380, height: 88 };
  if (expanded && primary) {
    switch (primary) {
      case "music":
        return options.lyrics ? { width: 400, height: 312 } : { width: 400, height: 186 };
      case "notification":
        return { width: 388, height: 140 };
      case "call":
        return { width: 380, height: 120 };
      case "system":
        return { width: 368, height: 158 };
      case "ai":
        return { width: 388, height: 160 };
    }
  }
  const height = options.closedHeight ?? 38;
  // The resting pill is a little slimmer than one that has something to say.
  if (!primary) return { width: options.dot ? 120 : 112, height: height - 8 };
  const slots = options.slots ?? { left: "none", right: "none" };
  const sides = [slots.left, slots.right].map((item) => effectiveSlot(item, primary, options.dot)).reduce((sum, item) => sum + (item === "none" ? 0 : SLOT_WIDTH[item] + SLOT_GAP), 0);
  const width = CORE_WIDTH[primary] + sides + (options.dot ? 30 : 0) + (arrangement.secondary ? 28 : 0);
  return { width: Math.min(MAX_PILL.width, width), height };
}

/** The next notification to show from a queue: the first that hasn't run out. */
export function currentNotice<T extends { shownAt: number | null }>(queue: readonly T[], now: number, seconds: number): T | null {
  for (const item of queue) {
    if (item.shownAt === null || now - item.shownAt < seconds * 1000) return item;
  }
  return null;
}

/** "+49 170 1234567" stays, anything else that isn't a phone number goes. */
export function readableNumber(number: string | null): string | null {
  if (!number) return null;
  return /^[+\d][\d\s()/-]{2,38}$/.test(number.trim()) ? number.trim() : null;
}

/** Bytes per second, short: "12.4 MB/s". */
export function rate(bytesPerSecond: number): string {
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let value = Math.max(0, bytesPerSecond);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Minutes and seconds: "3:07". */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
