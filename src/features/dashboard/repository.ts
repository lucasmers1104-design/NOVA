import { callNative, isDesktop } from "@/lib/native";
import { readJson, writeJson } from "@/lib/persistence";
import type { DashboardLayout } from "./layouts";

/** Persistence boundary for dashboard layouts. Data coming back is untrusted. */
export interface DashboardRepository {
  list(): Promise<unknown[]>;
  save(layout: DashboardLayout): Promise<void>;
  remove(id: string): Promise<void>;
  getActiveId(): Promise<string | null>;
  setActiveId(id: string): Promise<void>;
}

const PREFERENCES_KEY = "nova.dashboard";
const LOCAL_LAYOUTS_KEY = "nova.dashboard.layouts";

async function getActiveId(): Promise<string | null> {
  const prefs = await readJson(PREFERENCES_KEY);
  const id = (prefs as { activeLayoutId?: unknown } | null)?.activeLayoutId;
  return typeof id === "string" ? id : null;
}

function setActiveId(id: string): Promise<void> {
  return writeJson(PREFERENCES_KEY, { activeLayoutId: id });
}

/** SQLite tables via Tauri commands (desktop app). */
const nativeRepository: DashboardRepository = {
  list: () => callNative<unknown[]>("dashboard_layouts_list"),
  save: (layout) => callNative("dashboard_layout_save", { layout }),
  remove: (id) => callNative("dashboard_layout_delete", { id }),
  getActiveId,
  setActiveId,
};

function readLocal(): unknown[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LOCAL_LAYOUTS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** localStorage fallback for the browser preview and tests. */
const localRepository: DashboardRepository = {
  list: async () => readLocal(),
  save: async (layout) => {
    const layouts = readLocal();
    const index = layouts.findIndex((l) => (l as { id?: unknown }).id === layout.id);
    if (index === -1) layouts.push(layout);
    else layouts[index] = layout;
    localStorage.setItem(LOCAL_LAYOUTS_KEY, JSON.stringify(layouts));
  },
  remove: async (id) => {
    localStorage.setItem(LOCAL_LAYOUTS_KEY, JSON.stringify(readLocal().filter((l) => (l as { id?: unknown }).id !== id)));
  },
  getActiveId,
  setActiveId,
};

export function dashboardRepository(): DashboardRepository {
  return isDesktop() ? nativeRepository : localRepository;
}
