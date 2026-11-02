import { useEffect } from "react";
import { callNative, isDesktop } from "@/lib/native";
import { writeJson } from "@/lib/persistence";
import { useSettings } from "@/stores/settings";

/**
 * Mirrors desktop preferences to the Rust side: the live window-close
 * behavior, and the stored value read at startup (for background launches).
 */
export function useDesktopSync(): void {
  const closeToTray = useSettings((s) => s.closeToTray);
  useEffect(() => {
    if (!isDesktop()) return;
    void callNative("desktop_set_close_to_tray", { enabled: closeToTray }).catch(() => {});
    void writeJson("nova.desktop", { closeToTray });
  }, [closeToTray]);
}
