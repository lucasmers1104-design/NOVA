import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { DEFAULT_ACCENT, isAccentSetting } from "@/design/accent";
import { applyTheme, type ThemeSettings } from "@/design/themeDom";
import { callNative, isDesktop } from "@/lib/native";
import { ASSISTANT_EVENTS } from "./types";

/** What the assistant windows take from NOVA's settings. */
export interface Appearance extends ThemeSettings {
  displayName: string;
}

export const DEFAULT_APPEARANCE: Appearance = { accent: DEFAULT_ACCENT, transparency: true, motion: "system", displayName: "" };

/** Validates appearance data field by field; anything malformed keeps its default. */
export function sanitizeAppearance(input: unknown): Appearance {
  if (typeof input !== "object" || input === null) return DEFAULT_APPEARANCE;
  const raw = input as Record<string, unknown>;
  return {
    accent: isAccentSetting(raw.accent) ? raw.accent : DEFAULT_APPEARANCE.accent,
    transparency: typeof raw.transparency === "boolean" ? raw.transparency : DEFAULT_APPEARANCE.transparency,
    motion: raw.motion === "system" || raw.motion === "reduced" || raw.motion === "full" ? raw.motion : DEFAULT_APPEARANCE.motion,
    displayName: typeof raw.displayName === "string" ? raw.displayName.slice(0, 40) : "",
  };
}

/**
 * Loads the user's accent and motion settings in an assistant window and
 * follows changes the main window broadcasts.
 */
export function useAssistantAppearance(): Appearance {
  const [appearance, setAppearance] = useState(DEFAULT_APPEARANCE);

  useEffect(() => {
    if (!isDesktop()) return;
    let alive = true;
    const update = (raw: unknown) => {
      if (!alive) return;
      const next = sanitizeAppearance(raw);
      applyTheme(next);
      setAppearance(next);
    };
    callNative<unknown>("assistant_appearance").then(update, () => {});
    const unlisten = listen<unknown>(ASSISTANT_EVENTS.appearance, (event) => update(event.payload));
    return () => {
      alive = false;
      void unlisten.then((stop) => stop());
    };
  }, []);

  return appearance;
}
