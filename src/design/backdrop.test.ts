import { describe, expect, it } from "vitest";
import { sanitizeSettings } from "@/stores/settings";
import { type BackdropGradient, GRADIENT_PRESETS, gradientCss, MAX_GRADIENT_COLORS, MIN_GRADIENT_COLORS, presetGradient, sanitizeGradient, tintedGlass } from "./backdrop";
import { applyTheme, type ThemeSettings } from "./themeDom";

const GRADIENT: BackdropGradient = { colors: ["#ff0000", "#00ff00", "#0000ff"], style: "linear", angle: 90, presetId: null };

describe("backdrop gradients", () => {
  it("writes each style as CSS", () => {
    expect(gradientCss(GRADIENT)).toBe("linear-gradient(90deg, #ff0000, #00ff00, #0000ff)");
    // A swirl closes its circle.
    expect(gradientCss({ ...GRADIENT, colors: ["#111111", "#222222"], style: "swirl" })).toBe("conic-gradient(from 90deg at 50% 50%, #111111, #222222, #111111)");
    const mesh = gradientCss({ ...GRADIENT, colors: ["#111111", "#222222"], style: "mesh" });
    expect(mesh.match(/radial-gradient/g)).toHaveLength(2);
    expect(mesh).toContain("#222222");
  });

  it("has presets that survive being stored", () => {
    for (const preset of GRADIENT_PRESETS) {
      const gradient = presetGradient(preset);
      expect(preset.colors.length).toBeGreaterThanOrEqual(MIN_GRADIENT_COLORS);
      expect(preset.colors.length).toBeLessThanOrEqual(MAX_GRADIENT_COLORS);
      expect(sanitizeGradient(JSON.parse(JSON.stringify(gradient)))).toEqual(gradient);
    }
  });

  it("drops anything malformed, since stored values end up in CSS", () => {
    expect(sanitizeGradient(null)).toBeNull();
    expect(sanitizeGradient("red")).toBeUndefined();
    expect(sanitizeGradient({ ...GRADIENT, colors: ["#fff"] })).toBeUndefined();
    expect(sanitizeGradient({ ...GRADIENT, colors: ["#fff", "red; background: url(x)"] })).toBeUndefined();
    expect(sanitizeGradient({ ...GRADIENT, colors: Array(5).fill("#ffffff") })).toBeUndefined();
    expect(sanitizeGradient({ ...GRADIENT, style: "plaid" })).toBeUndefined();
    expect(sanitizeGradient({ ...GRADIENT, angle: "90" })).toBeUndefined();
    expect(sanitizeGradient({ ...GRADIENT, angle: -90 })?.angle).toBe(270);
  });

  it("keeps stored strengths in range", () => {
    expect(sanitizeSettings({ glassOpacity: 1 }).glassOpacity).toBe(20);
    expect(sanitizeSettings({ glassOpacity: 500 }).glassOpacity).toBe(90);
    expect(sanitizeSettings({ backdropDim: 100 }).backdropDim).toBe(85);
    expect(sanitizeSettings({ backdropDim: Number.NaN }).backdropDim).toBeUndefined();
    expect(sanitizeSettings({ backdropGradient: { colors: [] } }).backdropGradient).toBeUndefined();
    expect(sanitizeSettings({ backdropBlur: 999 }).backdropBlur).toBe(40);
    expect(sanitizeSettings({ cornerScale: -5 }).cornerScale).toBe(0);
  });

  it("drops stored customization that could end up in CSS", () => {
    expect(sanitizeSettings({ glassTint: "red; background: url(x)" }).glassTint).toBeUndefined();
    expect(sanitizeSettings({ glassTint: "#FF0000" }).glassTint).toBe("#ff0000");
    expect(sanitizeSettings({ glassTint: null }).glassTint).toBeNull();
    expect(sanitizeSettings({ uiFont: "Evil; }" }).uiFont).toBeUndefined();
    expect(sanitizeSettings({ uiFont: "constructor" }).uiFont).toBeUndefined();
    expect(sanitizeSettings({ uiFont: "comic" }).uiFont).toBe("comic");
    expect(sanitizeSettings({ backdropImage: "../../secret" }).backdropImage).toBeUndefined();
    expect(sanitizeSettings({ backdropImage: "1793992905296" }).backdropImage).toBe("1793992905296");
  });

  it("tints the glass, and leaves the opaque look alone when transparency is off", () => {
    const root = document.createElement("div");
    const theme: Omit<ThemeSettings, "transparency"> = { accent: { kind: "preset", id: "purple" }, motion: "system", backdropGradient: GRADIENT, glassOpacity: 30, glassTint: "#ff0000", cornerScale: 50, uiFont: "consolas" };
    expect(tintedGlass(null, 30)).toBe("color-mix(in srgb, rgb(24 30 46) 30%, transparent)");
    expect(tintedGlass("#ff0000", 30)).toBe("color-mix(in srgb, color-mix(in srgb, #ff0000 38%, rgb(24 30 46)) 30%, transparent)");
    applyTheme({ ...theme, transparency: true }, root);
    expect(root.style.getPropertyValue("--nova-overlay-image")).toContain("#00ff00");
    expect(root.style.getPropertyValue("--radius-widget")).toBe("12px");
    expect(root.style.getPropertyValue("--font-sans")).toContain("Consolas");
    applyTheme({ ...theme, transparency: false }, root);
    expect(root.style.getPropertyValue("--color-glass")).toBe("");
    expect(root.style.getPropertyValue("--nova-overlay-image")).toBe("none");
  });
});
