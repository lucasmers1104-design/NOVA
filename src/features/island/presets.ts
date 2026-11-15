// Presets: looks to pick with one click. The curated ones live here; the user's own are
// part of the preferences (Rust keeps them). A preset travels as a short text code:
// "NI1." and the look as base64url JSON, checked field by field when it comes back in.

import { isHexColor, normalizeHex } from "@/design/color";
import {
  DEFAULT_LOOK,
  DEFAULT_MOTION,
  DEFAULT_SLOTS,
  type IslandBorder,
  type IslandLook,
  type IslandMotion,
  type IslandMotionStyle,
  type IslandPrefs,
  type IslandPreset,
  type IslandSlots,
  type IslandTheme,
  LIMITS,
  type SlotItem,
  type SlotPair,
  type SlotState,
} from "./types";

/** Everything a preset sets. */
export type PresetLook = Pick<IslandPreset, "theme" | "look" | "motion" | "slots">;

const NO_SLOTS: SlotPair = { left: "none", right: "none" };

export const CURATED_PRESETS: readonly (IslandPreset & { description: string })[] = [
  { id: "classic", name: "Classic", description: "Tiefschwarz, federnd", theme: "black", look: DEFAULT_LOOK, motion: DEFAULT_MOTION, slots: DEFAULT_SLOTS },
  {
    id: "glass-pro",
    name: "Glass Pro",
    description: "Getöntes Glas, weich",
    theme: "glass",
    look: { ...DEFAULT_LOOK, scale: 104, radius: 24, closedHeight: 40 },
    motion: { style: "soft", speed: 100 },
    slots: { ...DEFAULT_SLOTS, music: { left: "cover", right: "progress" } },
  },
  {
    id: "minimal",
    name: "Minimal",
    description: "Klein, kantig, ruhig",
    theme: "custom",
    look: { scale: 92, radius: 10, closedHeight: 32, background: "#0c0c0f", opacity: 100, frost: 0, border: "off", shadow: 20, accent: null },
    motion: { style: "minimal", speed: 110 },
    slots: { music: { left: "none", right: "visualizer" }, call: { left: "none", right: "remaining" }, ai: { left: "aiStatus", right: "none" }, notification: NO_SLOTS, system: NO_SLOTS },
  },
  {
    id: "neon",
    name: "Neon",
    description: "Leuchtrand in Magenta",
    theme: "custom",
    look: { scale: 100, radius: 20, closedHeight: 38, background: "#08060f", opacity: 94, frost: 15, border: "glow", shadow: 85, accent: "#ff3df0" },
    motion: { style: "springy", speed: 115 },
    slots: { ...DEFAULT_SLOTS, music: { left: "visualizer", right: "remaining" } },
  },
  {
    id: "paper",
    name: "Paper",
    description: "Weiß, feiner Schatten",
    theme: "white",
    look: { ...DEFAULT_LOOK, radius: 16, shadow: 35 },
    motion: { style: "soft", speed: 100 },
    slots: { ...DEFAULT_SLOTS, music: { left: "cover", right: "clock" } },
  },
  {
    id: "aurora",
    name: "Aurora",
    description: "Mattes Blaugrün",
    theme: "custom",
    look: { scale: 102, radius: 26, closedHeight: 40, background: "#12283a", opacity: 74, frost: 75, border: "fine", shadow: 55, accent: "#34d399" },
    motion: { style: "soft", speed: 90 },
    slots: DEFAULT_SLOTS,
  },
];

