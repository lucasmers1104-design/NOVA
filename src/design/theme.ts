import { useEffect, useMemo } from "react";
import { useSettings, type Settings } from "@/stores/settings";
import { type AccentTokens, applyAccentTokens, deriveAccentTokens, resolveAccentColor } from "./accent";

type ThemeSettings = Pick<Settings, "accent" | "transparency" | "motion">;

/** Writes theme-related settings onto <html> as CSS variables and data attributes. */
export function applyTheme(settings: ThemeSettings, root: HTMLElement = document.documentElement): void {
  applyAccentTokens(deriveAccentTokens(resolveAccentColor(settings.accent)), root);
  root.dataset.glass = settings.transparency ? "on" : "off";
  root.dataset.motion = settings.motion;
}

/**
 * Resolved accent colors for places CSS variables cannot reach, such as SVG
 * presentation attributes written by chart libraries.
 */
export function useAccentTokens(): AccentTokens {
  const accent = useSettings((s) => s.accent);
  return useMemo(() => deriveAccentTokens(resolveAccentColor(accent)), [accent]);
}

/** Keeps <html> in sync with the settings store for the app's lifetime. */
export function useThemeSync(): void {
  const accent = useSettings((s) => s.accent);
  const transparency = useSettings((s) => s.transparency);
  const motion = useSettings((s) => s.motion);

  useEffect(() => {
    applyTheme({ accent, transparency, motion });
  }, [accent, transparency, motion]);
}
