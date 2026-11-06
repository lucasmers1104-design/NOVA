import type { MotionPreference } from "@/stores/settings";
import { type AccentSetting, applyAccentTokens, deriveAccentTokens, resolveAccentColor } from "./accent";
import { type BackdropGradient, gradientCss } from "./backdrop";

export interface ThemeSettings {
  accent: AccentSetting;
  transparency: boolean;
  motion: MotionPreference;
  backdropGradient: BackdropGradient | null;
  /** How solid the glass is, in percent. */
  glassOpacity: number;
}

/** Keeps floating panes (the NOVA AI panel, menus) readable: mostly dark, with the gradient glowing through. */
const OVERLAY_SHADE = "linear-gradient(rgb(17 21 34 / 0.76), rgb(17 21 34 / 0.76))";

/**
 * Writes theme-related settings onto <html> as CSS variables and data
 * attributes. Kept free of stores so the small assistant windows can use it.
 */
export function applyTheme(settings: ThemeSettings, root: HTMLElement = document.documentElement): void {
  applyAccentTokens(deriveAccentTokens(resolveAccentColor(settings.accent)), root);
  root.dataset.glass = settings.transparency ? "on" : "off";
  root.dataset.motion = settings.motion;
  if (settings.transparency) {
    const alpha = settings.glassOpacity / 100;
    root.style.setProperty("--color-glass", `rgb(24 30 46 / ${alpha})`);
    root.style.setProperty("--color-glass-strong", `rgb(26 32 50 / ${Math.min(alpha + 0.28, 0.95)})`);
  } else {
    // Transparency off has its own opaque values in the stylesheet.
    root.style.removeProperty("--color-glass");
    root.style.removeProperty("--color-glass-strong");
  }
  const overlay = settings.transparency && settings.backdropGradient ? `${OVERLAY_SHADE}, ${gradientCss(settings.backdropGradient)}` : "none";
  root.style.setProperty("--nova-overlay-image", overlay);
}
