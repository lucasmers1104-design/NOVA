import { useEffect } from "react";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";

export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        const ui = useUi.getState();
        ui.setPaletteOpen(!ui.paletteOpen);
      } else if (key === "b") {
        event.preventDefault();
        useSettings.getState().toggleSidebar();
      } else if (key === ",") {
        event.preventDefault();
        useUi.getState().setPaletteOpen(false);
        useUi.getState().navigate("settings");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