const THEMES: readonly IslandTheme[] = ["black", "white", "glass", "custom"];
const BORDERS: readonly IslandBorder[] = ["off", "fine", "glow"];
const STYLES: readonly IslandMotionStyle[] = ["springy", "soft", "minimal"];
const SLOT_ITEMS: readonly SlotItem[] = ["cover", "visualizer", "appIcon", "clock", "remaining", "progress", "aiStatus", "none"];
const SLOT_STATES: readonly SlotState[] = ["music", "call", "ai", "notification", "system"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function whole(value: unknown, { min, max }: { min: number; max: number }, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function color(value: unknown): string | null {
  return typeof value === "string" && isHexColor(value) ? normalizeHex(value) : null;
}

/** A look with every value inside the limits Rust enforces too; anything unreadable takes its default. */
export function cleanLook(value: unknown): IslandLook {
  const look = isRecord(value) ? value : {};
  return {
    scale: whole(look.scale, LIMITS.scale, DEFAULT_LOOK.scale),
    radius: whole(look.radius, LIMITS.radius, DEFAULT_LOOK.radius),
    closedHeight: whole(look.closedHeight, LIMITS.closedHeight, DEFAULT_LOOK.closedHeight),
    background: color(look.background) ?? DEFAULT_LOOK.background,
    opacity: whole(look.opacity, LIMITS.opacity, DEFAULT_LOOK.opacity),
    frost: whole(look.frost, LIMITS.frost, DEFAULT_LOOK.frost),
    border: oneOf(look.border, BORDERS, DEFAULT_LOOK.border),
    shadow: whole(look.shadow, LIMITS.shadow, DEFAULT_LOOK.shadow),
    accent: color(look.accent),
  };
}

function cleanMotion(value: unknown): IslandMotion {
  const motion = isRecord(value) ? value : {};
  return { style: oneOf(motion.style, STYLES, DEFAULT_MOTION.style), speed: whole(motion.speed, LIMITS.speed, DEFAULT_MOTION.speed) };
}

function cleanSlots(value: unknown): IslandSlots {
  const slots = isRecord(value) ? value : {};
  return Object.fromEntries(
    SLOT_STATES.map((state) => {
      const pair = isRecord(slots[state]) ? slots[state] : {};
      return [state, { left: oneOf(pair.left, SLOT_ITEMS, DEFAULT_SLOTS[state].left), right: oneOf(pair.right, SLOT_ITEMS, DEFAULT_SLOTS[state].right) }];
    }),
  ) as IslandSlots;
}

function cleanName(value: unknown): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what must go
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, LIMITS.presetName) : "";
}

const CODE_PREFIX = "NI1.";
/** A code is a few hundred characters; anything far longer isn't one. */
const MOST_CODE_CHARS = 4000;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(code: string): string {
  const binary = atob(code.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/** The preset as a short code to paste somewhere else. */
export function encodePreset(preset: PresetLook & { name: string }): string {
  return CODE_PREFIX + toBase64Url(JSON.stringify({ v: 1, n: cleanName(preset.name), t: preset.theme, l: preset.look, m: preset.motion, s: preset.slots }));
}

export type DecodedPreset = { ok: true; preset: PresetLook & { name: string } } | { ok: false; reason: string };

/** Reads a code back. Nothing in it is trusted: wrong shapes are refused, values are limited. */
export function decodePreset(code: string): DecodedPreset {
  const trimmed = code.trim();
  if (trimmed === "") return { ok: false, reason: "Füg einen Code ein." };
  if (trimmed.length > MOST_CODE_CHARS) return { ok: false, reason: "Das ist zu lang für einen Vorlagen-Code." };
  if (!trimmed.startsWith(CODE_PREFIX)) {
    return { ok: false, reason: /^NI\d+\./.test(trimmed) ? "Dieser Code stammt aus einer neueren NOVA-Version." : "Das ist kein Vorlagen-Code. Er beginnt mit „NI1.“." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(trimmed.slice(CODE_PREFIX.length)));
  } catch {
    return { ok: false, reason: "Der Code ist beschädigt oder unvollständig." };
  }
  if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.l) || !THEMES.includes(parsed.t as IslandTheme)) {
    return { ok: false, reason: "Der Code ist beschädigt oder unvollständig." };
  }
  return {
    ok: true,
    preset: { name: cleanName(parsed.n) || "Importierte Vorlage", theme: parsed.t as IslandTheme, look: cleanLook(parsed.l), motion: cleanMotion(parsed.m), slots: cleanSlots(parsed.s) },
  };
}

/** The preferences with a preset's look; everything else stays as it is. */
export function applyPreset(prefs: IslandPrefs, preset: PresetLook): IslandPrefs {
  return { ...prefs, theme: preset.theme, look: preset.look, motion: preset.motion, slots: preset.slots };
}

/** The preset the current look matches, if any (for marking its card). */
export function matchingPreset<T extends PresetLook>(prefs: IslandPrefs, presets: readonly T[]): T | null {
  const current = JSON.stringify([prefs.theme, prefs.look, prefs.motion, prefs.slots]);
  return presets.find((preset) => JSON.stringify([preset.theme, preset.look, preset.motion, preset.slots]) === current) ?? null;
}

/** The current look as a preset of the user's own. */
export function presetFrom(prefs: IslandPrefs, name: string, id: string): IslandPreset {
  return { id, name: cleanName(name) || "Meine Vorlage", theme: prefs.theme, look: prefs.look, motion: prefs.motion, slots: prefs.slots };
}
