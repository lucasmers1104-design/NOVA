import { useEffect, useMemo } from "react";
import { useSettings } from "@/stores/settings";
import { type AccentTokens, deriveAccentTokens, resolveAccentColor } from "./accent";
import { applyTheme } from "./themeDom";

export { applyTheme };

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
  const backdropGradient = useSettings((s) => s.backdropGradient);
  const glassOpacity = useSettings((s) => s.glassOpacity);
  const glassTint = useSettings((s) => s.glassTint);
  const cornerScale = useSettings((s) => s.cornerScale);
  const uiFont = useSettings((s) => s.uiFont);

  useEffect(() => {
    applyTheme({ accent, transparency, motion, backdropGradient, glassOpacity, glassTint, cornerScale, uiFont });
  }, [accent, transparency, motion, backdropGradient, glassOpacity, glassTint, cornerScale, uiFont]);
}
