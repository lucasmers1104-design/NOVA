import { NAV_ITEMS, type RouteId } from "./navigation";

/**
 * What Rust tells a main window it made again (desktop.rs, `opening_script`):
 * closing to the tray ends the window to give its memory back, and the next
 * one should open where the last one was — or where it is asked to.
 */
export interface Opening {
  reopened?: unknown;
  route?: unknown;
  section?: unknown;
}

declare global {
  interface Window {
    __NOVA_OPENING__?: Opening;
  }
}

const LAST_ROUTE_KEY = "nova.lastRoute";

function isRoute(value: unknown): value is RouteId {
  return typeof value === "string" && NAV_ITEMS.some((item) => item.id === value);
}

function lastRoute(): RouteId | null {
  try {
    const stored = localStorage.getItem(LAST_ROUTE_KEY);
    return isRoute(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Remembers the page for a window that comes back later. Not a setting: it stays in this webview's own storage. */
export function rememberRoute(route: RouteId): void {
  try {
    localStorage.setItem(LAST_ROUTE_KEY, route);
  } catch {
    // Without storage the window simply opens on Home.
  }
}

/**
 * Where the main window opens. A fresh start of NOVA opens Home, as always; a
 * window that came back opens where Rust asks, else where the last one was.
 * Known before the first frame, so nothing flips after it.
 */
export function openingView(opening: Opening | undefined = window.__NOVA_OPENING__, remembered: RouteId | null = lastRoute()): { route: RouteId; settingsSection: string | null } {
  if (!opening?.reopened) return { route: "home", settingsSection: null };
  if (isRoute(opening.route)) {
    const section = opening.route === "settings" && typeof opening.section === "string" && opening.section ? opening.section : null;
    return { route: opening.route, settingsSection: section };
  }
  return { route: remembered ?? "home", settingsSection: null };
}
