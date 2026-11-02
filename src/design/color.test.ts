import { describe, expect, it } from "vitest";
import { contrastRatio, ensureContrast, hslToRgb, isHexColor, normalizeHex, parseHex, rgbToHsl, rotateHue, toHex, withAlpha } from "./color";

describe("hex parsing", () => {
  it("accepts 3- and 6-digit hex with or without #", () => {
    expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("8B5CF6")).toEqual({ r: 139, g: 92, b: 246 });
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
  });

  it("rejects malformed input", () => {
    expect(isHexColor("#12345")).toBe(false);
    expect(isHexColor("purple")).toBe(false);
    expect(() => parseHex("#zzzzzz")).toThrow(/Invalid hex/);
  });

  it("clamps channels when formatting", () => {
    expect(toHex({ r: 300, g: -5, b: 127.6 })).toBe("#ff0080");
  });
});

describe("HSL conversion", () => {
  it("round-trips colors", () => {
    for (const hex of ["#8b5cf6", "#22d3ee", "#10b981", "#f59e0b", "#3d7bff", "#777777"]) {
      expect(toHex(hslToRgb(rgbToHsl(parseHex(hex))))).toBe(hex);
    }
  });

  it("rotates hue", () => {
    expect(rotateHue("#ff0000", 120)).toBe("#00ff00");
  });
});

describe("contrast", () => {
  it("matches WCAG reference values", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#123456", "#123456")).toBe(1);
  });

  it("ensureContrast lightens until the target ratio is met on dark backgrounds", () => {
    const result = ensureContrast("#3d00a0", "#111522", 4.5);
    expect(contrastRatio(result, "#111522")).toBeGreaterThanOrEqual(4.5);
  });

  it("ensureContrast keeps colors that already pass", () => {
    expect(ensureContrast("#ffffff", "#111522", 4.5)).toBe("#ffffff");
  });

  it("formats alpha colors", () => {
    expect(withAlpha("#8b5cf6", 0.3)).toBe("rgb(139 92 246 / 0.3)");
  });
});
