import { beforeEach, describe, expect, it } from "vitest";
import { defaultSettings, sanitizeSettings, SETTINGS_STORAGE_KEY, useSettings } from "./settings";

describe("sanitizeSettings", () => {
  it("keeps valid fields", () => {
    expect(
      sanitizeSettings({ accent: { kind: "custom", color: "#ff5d8f" }, transparency: false, motion: "reduced", refreshIntervalMs: 5000 }),
    ).toEqual({ accent: { kind: "custom", color: "#ff5d8f" }, transparency: false, motion: "reduced", refreshIntervalMs: 5000 });
  });

  it("drops malformed fields instead of failing", () => {
    expect(
      sanitizeSettings({ accent: { kind: "preset", id: "neon" }, transparency: "yes", motion: "fast", refreshIntervalMs: 1, sidebarCollapsed: 1 }),
    ).toEqual({});
    expect(sanitizeSettings("garbage")).toEqual({});
    expect(sanitizeSettings(null)).toEqual({});
  });

  it("truncates overly long display names", () => {
    expect(sanitizeSettings({ displayName: "x".repeat(100) }).displayName).toHaveLength(40);
  });

  it("repairs navigation preferences", () => {
    const sanitized = sanitizeSettings({ navOrder: ["media", "media", "bogus", "home", "system"], navHidden: ["home", "files", "settings"] });
    expect(sanitized.navOrder?.slice(0, 2)).toEqual(["media", "system"]);
    expect(sanitized.navOrder).toHaveLength(8);
    expect(sanitized.navHidden).toEqual(["files"]);
  });

  it("validates the title bar clock", () => {
    expect(defaultSettings().titleBarClock).toBe("off");
    expect(sanitizeSettings({ titleBarClock: "time-date" }).titleBarClock).toBe("time-date");
    expect(sanitizeSettings({ titleBarClock: "sundial" }).titleBarClock).toBeUndefined();
  });

  it("accepts wallpaper-following accents", () => {
    expect(sanitizeSettings({ accent: { kind: "wallpaper", color: "#3366ff" } }).accent).toEqual({ kind: "wallpaper", color: "#3366ff" });
  });
});

describe("navigation preferences", () => {
  beforeEach(() => useSettings.setState(defaultSettings()));

  it("moves sections within bounds", () => {
    useSettings.getState().moveNavItem("system", 1);
    expect(useSettings.getState().navOrder.slice(0, 2)).toEqual(["apps", "system"]);
    useSettings.getState().moveNavItem("apps", -1);
    expect(useSettings.getState().navOrder[0]).toBe("apps");
  });

  it("hides, shows and resets sections", () => {
    useSettings.getState().setNavHidden("media", true);
    useSettings.getState().setNavHidden("media", true);
    expect(useSettings.getState().navHidden).toEqual(["media"]);
    useSettings.getState().resetNavigation();
    expect(useSettings.getState().navHidden).toEqual([]);
  });
});

describe("settings store persistence", () => {
  beforeEach(() => {
    useSettings.setState(defaultSettings());
  });

  it("persists changes to local storage", () => {
    useSettings.getState().setAccent({ kind: "preset", id: "amber" });
    useSettings.getState().toggleSidebar();

    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "{}");
    expect(stored.state.accent).toEqual({ kind: "preset", id: "amber" });
    expect(stored.state.sidebarCollapsed).toBe(true);
    // Actions are never serialized.
    expect(stored.state.setAccent).toBeUndefined();
  });

  it("rehydrates only valid persisted values", async () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ version: 1, state: { accent: { kind: "preset", id: "cyan" }, motion: "bogus" } }),
    );
    await useSettings.persist.rehydrate();

    expect(useSettings.getState().accent).toEqual({ kind: "preset", id: "cyan" });
    expect(useSettings.getState().motion).toBe("system");
  });

  it("resets to defaults", () => {
    useSettings.getState().setTransparency(false);
    useSettings.getState().resetSettings();
    expect(useSettings.getState().transparency).toBe(true);
  });
});
