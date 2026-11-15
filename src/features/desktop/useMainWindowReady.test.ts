import { emit } from "@tauri-apps/api/event";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNotifications } from "@/features/notifications/store";
import * as native from "@/lib/native";
import { useUi } from "@/stores/ui";
import { catchUp, useMainWindowReady } from "./useMainWindowReady";

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}) }));

describe("a main window that comes back", () => {
  beforeEach(() => {
    vi.mocked(emit).mockClear();
    useNotifications.getState().clear();
  });

  it("gets the question that was asked while it didn't exist", () => {
    catchUp({ goTo: null, missed: [{ event: "companion://pair-request", payload: { deviceName: "Pixel 9", platform: "android" } }] });
    expect(emit).toHaveBeenCalledWith("companion://pair-request", { deviceName: "Pixel 9", platform: "android" });
    expect(useNotifications.getState().items).toEqual([]);
  });

  it("lists the reminders that fired meanwhile, without popping them up again", () => {
    catchUp({ goTo: null, missed: [{ event: "nova://reminder", payload: { title: "Call the dentist", body: "Due at 14:30" } }, { event: "nova://reminder", payload: null }] });
    const { items, toasts } = useNotifications.getState();
    expect(items.map((item) => [item.kind, item.title, item.body])).toEqual([["reminder", "Call the dentist", "Due at 14:30"]]);
    expect(toasts).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });

  it("goes where it was asked to while it was loading", () => {
    catchUp({ goTo: { route: "settings", section: "assistant" }, missed: [] });
    expect(emit).toHaveBeenCalledWith("nova://navigate", { route: "settings", section: "assistant" });
  });

  it("tells Rust once that the page is up", async () => {
    vi.spyOn(native, "isDesktop").mockReturnValue(true);
    const call = vi.spyOn(native, "callNative").mockResolvedValue({ goTo: null, missed: [{ event: "nova://reminder", payload: { title: "Stand up" } }] });
    const { rerender } = renderHook(() => useMainWindowReady());
    rerender();
    await waitFor(() => expect(useNotifications.getState().items).toHaveLength(1));
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("desktop_main_ready");
    expect(useUi.getState().route).toBe("home");
  });

  it("does nothing in a plain browser", () => {
    vi.spyOn(native, "isDesktop").mockReturnValue(false);
    const call = vi.spyOn(native, "callNative");
    renderHook(() => useMainWindowReady());
    expect(call).not.toHaveBeenCalled();
  });
});
