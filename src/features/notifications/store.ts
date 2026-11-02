import { create } from "zustand";

export type NotificationKind = "info" | "success" | "warning" | "error" | "reminder";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  at: number;
  read: boolean;
}

interface NotificationState {
  items: AppNotification[];
  /** Ids currently shown as transient toasts. */
  toasts: string[];
  centerOpen: boolean;
  notify: (input: { kind?: NotificationKind; title: string; body?: string; toast?: boolean }) => string;
  dismissToast: (id: string) => void;
  markAllRead: () => void;
  remove: (id: string) => void;
  clear: () => void;
  setCenterOpen: (open: boolean) => void;
}

const MAX_ITEMS = 50;
const TOAST_MS = 4500;

/**
 * In-app notification center. Every notification lands here; most also show
 * briefly as a toast. Kept for the session only.
 */
export const useNotifications = create<NotificationState>()((set, get) => ({
  items: [],
  toasts: [],
  centerOpen: false,
  notify: ({ kind = "info", title, body, toast = true }) => {
    const id = crypto.randomUUID();
    const item: AppNotification = { id, kind, title, body, at: Date.now(), read: get().centerOpen };
    set((s) => ({ items: [item, ...s.items].slice(0, MAX_ITEMS), toasts: toast ? [...s.toasts, id].slice(-3) : s.toasts }));
    if (toast) setTimeout(() => get().dismissToast(id), kind === "error" || kind === "reminder" ? TOAST_MS * 2 : TOAST_MS);
    return id;
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t !== id) })),
  markAllRead: () => set((s) => ({ items: s.items.map((i) => (i.read ? i : { ...i, read: true })) })),
  remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id), toasts: s.toasts.filter((t) => t !== id) })),
  clear: () => set({ items: [], toasts: [] }),
  setCenterOpen: (centerOpen) => {
    set({ centerOpen });
    if (centerOpen) get().markAllRead();
  },
}));

/** Shorthand for components and non-React modules. */
export function notify(title: string, options: { kind?: NotificationKind; body?: string; toast?: boolean } = {}): string {
  return useNotifications.getState().notify({ title, ...options });
}

export function notifyError(title: string, error: unknown): string {
  return notify(title, { kind: "error", body: error instanceof Error ? error.message : String(error) });
}
