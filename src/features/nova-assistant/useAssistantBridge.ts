import { emit, listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { isDesktop } from "@/lib/native";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { ASSISTANT_EVENTS } from "./types";

/**
 * Main window side of the assistant: keeps the dot and panel in the user's
 * accent and motion settings, and opens the pages they link to.
 */
export function useAssistantBridge(): void {
  const accent = useSettings((s) => s.accent);
  const transparency = useSettings((s) => s.transparency);
  const motion = useSettings((s) => s.motion);
  const displayName = useSettings((s) => s.displayName);
  const openSettings = useUi((s) => s.openSettings);
  const navigate = useUi((s) => s.navigate);

  useEffect(() => {
    if (!isDesktop()) return;
    emit(ASSISTANT_EVENTS.appearance, { accent, transparency, motion, displayName }).catch(() => {});
  }, [accent, transparency, motion, displayName]);

  useEffect(() => {
    if (!isDesktop()) return;
    const unlisten = listen<{ route?: unknown; section?: unknown }>(ASSISTANT_EVENTS.navigate, ({ payload }) => {
      if (payload.route === "settings" && typeof payload.section === "string") openSettings(payload.section);
      if (payload.route === "productivity") navigate("productivity");
    });
    return () => void unlisten.then((stop) => stop());
  }, [openSettings, navigate]);
}
