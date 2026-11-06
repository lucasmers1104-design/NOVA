import { isHexColor, normalizeHex } from "./color";

export type GradientStyle = "linear" | "mesh" | "swirl";

/** A color gradient behind NOVA's glass. */
export interface BackdropGradient {
  /** 2–4 colors. */
  colors: string[];
  style: GradientStyle;
  /** Direction in degrees (linear and swirl). */
  angle: number;
  /** The preset it still matches; null once edited. */
  presetId: string | null;
}

export const MIN_GRADIENT_COLORS = 2;
export const MAX_GRADIENT_COLORS = 4;
/** Below this the glass stops being readable on bright gradients. */
export const MIN_GLASS_OPACITY = 20;
export const MAX_GLASS_OPACITY = 90;
export const DEFAULT_GLASS_OPACITY = 50;
export const DEFAULT_BACKDROP_DIM = 45;
export const MAX_BACKDROP_DIM = 85;
export const MAX_BACKDROP_BLUR = 40;
export const MAX_CORNER_SCALE = 150;
export const DEFAULT_CORNER_SCALE = 100;

export const UI_FONTS = {
  inter: { label: "Inter", stack: '"Inter Variable", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif' },
  segoe: { label: "Segoe UI", stack: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif' },
  bahnschrift: { label: "Bahnschrift", stack: 'Bahnschrift, "Segoe UI", system-ui, sans-serif' },
  consolas: { label: "Consolas", stack: 'Consolas, "Cascadia Mono", monospace' },
  comic: { label: "Comic Sans", stack: '"Comic Sans MS", "Segoe UI", system-ui, sans-serif' },
} as const;

export type UiFont = keyof typeof UI_FONTS;

export function isUiFont(value: unknown): value is UiFont {
  return typeof value === "string" && Object.hasOwn(UI_FONTS, value);
}

/** Glass in the user's color, kept dark enough that text stays readable on it. */
export function tintedGlass(tint: string | null, opacity: number): string {
  const base = "rgb(24 30 46)";
  const color = tint ? `color-mix(in srgb, ${tint} 38%, ${base})` : base;
  return `color-mix(in srgb, ${color} ${opacity}%, transparent)`;
}

export interface GradientPreset {
  id: string;
  name: string;
  /** The accent that goes with it. */
  accent: string;
  colors: string[];
  style: GradientStyle;
  angle: number;
}

export const GRADIENT_PRESETS: readonly GradientPreset[] = [
  { id: "aurora", name: "Aurora", accent: "#00d9f5", colors: ["#00f5a0", "#00d9f5", "#7c3aed"], style: "mesh", angle: 135 },
  { id: "sunset", name: "Sunset", accent: "#ff7a45", colors: ["#ff512f", "#f09819", "#dd2476"], style: "linear", angle: 135 },
  { id: "neon", name: "Neon Night", accent: "#ff3dcf", colors: ["#ff00cc", "#3333ff", "#00e5ff"], style: "linear", angle: 120 },
  { id: "vaporwave", name: "Vaporwave", accent: "#b967ff", colors: ["#ff71ce", "#01cdfe", "#b967ff", "#05ffa1"], style: "mesh", angle: 135 },
  { id: "inferno", name: "Inferno", accent: "#f5831f", colors: ["#f12711", "#f5af19", "#2b0a00"], style: "linear", angle: 160 },
  { id: "ocean", name: "Deep Ocean", accent: "#4f8cff", colors: ["#0052d4", "#4364f7", "#6fb1fc"], style: "linear", angle: 160 },
  { id: "galaxy", name: "Galaxy", accent: "#a855f7", colors: ["#302b63", "#ff00e0", "#0f0c29", "#00c6ff"], style: "mesh", angle: 135 },
  { id: "toxic", name: "Toxic", accent: "#39ff14", colors: ["#39ff14", "#00ffa3", "#0b3d0b"], style: "swirl", angle: 40 },
  { id: "bloodmoon", name: "Blood Moon", accent: "#ff4466", colors: ["#7f0000", "#ff0844", "#ffb199"], style: "swirl", angle: 200 },
  { id: "candy", name: "Candy", accent: "#ff8fa3", colors: ["#ff9a9e", "#fad0c4", "#a18cd1"], style: "mesh", angle: 135 },
  { id: "midnight", name: "Midnight", accent: "#38bdf8", colors: ["#141e30", "#243b55", "#00c6ff"], style: "linear", angle: 150 },
  { id: "synthwave", name: "Synthwave", accent: "#ff5ea8", colors: ["#2b1055", "#ff2e93", "#ffb347"], style: "linear", angle: 180 },
];

export function presetGradient(preset: GradientPreset): BackdropGradient {
  return { colors: [...preset.colors], style: preset.style, angle: preset.angle, presetId: preset.id };
}

/** Where a mesh's colors glow from; the rest of the pane stays dark. */
const MESH_SPOTS = ["12% 18%", "88% 14%", "82% 88%", "16% 84%"];

export function gradientCss(gradient: BackdropGradient): string {
  const { colors, style, angle } = gradient;
  if (style === "linear") return `linear-gradient(${angle}deg, ${colors.join(", ")})`;
  if (style === "swirl") return `conic-gradient(from ${angle}deg at 50% 50%, ${colors.join(", ")}, ${colors[0]})`;
  const glows = colors.map((color, i) => `radial-gradient(at ${MESH_SPOTS[i % MESH_SPOTS.length]}, ${color} 0%, transparent 62%)`);
  return [...glows, "linear-gradient(#0b0d16, #0b0d16)"].join(", ");
}

/** Validates a stored gradient; null means "no gradient", undefined "not usable". */
export function sanitizeGradient(value: unknown): BackdropGradient | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.colors) || !raw.colors.every((c) => typeof c === "string" && isHexColor(c))) return undefined;
  if (raw.colors.length < MIN_GRADIENT_COLORS || raw.colors.length > MAX_GRADIENT_COLORS) return undefined;
  if (raw.style !== "linear" && raw.style !== "mesh" && raw.style !== "swirl") return undefined;
  if (typeof raw.angle !== "number" || !Number.isFinite(raw.angle)) return undefined;
  return {
    colors: (raw.colors as string[]).map(normalizeHex),
    style: raw.style,
    angle: Math.round(((raw.angle % 360) + 360) % 360),
    presetId: typeof raw.presetId === "string" ? raw.presetId.slice(0, 32) : null,
  };
}
