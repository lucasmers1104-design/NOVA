import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { CUSTOMIZABLE_ROUTES, type RouteId, WORKSPACE_ORDERABLE_ROUTES } from "@/app/navigation";
import { type AccentSetting, DEFAULT_ACCENT, isAccentSetting } from "@/design/accent";
import { nativeStorage } from "@/lib/persistence";
import { systemPrefers24Hour } from "@/lib/time";

export type MotionPreference = "system" | "reduced" | "full";

export const REFRESH_INTERVALS_MS = [1000, 2000, 5000, 10000] as const;
export type RefreshIntervalMs = (typeof REFRESH_INTERVALS_MS)[number];

export interface WeatherPlace {
  name: string;
  region: string;
  country: string;
  latitude: number;
  longitude: number;
}

export interface NewsFeed {
  url: string;
  title: string;
}

export interface Settings {
  accent: AccentSetting;
  /** Frosted-glass surfaces; off renders opaque surfaces (cheaper on integrated GPUs). */
  transparency: boolean;
  motion: MotionPreference;
  sidebarCollapsed: boolean;
  /** Overrides the OS account name in greetings; empty means "use the OS name". */
  displayName: string;
  use24HourClock: boolean;
  /** Polling interval for live system metrics. */
  refreshIntervalMs: RefreshIntervalMs;
  /** Sidebar order of the reorderable Workspace sections. */
  navOrder: RouteId[];
  /** Sections hidden from the sidebar (still reachable via the command palette). */
  navHidden: RouteId[];
  /** Reminders also appear as Windows notifications. */
  systemNotifications: boolean;
  /** Closing the window keeps NOVA running in the tray (opt-in). */
  closeToTray: boolean;
  /** Weather is fetched only once the user picks a place. */
  weatherPlace: WeatherPlace | null;
  weatherFahrenheit: boolean;
  /** RSS/Atom feeds the user added explicitly. */
  newsFeeds: NewsFeed[];
  /** Shows the desktop wallpaper behind the glass, like macOS. */
  wallpaperBackdrop: boolean;
}

interface SettingsActions {
  setAccent: (accent: AccentSetting) => void;
  setTransparency: (enabled: boolean) => void;
  setMotion: (motion: MotionPreference) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setDisplayName: (name: string) => void;
  setUse24HourClock: (enabled: boolean) => void;
  setRefreshInterval: (ms: RefreshIntervalMs) => void;
  moveNavItem: (id: RouteId, direction: -1 | 1) => void;
  setNavHidden: (id: RouteId, hidden: boolean) => void;
  resetNavigation: () => void;
  setSystemNotifications: (enabled: boolean) => void;
  setCloseToTray: (enabled: boolean) => void;
  setWeatherPlace: (place: WeatherPlace | null) => void;
  setWeatherFahrenheit: (enabled: boolean) => void;
  addNewsFeed: (feed: NewsFeed) => void;
  removeNewsFeed: (url: string) => void;
  setWallpaperBackdrop: (enabled: boolean) => void;
  resetSettings: () => void;
}

export function defaultSettings(): Settings {
  return {
    accent: DEFAULT_ACCENT,
    transparency: true,
    motion: "system",
    sidebarCollapsed: false,
    displayName: "",
    use24HourClock: systemPrefers24Hour(),
    refreshIntervalMs: 2000,
    navOrder: [...WORKSPACE_ORDERABLE_ROUTES],
    navHidden: [],
    systemNotifications: true,
    closeToTray: false,
    weatherPlace: null,
    weatherFahrenheit: false,
    newsFeeds: [],
    wallpaperBackdrop: true,
  };
}

export const MAX_NEWS_FEEDS = 8;

function sanitizePlace(value: unknown): WeatherPlace | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  const lat = p.latitude;
  const lon = p.longitude;
  if (typeof p.name !== "string" || typeof lat !== "number" || typeof lon !== "number") return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  return {
    name: p.name.slice(0, 80),
    region: typeof p.region === "string" ? p.region.slice(0, 80) : "",
    country: typeof p.country === "string" ? p.country.slice(0, 80) : "",
    latitude: lat,
    longitude: lon,
  };
}

function sanitizeFeeds(value: unknown): NewsFeed[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((f): f is NewsFeed => typeof f?.url === "string" && /^https?:\/\//i.test(f.url) && typeof f?.title === "string")
    .map((f) => ({ url: f.url.slice(0, 500), title: f.title.slice(0, 100) }))
    .slice(0, MAX_NEWS_FEEDS);
}

const MAX_DISPLAY_NAME = 40;

function routeList(value: unknown, allowed: readonly RouteId[]): RouteId[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((id): id is RouteId => allowed.includes(id as RouteId)))];
}

/**
 * Validates persisted data field by field. Anything malformed is dropped so
 * the default applies — a corrupted store must never break startup.
 */
