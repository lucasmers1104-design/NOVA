import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { CUSTOMIZABLE_ROUTES, type RouteId, WORKSPACE_ORDERABLE_ROUTES } from "@/app/navigation";
import { type AccentSetting, DEFAULT_ACCENT, isAccentSetting } from "@/design/accent";
import { type BackdropGradient, DEFAULT_BACKDROP_DIM, DEFAULT_CORNER_SCALE, DEFAULT_GLASS_OPACITY, isUiFont, MAX_BACKDROP_BLUR, MAX_BACKDROP_DIM, MAX_CORNER_SCALE, MAX_GLASS_OPACITY, MIN_GLASS_OPACITY, sanitizeGradient, type UiFont } from "@/design/backdrop";
import { isHexColor, normalizeHex } from "@/design/color";
import { nativeStorage } from "@/lib/persistence";
import { systemPrefers24Hour } from "@/lib/time";

export type MotionPreference = "system" | "reduced" | "full";

export type TitleBarClock = "off" | "time" | "time-date";

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
  /** Understated clock in the title bar, next to the notifications. */
  titleBarClock: TitleBarClock;
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
  /** A color gradient behind the glass, instead of the wallpaper. */
  backdropGradient: BackdropGradient | null;
  /** How much the gradient is darkened, in percent. */
  backdropDim: number;
  /** How solid the glass is, in percent. */
  glassOpacity: number;
  /** The user's own background picture (a token that changes with the picture); null means none. */
  backdropImage: string | null;
  /** How much the picture is blurred, in pixels. */
  backdropBlur: number;
  /** The background drifts slowly. */
  backdropAnimated: boolean;
  /** A color the glass takes on; null for the usual dark glass. */
  glassTint: string | null;
  /** How round corners are, in percent of the usual. */
  cornerScale: number;
  uiFont: UiFont;
  /** GitHub "owner/repo" or HTTPS URL; empty means the built-in default. */
  updateSource: string;
  /** Check at every start and install found updates after a short countdown. */
  autoUpdate: boolean;
  /** Version that last ran; used to announce completed updates. */
  lastSeenVersion: string;
  /** The introduction appeared and was finished or skipped; it doesn't appear by itself again. */
  tourSeen: boolean;
}

