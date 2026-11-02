import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { notify, notifyError } from "@/features/notifications/store";
import { callNative } from "@/lib/native";
import { nativeStorage } from "@/lib/persistence";

/** Mirrors `AppEntry` in src-tauri/src/apps.rs. */
export interface AppEntry {
  id: string;
  name: string;
  category: string;
  source: "start-menu" | "custom";
}

export const appKeys = {
  list: ["apps", "list"] as const,
  icon: (id: string) => ["apps", "icon", id] as const,
};

export function useApps() {
  return useQuery({
    queryKey: appKeys.list,
    queryFn: () => callNative<AppEntry[]>("apps_list", { refresh: false }),
    staleTime: 5 * 60_000,
  });
}

export function useRescanApps() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => callNative<AppEntry[]>("apps_list", { refresh: true }),
    onSuccess: (apps) => {
      client.setQueryData(appKeys.list, apps);
      notify(`Found ${apps.length} apps`, { kind: "success" });
    },
    onError: (error) => notifyError("Couldn't scan apps", error),
  });
}

/** Icons are rendered natively once per app and cached for the session. */
export function useAppIcon(id: string) {
  return useQuery({
    queryKey: appKeys.icon(id),
    queryFn: () => callNative<string | null>("app_icon", { id }),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 60_000,
    retry: false,
  });
}

interface AppPreferences {
  favorites: string[];
  recents: { id: string; at: number }[];
  toggleFavorite: (id: string) => void;
  moveFavorite: (id: string, direction: -1 | 1) => void;
  recordLaunch: (id: string) => void;
  forget: (id: string) => void;
}

const MAX_RECENTS = 12;

export function sanitizeAppPreferences(raw: unknown): Partial<Pick<AppPreferences, "favorites" | "recents">> {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<Pick<AppPreferences, "favorites" | "recents">> = {};
  if (Array.isArray(r.favorites)) out.favorites = [...new Set(r.favorites.filter((v): v is string => typeof v === "string"))].slice(0, 48);
  if (Array.isArray(r.recents)) {
    out.recents = r.recents
      .filter((v): v is { id: string; at: number } => typeof v === "object" && v !== null && typeof v.id === "string" && typeof v.at === "number")
      .slice(0, MAX_RECENTS);
  }
  return out;
}

export const useAppPreferences = create<AppPreferences>()(
  persist(
    (set) => ({
      favorites: [],
      recents: [],
      toggleFavorite: (id) =>
        set((s) => ({ favorites: s.favorites.includes(id) ? s.favorites.filter((f) => f !== id) : [...s.favorites, id] })),
      moveFavorite: (id, direction) =>
        set((s) => {
          const list = [...s.favorites];
          const from = list.indexOf(id);
          const to = from + direction;
          if (from < 0 || to < 0 || to >= list.length) return s;
          [list[from], list[to]] = [list[to]!, list[from]!];
          return { favorites: list };
        }),
      recordLaunch: (id) => set((s) => ({ recents: [{ id, at: Date.now() }, ...s.recents.filter((r) => r.id !== id)].slice(0, MAX_RECENTS) })),
      forget: (id) => set((s) => ({ favorites: s.favorites.filter((f) => f !== id), recents: s.recents.filter((r) => r.id !== id) })),
    }),
    {
      name: "nova.apps",
      storage: createJSONStorage(() => nativeStorage),
      partialize: (s) => ({ favorites: s.favorites, recents: s.recents }),
      merge: (persisted, current) => ({ ...current, ...sanitizeAppPreferences(persisted) }),
    },
  ),
);

export function useLaunchApp() {
  return useMutation({
    mutationFn: (app: AppEntry) => callNative<void>("app_launch", { id: app.id }),
    onMutate: (app) => useAppPreferences.getState().recordLaunch(app.id),
    onSuccess: (_, app) => notify(`Opening ${app.name}`, { kind: "success" }),
    onError: (error, app) => notifyError(`Couldn't open ${app.name}`, error),
  });
}

export function useAddShortcut() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ name, path }: { name: string; path: string }) => callNative<AppEntry>("app_shortcut_add", { name, path }),
    onSuccess: (app) => {
      client.setQueryData<AppEntry[]>(appKeys.list, (list) => [...(list ?? []), app]);
      notify(`${app.name} added to your apps`, { kind: "success" });
    },
    onError: (error) => notifyError("Couldn't add the app", error),
  });
}

export function useRemoveShortcut() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (app: AppEntry) => callNative<void>("app_shortcut_remove", { id: app.id }),
    onSuccess: (_, app) => {
      client.setQueryData<AppEntry[]>(appKeys.list, (list) => (list ?? []).filter((a) => a.id !== app.id));
      useAppPreferences.getState().forget(app.id);
    },
    onError: (error) => notifyError("Couldn't remove the app", error),
  });
}

/** Ranks apps for a search query: prefix > word start > substring. */
export function searchApps(apps: readonly AppEntry[], query: string): AppEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...apps];
  const score = (name: string) => {
    const n = name.toLowerCase();
    if (n.startsWith(q)) return 3;
    if (n.split(/[\s\-_.]+/).some((w) => w.startsWith(q))) return 2;
    return n.includes(q) ? 1 : 0;
  };
  return apps
    .map((app) => ({ app, s: score(app.name) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.app.name.localeCompare(b.app.name))
    .map((x) => x.app);
}
