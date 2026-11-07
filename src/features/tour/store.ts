import { create } from "zustand";
import type { RouteId } from "@/app/navigation";
import { playChime } from "@/features/nova-assistant/wake";
import { isDesktop } from "@/lib/native";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";

/** The little tasks whose completion the tour celebrates; the rest is read from the real settings. */
export type TourMission = "look" | "wake" | "explore" | "keys";

interface TourState {
  open: boolean;
  step: number;
  missions: readonly TourMission[];
  /** Sections opened during the walk through NOVA. */
  explored: readonly RouteId[];
  start: () => void;
  goTo: (step: number) => void;
  complete: (mission: TourMission) => void;
  explore: (route: RouteId) => void;
  /** Ends the tour for good, finished or skipped; it can be started again from Settings. */
  close: () => void;
}

export const useTour = create<TourState>()((set, get) => ({
  open: false,
  step: 0,
  missions: [],
  explored: [],
  start: () => set({ open: true, step: 0, missions: [], explored: [] }),
  goTo: (step) => set({ step }),
  complete: (mission) => {
    if (get().missions.includes(mission)) return;
    set((s) => ({ missions: [...s.missions, mission] }));
    void playChime(0.07);
  },
  explore: (route) => set((s) => (s.explored.includes(route) ? s : { explored: [...s.explored, route] })),
  close: () => {
    set({ open: false });
    useSettings.getState().setTourSeen(true);
    useUi.getState().setPaletteOpen(false);
    useUi.getState().navigate("home");
  },
}));

/** The tour comes first: "What's new" and an automatic update wait until it is over. */
export function useTourPending(): boolean {
  const open = useTour((s) => s.open);
  const seen = useSettings((s) => s.tourSeen);
  return open || (isDesktop() && !seen);
}
