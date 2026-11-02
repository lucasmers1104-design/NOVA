/** Small, dependency-free color math used by the accent engine. */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Hsl {
  /** Hue in degrees, 0–360. */
  h: number;
  /** Saturation, 0–100. */
  s: number;
  /** Lightness, 0–100. */
  l: number;
}

const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHexColor(value: string): boolean {
  return HEX_PATTERN.test(value.trim());
}

export function parseHex(value: string): Rgb {
  const match = HEX_PATTERN.exec(value.trim());
  if (!match?.[1]) throw new Error(`Invalid hex color: "${value}"`);
  let hex = match[1];
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
  const n = Number.parseInt(hex, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function toHex({ r, g, b }: Rgb): string {
  const channel = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Normalizes any accepted hex notation to lowercase #rrggbb. */
export function normalizeHex(value: string): string {
  return toHex(parseHex(value));
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };

  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const sn = Math.min(100, Math.max(0, s)) / 100;
  const ln = Math.min(100, Math.max(0, l)) / 100;
  const hn = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = ln - c / 2;
  const [r, g, b] =
    hn < 60 ? [c, x, 0] : hn < 120 ? [x, c, 0] : hn < 180 ? [0, c, x] : hn < 240 ? [0, x, c] : hn < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const linear = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio between two hex colors (1–21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(parseHex(a));
  const lb = relativeLuminance(parseHex(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = parseHex(hex);
  return `rgb(${r} ${g} ${b} / ${alpha})`;
}

export function adjustLightness(hex: string, delta: number): string {
  const hsl = rgbToHsl(parseHex(hex));
  return toHex(hslToRgb({ ...hsl, l: hsl.l + delta }));
}

export function rotateHue(hex: string, degrees: number): string {
  const hsl = rgbToHsl(parseHex(hex));
  return toHex(hslToRgb({ ...hsl, h: hsl.h + degrees }));
}

/**
 * Lightens (on dark backgrounds) or darkens (on light backgrounds) `fg`
 * until it reaches `minRatio` against `bg`, preserving hue.
 */
export function ensureContrast(fg: string, bg: string, minRatio: number): string {
  let candidate = normalizeHex(fg);
  if (contrastRatio(candidate, bg) >= minRatio) return candidate;

  const lighten = relativeLuminance(parseHex(bg)) < 0.5;
  const hsl = rgbToHsl(parseHex(candidate));
  for (let l = hsl.l; lighten ? l <= 100 : l >= 0; l += lighten ? 1 : -1) {
    candidate = toHex(hslToRgb({ ...hsl, l }));
    if (contrastRatio(candidate, bg) >= minRatio) return candidate;
  }
  return lighten ? "#ffffff" : "#000000";
}
