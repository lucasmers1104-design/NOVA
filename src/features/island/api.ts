import { callNative } from "@/lib/native";
import type { IslandBoot, IslandPrefs, IslandStatus, SceneId } from "./types";

// The island window's own commands (capabilities/island.json).
export const islandReady = () => callNative<IslandBoot>("island_ready");
export const islandResize = (width: number, height: number) => callNative<void>("island_resize", { width, height });
export const islandMeter = (on: boolean) => callNative<void>("island_meter", { on });
export const islandCallAction = (callId: string, action: "accept" | "decline") => callNative<void>("island_call_action", { callId, action });
export const islandListen = () => callNative<void>("island_listen");

/** The query that holds `island_status` in NOVA's main window. */
export const ISLAND_STATUS_KEY = ["island", "status"] as const;

// The NOVA Island tab (main window).
export const islandStatus = () => callNative<IslandStatus>("island_status");
export const configureIsland = (prefs: IslandPrefs) => callNative<IslandStatus>("island_configure", { prefs });
/** Plays a scene on the real island for a few seconds; `null` ends it (Island Studio). */
export const previewIsland = (scene: SceneId | null) => callNative<void>("island_preview", { scene });
