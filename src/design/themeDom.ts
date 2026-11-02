import type { MotionPreference } from "@/stores/settings";
import { type AccentSetting, applyAccentTokens, deriveAccentTokens, resolveAccentColor } from "./accent";

export interface ThemeSettings {
  accent: AccentSetting;
  transparency: boolean;
  motion: MotionPreference;
}

/**
 * Writes theme-related settings onto <html> as CSS variables and data
 * attributes. Kept free of stores so the small assistant windows can use it.
 */
export function applyTheme(settings: ThemeSettings, root: HTMLElement = document.documentElement): void {
  applyAccentTokens(deriveAccentTokens(resolveAccentColor(settings.accent)), root);
  root.dataset.glass = settings.transparency ? "on" : "off";
  root.dataset.motion = settings.motion;
}
