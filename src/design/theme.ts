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

  useEffect(() => {
    applyTheme({ accent, transparency, motion });
  }, [accent, transparency, motion]);
}
