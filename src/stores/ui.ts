import { create } from "zustand";
import type { RouteId } from "@/app/navigation";

export interface PluginPageRef {
  pluginId: string;
  pageId: string;
}

interface UiState {
  route: RouteId;
  paletteOpen: boolean;
  /** Settings section to scroll to once the Settings page is shown. */
  settingsSection: string | null;
  /** The plugin's page shown instead of the plugin list on the Plugins route. */
  pluginPage: PluginPageRef | null;
  navigate: (route: RouteId) => void;
  setPaletteOpen: (open: boolean) => void;
  openSettings: (section: string) => void;
  clearSettingsSection: () => void;
  openPluginPage: (page: PluginPageRef) => void;
}

/** Session-only UI state (not persisted). */
export const useUi = create<UiState>()((set) => ({
  route: "home",
  paletteOpen: false,
  settingsSection: null,
  pluginPage: null,
  navigate: (route) => set({ route, pluginPage: null }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  openSettings: (section) => set({ route: "settings", settingsSection: section, pluginPage: null }),
  clearSettingsSection: () => set({ settingsSection: null }),
  openPluginPage: (pluginPage) => set({ route: "plugins", pluginPage }),
}));