export function sanitizeSettings(input: unknown): Partial<Settings> {
  if (typeof input !== "object" || input === null) return {};
  const raw = input as Record<string, unknown>;
  const out: Partial<Settings> = {};

  if (isAccentSetting(raw.accent)) out.accent = raw.accent;
  if (typeof raw.transparency === "boolean") out.transparency = raw.transparency;
  if (raw.motion === "system" || raw.motion === "reduced" || raw.motion === "full") out.motion = raw.motion;
  if (typeof raw.sidebarCollapsed === "boolean") out.sidebarCollapsed = raw.sidebarCollapsed;
  if (typeof raw.displayName === "string") out.displayName = raw.displayName.slice(0, MAX_DISPLAY_NAME);
  if (typeof raw.use24HourClock === "boolean") out.use24HourClock = raw.use24HourClock;
  if (REFRESH_INTERVALS_MS.includes(raw.refreshIntervalMs as RefreshIntervalMs)) {
    out.refreshIntervalMs = raw.refreshIntervalMs as RefreshIntervalMs;
  }
  const navOrder = routeList(raw.navOrder, WORKSPACE_ORDERABLE_ROUTES);
  if (navOrder) {
    // Sections added in newer versions are appended in their default position.
    out.navOrder = [...navOrder, ...WORKSPACE_ORDERABLE_ROUTES.filter((id) => !navOrder.includes(id))];
  }
  const navHidden = routeList(raw.navHidden, CUSTOMIZABLE_ROUTES);
  if (navHidden) out.navHidden = navHidden;
  if (typeof raw.systemNotifications === "boolean") out.systemNotifications = raw.systemNotifications;
  if (typeof raw.closeToTray === "boolean") out.closeToTray = raw.closeToTray;
  const place = sanitizePlace(raw.weatherPlace);
  if (place !== undefined) out.weatherPlace = place;
  if (typeof raw.weatherFahrenheit === "boolean") out.weatherFahrenheit = raw.weatherFahrenheit;
  const feeds = sanitizeFeeds(raw.newsFeeds);
  if (feeds) out.newsFeeds = feeds;
  if (typeof raw.wallpaperBackdrop === "boolean") out.wallpaperBackdrop = raw.wallpaperBackdrop;
  return out;
}

export const SETTINGS_STORAGE_KEY = "nova.settings";

export const useSettings = create<Settings & SettingsActions>()(
  persist(
    (set) => ({
      ...defaultSettings(),
      setAccent: (accent) => set({ accent }),
      setTransparency: (transparency) => set({ transparency }),
      setMotion: (motion) => set({ motion }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setDisplayName: (name) => set({ displayName: name.slice(0, MAX_DISPLAY_NAME) }),
      setUse24HourClock: (use24HourClock) => set({ use24HourClock }),
      setRefreshInterval: (refreshIntervalMs) => set({ refreshIntervalMs }),
      moveNavItem: (id, direction) =>
        set((s) => {
          const order = [...s.navOrder];
          const from = order.indexOf(id);
          const to = from + direction;
          if (from < 0 || to < 0 || to >= order.length) return s;
          [order[from], order[to]] = [order[to]!, order[from]!];
          return { navOrder: order };
        }),
      setNavHidden: (id, hidden) =>
        set((s) => ({ navHidden: hidden ? [...new Set([...s.navHidden, id])] : s.navHidden.filter((h) => h !== id) })),
      resetNavigation: () => set({ navOrder: [...WORKSPACE_ORDERABLE_ROUTES], navHidden: [] }),
      setSystemNotifications: (systemNotifications) => set({ systemNotifications }),
      setCloseToTray: (closeToTray) => set({ closeToTray }),
      setWeatherPlace: (weatherPlace) => set({ weatherPlace }),
      setWeatherFahrenheit: (weatherFahrenheit) => set({ weatherFahrenheit }),
      addNewsFeed: (feed) =>
        set((s) => (s.newsFeeds.some((f) => f.url === feed.url) ? s : { newsFeeds: [...s.newsFeeds, feed].slice(0, MAX_NEWS_FEEDS) })),
      removeNewsFeed: (url) => set((s) => ({ newsFeeds: s.newsFeeds.filter((f) => f.url !== url) })),
      setWallpaperBackdrop: (wallpaperBackdrop) => set({ wallpaperBackdrop }),
      resetSettings: () => set(defaultSettings()),
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      version: 1,
      // SQLite in the desktop app (see lib/persistence.ts). Hydration is
      // asynchronous, so main.tsx awaits `rehydrate()` before the first render.
      storage: createJSONStorage(() => nativeStorage),
      skipHydration: true,
      partialize: (s): Settings => ({
        accent: s.accent,
        transparency: s.transparency,
        motion: s.motion,
        sidebarCollapsed: s.sidebarCollapsed,
        displayName: s.displayName,
        use24HourClock: s.use24HourClock,
        refreshIntervalMs: s.refreshIntervalMs,
        navOrder: s.navOrder,
        navHidden: s.navHidden,
        systemNotifications: s.systemNotifications,
        closeToTray: s.closeToTray,
        weatherPlace: s.weatherPlace,
        weatherFahrenheit: s.weatherFahrenheit,
        newsFeeds: s.newsFeeds,
        wallpaperBackdrop: s.wallpaperBackdrop,
      }),
      merge: (persisted, current) => ({ ...current, ...sanitizeSettings(persisted) }),
    },
  ),
);
