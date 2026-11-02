import { beforeEach, describe, expect, it, vi } from "vitest";
import * as native from "./native";
import { nativeStorage, useStorageHealth } from "./persistence";

describe("nativeStorage", () => {
  beforeEach(() => useStorageHealth.setState({ error: null }));

  it("uses localStorage in the browser preview", async () => {
    await nativeStorage.setItem("nova.test", "1");
    expect(localStorage.getItem("nova.test")).toBe("1");
    expect(await nativeStorage.getItem("nova.test")).toBe("1");
  });

  describe("in the desktop app", () => {
    let db: Map<string, string>;

    beforeEach(() => {
      db = new Map();
      vi.spyOn(native, "isDesktop").mockReturnValue(true);
      vi.spyOn(native, "callNative").mockImplementation(async (command: string, args?: Record<string, unknown>) => {
        const key = args?.key as string;
        if (command === "settings_get") return db.get(key) ?? null;
        if (command === "settings_set") return void db.set(key, args?.value as string);
        if (command === "settings_delete") return void db.delete(key);
        throw new Error(command);
      });
    });

    it("reads and writes SQLite via commands", async () => {
      await nativeStorage.setItem("nova.settings", '{"a":1}');
      expect(db.get("nova.settings")).toBe('{"a":1}');
      expect(localStorage.getItem("nova.settings")).toBeNull();
      expect(await nativeStorage.getItem("nova.settings")).toBe('{"a":1}');
    });

    it("migrates Milestone 1 localStorage values into SQLite once", async () => {
      localStorage.setItem("nova.settings", '{"legacy":true}');

      expect(await nativeStorage.getItem("nova.settings")).toBe('{"legacy":true}');
      expect(db.get("nova.settings")).toBe('{"legacy":true}');
      expect(localStorage.getItem("nova.settings")).toBeNull();
    });

    it("falls back to localStorage and reports when the database fails", async () => {
      vi.mocked(native.callNative).mockRejectedValue(new Error("disk I/O error"));

      await nativeStorage.setItem("nova.settings", '{"b":2}');
      expect(localStorage.getItem("nova.settings")).toBe('{"b":2}');
      expect(await nativeStorage.getItem("nova.settings")).toBe('{"b":2}');
      expect(useStorageHealth.getState().error).toBe("disk I/O error");
    });
  });
});
