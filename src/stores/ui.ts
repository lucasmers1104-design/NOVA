import { create } from "zustand";
import type { RouteId } from "@/app/navigation";

interface UiState {
  route: RouteId;
  paletteOpen: boolean;
  navigate: (route: RouteId) => void;
  setPaletteOpen: (open: boolean) => void;
}

/** Session-only UI state (not persisted). */
export const useUi = create<UiState>()((set) => ({
  route: "home",
  paletteOpen: false,
  navigate: (route) => set({ route }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
}));
