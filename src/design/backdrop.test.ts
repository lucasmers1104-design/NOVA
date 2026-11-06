import { describe, expect, it } from "vitest";
import { sanitizeSettings } from "@/stores/settings";
import { type BackdropGradient, GRADIENT_PRESETS, gradientCss, MAX_GRADIENT_COLORS, MIN_GRADIENT_COLORS, presetGradient, sanitizeGradient } from "./backdrop";
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
  });

  it("tints the glass, and leaves the opaque look alone when transparency is off", () => {
    const root = document.createElement("div");
    const theme: Omit<ThemeSettings, "transparency"> = { accent: { kind: "preset", id: "purple" }, motion: "system", backdropGradient: GRADIENT, glassOpacity: 30 };
    applyTheme({ ...theme, transparency: true }, root);
    expect(root.style.getPropertyValue("--color-glass")).toBe("rgb(24 30 46 / 0.3)");
    expect(root.style.getPropertyValue("--nova-overlay-image")).toContain("#00ff00");
    applyTheme({ ...theme, transparency: false }, root);
    expect(root.style.getPropertyValue("--color-glass")).toBe("");
    expect(root.style.getPropertyValue("--nova-overlay-image")).toBe("none");
  });
});
