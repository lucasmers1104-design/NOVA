import { create } from "zustand";
import type { RouteId } from "@/app/navigation";

interface UiState {
  route: RouteId;
  paletteOpen: boolean;
  /** Settings section to scroll to once the Settings page is shown. */
  settingsSection: string | null;
  navigate: (route: RouteId) => void;
  setPaletteOpen: (open: boolean) => void;
  openSettings: (section: string) => void;
  clearSettingsSection: () => void;
}

/** Session-only UI state (not persisted). */
export const useUi = create<UiState>()((set) => ({
  route: "home",
  paletteOpen: false,
  settingsSection: null,
  navigate: (route) => set({ route }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  openSettings: (section) => set({ route: "settings", settingsSection: section }),
  clearSettingsSection: () => set({ settingsSection: null }),
}));
