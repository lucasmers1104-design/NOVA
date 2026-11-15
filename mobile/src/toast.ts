// Short messages at the bottom of the screen. Lives outside the UI folder so the
// connection (store.ts) can report a problem without knowing about components.

import { create } from "zustand";

export type ToastTone = "neutral" | "success" | "warning" | "danger";

export interface ToastOptions {
  tone?: ToastTone;
  /** A button on the toast, e.g. "Rückgängig". Tapping it closes the toast without `onExpire`. */
  action?: { label: string; onPress: () => void };
  /** Runs when the toast goes away by itself or is replaced: the moment a deferred action becomes final. */
  onExpire?: () => void;
  durationMs?: number;
}

export interface ToastItem extends Required<Pick<ToastOptions, "tone" | "durationMs">> {
  id: number;
  text: string;
  action?: ToastOptions["action"];
  onExpire?: ToastOptions["onExpire"];
}

interface ToastStore {
  current: ToastItem | null;
  show(text: string, options?: ToastOptions): void;
  /** The action button was tapped. */
  act(): void;
  /** Time is up, or the user swiped it away. */
  expire(id: number): void;
}

let next = 1;
let timer: ReturnType<typeof setTimeout> | null = null;

export const useToasts = create<ToastStore>((set, get) => {
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    current: null,

    show(text, options = {}) {
      // Only one at a time: what the old one deferred becomes final now.
      const old = get().current;
      clear();
      old?.onExpire?.();
      const item: ToastItem = { id: next++, text, tone: options.tone ?? "neutral", durationMs: options.durationMs ?? (options.action ? 5000 : 3500), action: options.action, onExpire: options.onExpire };
      set({ current: item });
      timer = setTimeout(() => get().expire(item.id), item.durationMs);
    },

    act() {
      const item = get().current;
      if (!item) return;
      clear();
      set({ current: null });
      item.action?.onPress();
    },

    expire(id) {
      const item = get().current;
      if (!item || item.id !== id) return;
      clear();
      set({ current: null });
      item.onExpire?.();
    },
  };
});

export function toast(text: string, options?: ToastOptions): void {
  useToasts.getState().show(text, options);
}
