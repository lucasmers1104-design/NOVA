import type { StateStorage } from "zustand/middleware";
import { create } from "zustand";
import { callNative, isDesktop } from "./native";

interface StorageHealth {
  /** Why native storage failed, if it did; settings then fall back to WebView storage. */
  error: string | null;
  report: (error: unknown) => void;
}

export const useStorageHealth = create<StorageHealth>()((set) => ({
  error: null,
  report: (error) => set({ error: error instanceof Error ? error.message : String(error) }),
}));

function localGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function localSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage full or disabled: nothing more we can do here.
  }
}

/**
 * zustand storage backed by NOVA's SQLite settings table in the desktop app.
 *
 * - Browser preview: plain localStorage.
 * - First desktop read of a key: migrates any Milestone 1 localStorage value into SQLite.
 * - Native failure: falls back to localStorage and records the reason, so settings
 *   still persist and Settings can explain what happened.
 */
export const nativeStorage: StateStorage<Promise<void>> = {
  async getItem(key) {
    if (!isDesktop()) return localGet(key);
    try {
      const stored = await callNative<string | null>("settings_get", { key });
      if (stored !== null) return stored;
      const legacy = localGet(key);
      if (legacy !== null) {
        await callNative("settings_set", { key, value: legacy });
        localStorage.removeItem(key);
      }
      return legacy;
    } catch (error) {
      useStorageHealth.getState().report(error);
      return localGet(key);
    }
  },

  async setItem(key, value) {
    if (!isDesktop()) return localSet(key, value);
    try {
      await callNative("settings_set", { key, value });
    } catch (error) {
      useStorageHealth.getState().report(error);
      localSet(key, value);
    }
  },

  async removeItem(key) {
    if (!isDesktop()) return localStorage.removeItem(key);
    try {
      await callNative("settings_delete", { key });
    } catch (error) {
      useStorageHealth.getState().report(error);
    }
    localStorage.removeItem(key);
  },
};

/** Reads a JSON value through `nativeStorage`; malformed data yields `null`. */
export async function readJson(key: string): Promise<unknown> {
  const raw = await nativeStorage.getItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): Promise<void> {
  return nativeStorage.setItem(key, JSON.stringify(value));
}
