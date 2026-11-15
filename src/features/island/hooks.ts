// Small polling hooks for the island page. No query library here (like the dot's
// page): each poll runs only while its module is on and the window is visible.

import { listen } from "@tauri-apps/api/event";
import { type RefObject, useEffect, useState } from "react";
import type { MediaState } from "@/features/media/api";
import type { SystemSnapshot, TemperatureSensor } from "@/features/system/api";
import { callNative } from "@/lib/native";
import { islandMeter } from "./api";
import { iconSrc } from "./app-icons";
import { ISLAND_EVENTS } from "./types";

/** Runs `tick` now and every `ms` while `enabled` and the page is visible. */
export function usePoll(enabled: boolean, ms: number, tick: () => void) {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer || document.visibilityState !== "visible") return;
      tick();
      timer = setInterval(tick, ms);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // `tick` is read fresh each time the effect starts; only these two restart it.
  }, [enabled, ms]);
}

export interface Media {
  state: MediaState | null;
  artwork: string | null;
  /** The player's logo (PNG data URL from Windows); missing or null where there is none. */
  appIcon?: string | null;
}

/** What plays in Windows' media session, with its cover. */
export function useMedia(enabled: boolean): Media {
  const [state, setState] = useState<MediaState | null>(null);
  const [artwork, setArtwork] = useState<{ key: string | null; url: string | null }>({ key: null, url: null });
  usePoll(enabled, 1500, () => {
    callNative<MediaState | null>("media_state").then(
      (next) => setState(next && next.title ? next : null),
      () => setState(null),
    );
  });
  const key = state?.artworkKey ?? null;
  useEffect(() => {
    if (!enabled || key === artwork.key) return;
    if (key === null) {
      setArtwork({ key: null, url: null });
      return;
    }
    let alive = true;
    callNative<string | null>("media_artwork").then(
      (url) => alive && setArtwork({ key, url }),
      () => alive && setArtwork({ key, url: null }),
    );
    return () => {
      alive = false;
    };
  }, [enabled, key, artwork.key]);
  // The player's logo, asked again only when another player takes over (Rust caches it).
  const [appIcon, setAppIcon] = useState<{ source: string | null; url: string | null }>({ source: null, url: null });
  const source = state?.sourceAppId || null;
  useEffect(() => {
    if (!enabled || source === appIcon.source) return;
    if (source === null) {
      setAppIcon({ source: null, url: null });
      return;
    }
    let alive = true;
    callNative<string | null>("media_app_icon").then(
      (url) => alive && setAppIcon({ source, url: iconSrc(url) }),
      () => alive && setAppIcon({ source, url: null }),
    );
    return () => {
      alive = false;
    };
  }, [enabled, source, appIcon.source]);
  useEffect(() => {
    if (!enabled) setState(null);
  }, [enabled]);
  return { state: enabled ? state : null, artwork: enabled ? artwork.url : null, appIcon: enabled ? appIcon.url : null };
}

export interface SystemLoad {
  snapshot: SystemSnapshot | null;
  /** The hottest sensor Windows reports, if any. */
  hottest: TemperatureSensor | null;
}

/** The PC's load while the system module is on; temperatures more rarely. */
export function useSystemLoad(enabled: boolean): SystemLoad {
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [hottest, setHottest] = useState<TemperatureSensor | null>(null);
  usePoll(enabled, 2000, () => {
    callNative<SystemSnapshot>("system_snapshot").then(setSnapshot, () => setSnapshot(null));
  });
  usePoll(enabled, 10_000, () => {
    callNative<TemperatureSensor[]>("system_temperatures").then(
      (sensors) => setHottest(sensors.reduce<TemperatureSensor | null>((top, s) => (!top || s.celsius > top.celsius ? s : top), null)),
      () => setHottest(null),
    );
  });
  return { snapshot: enabled ? snapshot : null, hottest: enabled ? hottest : null };
}

/**
 * The output's real level for the visualizer, written straight into `--level` on
 * `target` (no React render per tick). Rust measures only while this is on.
 */
export function useLevel(active: boolean, target: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!active) return;
    void islandMeter(true).catch(() => {});
    const stop = listen<number>(ISLAND_EVENTS.level, ({ payload }) => {
      const level = Math.min(1, Math.max(0, Number(payload) || 0));
      target.current?.style.setProperty("--level", level.toFixed(3));
    });
    return () => {
      void islandMeter(false).catch(() => {});
      void stop.then((unlisten) => unlisten());
      target.current?.style.setProperty("--level", "0");
    };
  }, [active, target]);
}

/**
 * A made-up level for Island Studio's scenes, written to `--level` like the real one:
 * two slow waves that never quite repeat. Runs only while `active`.
 */
export function useDemoLevel(active: boolean, target: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!active) return;
    const element = target.current;
    const timer = setInterval(() => {
      const t = performance.now();
      const level = 0.42 + 0.3 * Math.sin(t / 210) + 0.22 * Math.sin(t / 83);
      element?.style.setProperty("--level", Math.min(1, Math.max(0.05, level)).toFixed(3));
    }, 90);
    return () => {
      clearInterval(timer);
      element?.style.setProperty("--level", "0");
    };
  }, [active, target]);
}

/** Ticks once a second while `active`, for countdowns and progress. */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return now;
}
