import { hslToRgb, type Rgb, rgbToHsl, toHex } from "./color";

const HUE_BINS = 24;
/** Bins holding less than this share of the colorful weight are ignored as noise. */
const MIN_SHARE = 0.02;
/** Minimum hue separation between returned colors, in degrees. */
const MIN_HUE_DISTANCE = 28;

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Nudges a sampled color into a range that works as a UI accent on dark glass. */
function toAccent(rgb: Rgb): string {
  const { h, s, l } = rgbToHsl(rgb);
  return toHex(hslToRgb({ h, s: Math.max(s, 55), l: Math.min(62, Math.max(50, l)) }));
}

/**
 * Extracts up to `maxColors` distinct, accent-worthy colors from RGBA pixel
 * data, most dominant first. Grays, near-black and near-white pixels are
 * ignored; vivid mid-tones weigh the most. Returns [] for colorless images.
 */
export function extractPalette(pixels: ArrayLike<number>, maxColors = 5): string[] {
  const bins = Array.from({ length: HUE_BINS }, () => ({ weight: 0, r: 0, g: 0, b: 0 }));

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3]! < 128) continue;
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    const b = pixels[i + 2]!;
    const { h, s, l } = rgbToHsl({ r, g, b });
    if (s < 20 || l < 12 || l > 90) continue;
    const weight = (s / 100) * (1 - Math.abs(l - 55) / 55);
    if (weight <= 0) continue;
    const bin = bins[Math.floor(h / (360 / HUE_BINS)) % HUE_BINS]!;
    bin.weight += weight;
    bin.r += r * weight;
    bin.g += g * weight;
    bin.b += b * weight;
  }

  const total = bins.reduce((sum, bin) => sum + bin.weight, 0);
  if (total === 0) return [];

  const chosen: { hue: number; color: string }[] = [];
  for (const bin of [...bins].filter((b) => b.weight / total >= MIN_SHARE).sort((a, b) => b.weight - a.weight)) {
    const color = toAccent({ r: bin.r / bin.weight, g: bin.g / bin.weight, b: bin.b / bin.weight });
    const hue = rgbToHsl({ r: bin.r / bin.weight, g: bin.g / bin.weight, b: bin.b / bin.weight }).h;
    if (chosen.some((c) => hueDistance(c.hue, hue) < MIN_HUE_DISTANCE)) continue;
    chosen.push({ hue, color });
    if (chosen.length === maxColors) break;
  }
  return chosen.map((c) => c.color);
}
