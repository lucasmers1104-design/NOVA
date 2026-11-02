import { describe, expect, it } from "vitest";
import {
  ACCENT_PRESETS,
  accentStyleVariables,
  applyAccentTokens,
  deriveAccentTokens,
  isAccentSetting,
  MIN_TEXT_CONTRAST,
  resolveAccentColor,
  sameAccent,
  SURFACE_REFERENCE,
} from "./accent";
import { contrastRatio } from "./color";

const SAMPLE_CUSTOM_COLORS = ["#000000", "#ffffff", "#ff0000", "#1a1a40", "#ffff00", "#5b21b6", "#0ea5e9", "#7f7f7f"];

describe("accent token derivation", () => {
  it.each([...ACCENT_PRESETS.map((p) => p.color), ...SAMPLE_CUSTOM_COLORS])("keeps text accessible for %s", (color) => {
    const tokens = deriveAccentTokens(color);
    expect(contrastRatio(tokens.accentText, SURFACE_REFERENCE)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(contrastRatio(tokens.onAccent, tokens.accent)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST - 0.4);
  });

  it("chooses dark text on light accents and light text on dark accents", () => {
    expect(deriveAccentTokens("#f59e0b").onAccent).toBe("#0a0c14");
    expect(deriveAccentTokens("#5b21b6").onAccent).toBe("#ffffff");
  });
});

describe("accent settings", () => {
  it("resolves presets and normalizes custom colors", () => {
    expect(resolveAccentColor({ kind: "preset", id: "cyan" })).toBe("#22d3ee");
    expect(resolveAccentColor({ kind: "custom", color: "#ABC" })).toBe("#aabbcc");
  });

  it("resolves wallpaper-following accents to their cached color", () => {
    expect(resolveAccentColor({ kind: "wallpaper", color: "#2A6AF0" })).toBe("#2a6af0");
    expect(isAccentSetting({ kind: "wallpaper", color: "#2a6af0" })).toBe(true);
    expect(isAccentSetting({ kind: "wallpaper" })).toBe(false);
  });

  it("validates untrusted values", () => {
    expect(isAccentSetting({ kind: "preset", id: "emerald" })).toBe(true);
    expect(isAccentSetting({ kind: "preset", id: "neon" })).toBe(false);
    expect(isAccentSetting({ kind: "custom", color: "javascript:alert(1)" })).toBe(false);
    expect(isAccentSetting(null)).toBe(false);
  });

  it("compares settings by kind and resolved color", () => {
    expect(sameAccent({ kind: "custom", color: "#FFF" }, { kind: "custom", color: "#ffffff" })).toBe(true);
    expect(sameAccent({ kind: "preset", id: "purple" }, { kind: "custom", color: "#8b5cf6" })).toBe(false);
  });
});

describe("CSS variable application", () => {
  it("writes every token as a custom property", () => {
    const root = document.createElement("div");
    const tokens = deriveAccentTokens("#10b981");
    applyAccentTokens(tokens, root);

    expect(root.style.getPropertyValue("--nova-accent")).toBe("#10b981");
    expect(root.style.getPropertyValue("--nova-on-accent")).toBe(tokens.onAccent);
    expect(Object.keys(accentStyleVariables(tokens))).toHaveLength(7);
  });
});
