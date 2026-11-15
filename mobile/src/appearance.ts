// Which look the user picked: the phone's, always dark, or always light. On its own
// so the settings (store.ts) can set it without loading the theme.

import { create } from "zustand";

export type Appearance = "system" | "dark" | "light";

export const useAppearance = create<{ mode: Appearance }>(() => ({ mode: "system" }));

export function setAppearance(mode: Appearance): void {
  if (useAppearance.getState().mode !== mode) useAppearance.setState({ mode });
}
