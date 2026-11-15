import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLivePosition } from "@/features/media/api";
import type { MediaState } from "@/features/media/api";
import { useNow, whileVisible } from "./time";

/** What Rust does to a window that is hidden or minimized (`set_page_visible`). */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

describe("timers in a window nobody sees", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 11, 14, 30, 0, 0));
  });

  afterEach(() => {
    setHidden(false);
    vi.useRealTimers();
  });

  it("runs only while the page is visible", () => {
    const stop = vi.fn();
    const start = vi.fn(() => stop);
    const end = whileVisible(start);
    expect(start).toHaveBeenCalledTimes(1);
    setHidden(true);
    expect(stop).toHaveBeenCalledTimes(1);
    setHidden(true);
    expect(stop).toHaveBeenCalledTimes(1);
    setHidden(false);
    expect(start).toHaveBeenCalledTimes(2);
    end();
    expect(stop).toHaveBeenCalledTimes(2);
    setHidden(true);
    setHidden(false);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("doesn't start in a window that is hidden from the beginning", () => {
    setHidden(true);
    const start = vi.fn(() => () => {});
    const end = whileVisible(start);
    expect(start).not.toHaveBeenCalled();
    setHidden(false);
    expect(start).toHaveBeenCalledTimes(1);
    end();
  });

  it("stops the clock while hidden and is right at once when the window is back", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useNow(1000);
    });
    // It ticks just after each full second.
    act(() => {
      vi.advanceTimersByTime(3010);
    });
    expect(result.current.getSeconds()).toBe(3);
    const visibleRenders = renders;

    setHidden(true);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(renders).toBe(visibleRenders);
    expect(vi.getTimerCount()).toBe(0);

    setHidden(false);
    expect(result.current.getMinutes()).toBe(31);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.getSeconds()).toBe(4);
  });

  it("doesn't move a song's position in a hidden window", () => {
    const playing = { status: "playing", positionMs: 10_000, durationMs: 200_000, sampledAtMs: Date.now() } as MediaState;
    const { result } = renderHook(() => useLivePosition(playing));
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current).toBe(12_000);
    setHidden(true);
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current).toBe(12_000);
    setHidden(false);
    expect(result.current).toBe(42_000);
  });
});