interface SettingsActions {
  setAccent: (accent: AccentSetting) => void;
  setTransparency: (enabled: boolean) => void;
  setMotion: (motion: MotionPreference) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setDisplayName: (name: string) => void;
  setUse24HourClock: (enabled: boolean) => void;
  setTitleBarClock: (clock: TitleBarClock) => void;
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
  setBackdropGradient: (gradient: BackdropGradient | null) => void;
  setBackdropDim: (percent: number) => void;
  setGlassOpacity: (percent: number) => void;
  setBackdropImage: (token: string | null) => void;
  setBackdropBlur: (pixels: number) => void;
  setBackdropAnimated: (enabled: boolean) => void;
  setGlassTint: (color: string | null) => void;
  setCornerScale: (percent: number) => void;
  setUiFont: (font: UiFont) => void;
  setUpdateSource: (source: string) => void;
  setAutoUpdate: (enabled: boolean) => void;
  setLastSeenVersion: (version: string) => void;
  setTourSeen: (seen: boolean) => void;
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
    titleBarClock: "off",
    refreshIntervalMs: 2000,
    navOrder: [...WORKSPACE_ORDERABLE_ROUTES],
    navHidden: [],
    systemNotifications: true,
    closeToTray: false,
    weatherPlace: null,
    weatherFahrenheit: false,
    newsFeeds: [],
    wallpaperBackdrop: true,
    backdropGradient: null,
    backdropDim: DEFAULT_BACKDROP_DIM,
    glassOpacity: DEFAULT_GLASS_OPACITY,
    backdropImage: null,
    backdropBlur: 0,
    backdropAnimated: false,
    glassTint: null,
    cornerScale: DEFAULT_CORNER_SCALE,
    uiFont: "inter",
    updateSource: "",
    autoUpdate: true,
    lastSeenVersion: "",
    tourSeen: false,
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
  if (raw.titleBarClock === "off" || raw.titleBarClock === "time" || raw.titleBarClock === "time-date") out.titleBarClock = raw.titleBarClock;
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
  const gradient = sanitizeGradient(raw.backdropGradient);
  if (gradient !== undefined) out.backdropGradient = gradient;
  if (typeof raw.backdropDim === "number" && Number.isFinite(raw.backdropDim)) out.backdropDim = Math.min(MAX_BACKDROP_DIM, Math.max(0, raw.backdropDim));
  if (typeof raw.glassOpacity === "number" && Number.isFinite(raw.glassOpacity)) out.glassOpacity = Math.min(MAX_GLASS_OPACITY, Math.max(MIN_GLASS_OPACITY, raw.glassOpacity));
  if (raw.backdropImage === null || (typeof raw.backdropImage === "string" && /^\d{1,20}$/.test(raw.backdropImage))) out.backdropImage = raw.backdropImage;
  if (typeof raw.backdropBlur === "number" && Number.isFinite(raw.backdropBlur)) out.backdropBlur = Math.min(MAX_BACKDROP_BLUR, Math.max(0, raw.backdropBlur));
  if (typeof raw.backdropAnimated === "boolean") out.backdropAnimated = raw.backdropAnimated;
  if (raw.glassTint === null) out.glassTint = null;
  else if (typeof raw.glassTint === "string" && isHexColor(raw.glassTint)) out.glassTint = normalizeHex(raw.glassTint);
  if (typeof raw.cornerScale === "number" && Number.isFinite(raw.cornerScale)) out.cornerScale = Math.min(MAX_CORNER_SCALE, Math.max(0, raw.cornerScale));
  if (isUiFont(raw.uiFont)) out.uiFont = raw.uiFont;
  if (typeof raw.updateSource === "string") out.updateSource = raw.updateSource.slice(0, 200);
  if (typeof raw.autoUpdate === "boolean") out.autoUpdate = raw.autoUpdate;
  if (typeof raw.lastSeenVersion === "string" && /^[0-9A-Za-z.+-]{0,32}$/.test(raw.lastSeenVersion)) out.lastSeenVersion = raw.lastSeenVersion;
  if (typeof raw.tourSeen === "boolean") out.tourSeen = raw.tourSeen;
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
      setTitleBarClock: (titleBarClock) => set({ titleBarClock }),
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
      setBackdropGradient: (backdropGradient) => set({ backdropGradient }),
      setBackdropDim: (backdropDim) => set({ backdropDim }),
      setGlassOpacity: (glassOpacity) => set({ glassOpacity }),
      setBackdropImage: (backdropImage) => set({ backdropImage }),
      setBackdropBlur: (backdropBlur) => set({ backdropBlur }),
      setBackdropAnimated: (backdropAnimated) => set({ backdropAnimated }),
      setGlassTint: (glassTint) => set({ glassTint }),
      setCornerScale: (cornerScale) => set({ cornerScale }),
      setUiFont: (uiFont) => set({ uiFont }),
      setUpdateSource: (source) => set({ updateSource: source.slice(0, 200) }),
      setAutoUpdate: (autoUpdate) => set({ autoUpdate }),
      setLastSeenVersion: (lastSeenVersion) => set({ lastSeenVersion }),
      setTourSeen: (tourSeen) => set({ tourSeen }),
      // Reset keeps lastSeenVersion so it doesn't trigger a false "updated" notice.
      // Only how NOVA looks and behaves: who you are and what you set up yourself stays.
      resetSettings: () =>
        set((s) => ({
          ...defaultSettings(),
          lastSeenVersion: s.lastSeenVersion,
          tourSeen: s.tourSeen,
          displayName: s.displayName,
          weatherPlace: s.weatherPlace,
          weatherFahrenheit: s.weatherFahrenheit,
          newsFeeds: s.newsFeeds,
          updateSource: s.updateSource,
          autoUpdate: s.autoUpdate,
          closeToTray: s.closeToTray,
          systemNotifications: s.systemNotifications,
        })),
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
        titleBarClock: s.titleBarClock,
        refreshIntervalMs: s.refreshIntervalMs,
        navOrder: s.navOrder,
        navHidden: s.navHidden,
        systemNotifications: s.systemNotifications,
        closeToTray: s.closeToTray,
        weatherPlace: s.weatherPlace,
        weatherFahrenheit: s.weatherFahrenheit,
        newsFeeds: s.newsFeeds,
        wallpaperBackdrop: s.wallpaperBackdrop,
        backdropGradient: s.backdropGradient,
        backdropDim: s.backdropDim,
        glassOpacity: s.glassOpacity,
        backdropImage: s.backdropImage,
        backdropBlur: s.backdropBlur,
        backdropAnimated: s.backdropAnimated,
        glassTint: s.glassTint,
        cornerScale: s.cornerScale,
        uiFont: s.uiFont,
        updateSource: s.updateSource,
        autoUpdate: s.autoUpdate,
        lastSeenVersion: s.lastSeenVersion,
        tourSeen: s.tourSeen,
      }),
      merge: (persisted, current) => ({ ...current, ...sanitizeSettings(persisted) }),
    },
  ),
);
