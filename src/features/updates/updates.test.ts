import { beforeEach, describe, expect, it, vi } from "vitest";
import * as native from "@/lib/native";
import { defaultSettings, sanitizeSettings, useSettings } from "@/stores/settings";
import { AUTO_INSTALL_DELAY_S, effectiveUpdateSource, useUpdates } from "./store";

const UPDATE = { version: "1.1.0", currentVersion: "1.0.0", notes: "Faster startup" };

function reset() {
  useUpdates.setState({ status: "idle", info: null, error: null, downloaded: 0, total: null, countdown: null, postponed: false });
  useSettings.setState({ ...defaultSettings(), updateSource: "lucawarmers/nova" });
}

describe("updates", () => {
  beforeEach(() => {
    reset();
    vi.spyOn(native, "isDesktop").mockReturnValue(true);
  });

  it("starts a countdown when an automatic check finds an update", async () => {
    const call = vi.spyOn(native, "callNative").mockResolvedValue(UPDATE);
    await useUpdates.getState().check({ automatic: true });

    expect(call).toHaveBeenCalledWith("update_check", { source: "lucawarmers/nova" });
    expect(useUpdates.getState()).toMatchObject({ status: "available", info: UPDATE, countdown: AUTO_INSTALL_DELAY_S });
  });

  it("waits for the user after a manual check", async () => {
    vi.spyOn(native, "callNative").mockResolvedValue(UPDATE);
    await useUpdates.getState().check({ automatic: false });
    expect(useUpdates.getState()).toMatchObject({ status: "available", countdown: null });
  });

  it("installs when the countdown reaches zero", async () => {
    // Tauri channels register a callback with the native bridge, which jsdom lacks.
    vi.stubGlobal("__TAURI_INTERNALS__", { transformCallback: () => 1 });
    const call = vi.spyOn(native, "callNative").mockImplementation(async (command: string) => (command === "update_check" ? UPDATE : undefined));
    await useUpdates.getState().check({ automatic: true });
    for (let i = 0; i < AUTO_INSTALL_DELAY_S; i++) useUpdates.getState().tick();
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith("update_install", expect.objectContaining({ onEvent: expect.anything() })));
    vi.unstubAllGlobals();
  });

  it("stops the countdown when postponed", async () => {
    vi.spyOn(native, "callNative").mockResolvedValue(UPDATE);
    await useUpdates.getState().check({ automatic: true });
    useUpdates.getState().postpone();
    useUpdates.getState().tick();
    expect(useUpdates.getState()).toMatchObject({ postponed: true, countdown: null, status: "available" });
  });

  it("reports up to date", async () => {
    vi.spyOn(native, "callNative").mockResolvedValue(null);
    await useUpdates.getState().check({ automatic: false });
    expect(useUpdates.getState().status).toBe("upToDate");
  });

  it("stays quiet when an automatic check fails, but explains manual failures", async () => {
    vi.spyOn(native, "callNative").mockRejectedValue(new Error("offline"));
    await useUpdates.getState().check({ automatic: true });
    expect(useUpdates.getState().status).toBe("idle");
    await useUpdates.getState().check({ automatic: false });
    expect(useUpdates.getState()).toMatchObject({ status: "error", error: "offline" });
  });

  it("asks for a source before checking", async () => {
    useSettings.setState({ updateSource: "" });
    expect(effectiveUpdateSource()).toBe("");
    await useUpdates.getState().check({ automatic: false });
    expect(useUpdates.getState().status).toBe("error");
  });

  it("validates persisted update settings", () => {
    expect(sanitizeSettings({ updateSource: "a/b", autoUpdate: false, lastSeenVersion: "1.0.0" })).toMatchObject({
      updateSource: "a/b",
      autoUpdate: false,
      lastSeenVersion: "1.0.0",
    });
    expect(sanitizeSettings({ lastSeenVersion: "<script>" }).lastSeenVersion).toBeUndefined();
  });

  it("keeps the last seen version when settings are reset", () => {
    useSettings.setState({ lastSeenVersion: "1.0.0", autoUpdate: false });
    useSettings.getState().resetSettings();
    expect(useSettings.getState()).toMatchObject({ lastSeenVersion: "1.0.0", autoUpdate: true });
  });
});
