import { adjustLightness, contrastRatio, ensureContrast, isHexColor, normalizeHex, rotateHue, withAlpha } from "./color";

/**
 * Adaptive accent engine: palette management, token derivation with contrast
 * validation, and CSS variable updates. Every accent-colored pixel in the UI
 * flows through the tokens produced here.
 */

export type AccentPresetId = "purple" | "blue" | "cyan" | "emerald" | "amber";

export interface AccentPreset {
  id: AccentPresetId;
  name: string;
  color: string;
}

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: "purple", name: "Electric Purple", color: "#8b5cf6" },
  { id: "blue", name: "Electric Blue", color: "#3d7bff" },
  { id: "cyan", name: "Cyan", color: "#22d3ee" },
  { id: "emerald", name: "Emerald", color: "#10b981" },
  { id: "amber", name: "Amber", color: "#f59e0b" },
];

/**
 * `wallpaper` follows the desktop wallpaper's dominant color; `color` caches
 * the last extracted value so the first frame is already correct.
 */
export type AccentSetting =
  | { kind: "preset"; id: AccentPresetId }
  | { kind: "custom"; color: string }
  | { kind: "wallpaper"; color: string };

export const DEFAULT_ACCENT: AccentSetting = { kind: "preset", id: "purple" };

/** The opaque equivalent of a glass surface; accent text must be readable on it. */
export const SURFACE_REFERENCE = "#1b2232";
/** WCAG AA for normal-size text. */
export const MIN_TEXT_CONTRAST = 4.5;

const DARK_INK = "#0a0c14";
const LIGHT_INK = "#ffffff";

export interface AccentTokens {
  /** Fills: buttons, active indicators, chart strokes. */
  accent: string;
  /** Accent used as text or icons on surfaces; guaranteed ≥ 4.5:1. */
  accentText: string;
  /** Hover / pressed fill. */
  accentStrong: string;
  /** Companion hue for gradients. */
  accentSecondary: string;
  /** Text placed on top of an `accent` fill. */
  onAccent: string;
  glow: string;
  soft: string;
}

const TOKEN_VARIABLES: Record<keyof AccentTokens, string> = {
  accent: "--nova-accent",
  accentText: "--nova-accent-text",
  accentStrong: "--nova-accent-strong",
  accentSecondary: "--nova-accent-secondary",
  onAccent: "--nova-on-accent",
  glow: "--nova-accent-glow",
  soft: "--nova-accent-soft",
};

export function isAccentPresetId(value: unknown): value is AccentPresetId {
  return ACCENT_PRESETS.some((preset) => preset.id === value);
}

export function isAccentSetting(value: unknown): value is AccentSetting {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.kind === "preset") return isAccentPresetId(v.id);
  if (v.kind === "custom" || v.kind === "wallpaper") return typeof v.color === "string" && isHexColor(v.color);
  return false;
}

export function resolveAccentColor(setting: AccentSetting): string {
  if (setting.kind !== "preset") return normalizeHex(setting.color);
  return ACCENT_PRESETS.find((p) => p.id === setting.id)?.color ?? ACCENT_PRESETS[0]!.color;
}

export function accentLabel(setting: AccentSetting): string {
  if (setting.kind === "wallpaper") return "Matches wallpaper";
  if (setting.kind === "custom") return `Custom ${normalizeHex(setting.color).toUpperCase()}`;
  return ACCENT_PRESETS.find((p) => p.id === setting.id)?.name ?? "Accent";
}

export function sameAccent(a: AccentSetting, b: AccentSetting): boolean {
  return resolveAccentColor(a) === resolveAccentColor(b) && a.kind === b.kind;
}

export function deriveAccentTokens(color: string): AccentTokens {
  const accent = normalizeHex(color);
  const onAccent = contrastRatio(LIGHT_INK, accent) >= contrastRatio(DARK_INK, accent) ? LIGHT_INK : DARK_INK;
  return {
    accent,
    accentText: ensureContrast(accent, SURFACE_REFERENCE, MIN_TEXT_CONTRAST),
    accentStrong: adjustLightness(accent, 7),
    accentSecondary: rotateHue(accent, 36),
    onAccent,
    glow: withAlpha(accent, 0.3),
    soft: withAlpha(accent, 0.14),
  };
}

/** CSS custom properties for scoping an accent to a subtree (used for previews). */
export function accentStyleVariables(tokens: AccentTokens): Record<string, string> {
  return Object.fromEntries(
    (Object.keys(TOKEN_VARIABLES) as (keyof AccentTokens)[]).map((key) => [TOKEN_VARIABLES[key], tokens[key]]),
  );
}

export function applyAccentTokens(tokens: AccentTokens, root: HTMLElement = document.documentElement): void {
  for (const [variable, value] of Object.entries(accentStyleVariables(tokens))) {
    root.style.setProperty(variable, value);
  }
}
