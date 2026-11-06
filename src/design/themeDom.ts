import type { MotionPreference } from "@/stores/settings";
import { type AccentSetting, applyAccentTokens, deriveAccentTokens, resolveAccentColor } from "./accent";
import { type BackdropGradient, gradientCss, tintedGlass, UI_FONTS, type UiFont } from "./backdrop";

export interface ThemeSettings {
  accent: AccentSetting;
  transparency: boolean;
  motion: MotionPreference;
  backdropGradient: BackdropGradient | null;
  /** How solid the glass is, in percent. */
  glassOpacity: number;
  /** A color the glass takes on; null for the usual dark glass. */
  glassTint: string | null;
  /** How round corners are, in percent of the usual. */
  cornerScale: number;
  uiFont: UiFont;
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
    root.style.setProperty("--color-glass", tintedGlass(settings.glassTint, settings.glassOpacity));
    root.style.setProperty("--color-glass-strong", tintedGlass(settings.glassTint, Math.min(settings.glassOpacity + 28, 95)));
  } else {
    // Transparency off has its own opaque values in the stylesheet.
    root.style.removeProperty("--color-glass");
    root.style.removeProperty("--color-glass-strong");
  }
  const overlay = settings.transparency && settings.backdropGradient ? `${OVERLAY_SHADE}, ${gradientCss(settings.backdropGradient)}` : "none";
  root.style.setProperty("--nova-overlay-image", overlay);
  const corners = settings.cornerScale / 100;
  root.style.setProperty("--radius-widget", `${24 * corners}px`);
  root.style.setProperty("--radius-control", `${12 * corners}px`);
  root.style.setProperty("--radius-chip", `${9 * corners}px`);
  root.style.setProperty("--font-sans", UI_FONTS[settings.uiFont].stack);
}
