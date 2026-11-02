import { describe, expect, it } from "vitest";
import { parseHex, rgbToHsl } from "./color";
import { extractPalette } from "./palette";

/** Builds RGBA pixel data from [hexColor, pixelCount] pairs. */
function pixels(...runs: [string, number, number?][]): Uint8ClampedArray {
  const data: number[] = [];
  for (const [hex, count, alpha = 255] of runs) {
    const { r, g, b } = parseHex(hex);
    for (let i = 0; i < count; i++) data.push(r, g, b, alpha);
  }
  return new Uint8ClampedArray(data);
}

const hueOf = (hex: string) => rgbToHsl(parseHex(hex)).h;

describe("extractPalette", () => {
  it("orders colors by dominance", () => {
    const palette = extractPalette(pixels(["#1e5bd8", 700], ["#f08a24", 250], ["#222222", 900]));
    expect(palette).toHaveLength(2);
    expect(hueOf(palette[0]!)).toBeGreaterThan(200);
    expect(hueOf(palette[0]!)).toBeLessThan(240);
    expect(hueOf(palette[1]!)).toBeGreaterThan(20);
    expect(hueOf(palette[1]!)).toBeLessThan(40);
  });

  it("produces colors usable as accents", () => {
    for (const color of extractPalette(pixels(["#0b2a4a", 500], ["#7a1010", 300]))) {
      const { s, l } = rgbToHsl(parseHex(color));
      expect(s).toBeGreaterThanOrEqual(54);
      expect(l).toBeGreaterThanOrEqual(49);
      expect(l).toBeLessThanOrEqual(63);
    }
  });

  it("returns nothing for grayscale or fully transparent images", () => {
    expect(extractPalette(pixels(["#000000", 100], ["#808080", 100], ["#ffffff", 100]))).toEqual([]);
    expect(extractPalette(pixels(["#ff0000", 100, 0]))).toEqual([]);
    expect(extractPalette(new Uint8ClampedArray())).toEqual([]);
  });

  it("merges near-identical hues and respects the color limit", () => {
    const palette = extractPalette(pixels(["#2563eb", 400], ["#2a6af0", 400]));
    expect(palette).toHaveLength(1);
    const rainbow = extractPalette(
      pixels(["#ef4444", 50], ["#f59e0b", 50], ["#22c55e", 50], ["#06b6d4", 50], ["#6366f1", 50], ["#d946ef", 50]),
      3,
    );
    expect(rainbow).toHaveLength(3);
  });

  it("ignores negligible color noise", () => {
    expect(extractPalette(pixels(["#2563eb", 1000], ["#ef4444", 5]))).toHaveLength(1);
  });
});
