import { type RefObject, useEffect } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { nativeStorage } from "@/lib/persistence";

/** A setting the user changed, by the name its row shows (the same name the search jumps to). */
export interface RecentSetting {
  section: string;
  label: string;
  at: number;
}

/** As many as the Settings home shows. */
export const MAX_RECENT = 6;

/** Validates what was stored; anything malformed is dropped. */
export function sanitizeRecent(raw: unknown): RecentSetting[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is RecentSetting => typeof entry === "object" && entry !== null && typeof entry.section === "string" && typeof entry.label === "string" && typeof entry.at === "number" && Number.isFinite(entry.at))
    .map(({ section, label, at }) => ({ section: section.slice(0, 40), label: label.slice(0, 80), at }))
    .slice(0, MAX_RECENT);
}

interface RecentSettings {
  recent: RecentSetting[];
  record: (section: string, label: string, at?: number) => void;
  clear: () => void;
}

export const useRecentSettings = create<RecentSettings>()(
  persist(
    (set) => ({
      recent: [],
      // The newest first, each setting once: changing it again moves it back to the front.
      record: (section, label, at = Date.now()) => set((s) => ({ recent: [{ section, label, at }, ...s.recent.filter((r) => r.section !== section || r.label !== label)].slice(0, MAX_RECENT) })),
      clear: () => set({ recent: [] }),
    }),
    {
      name: "nova.settings.recent",
      storage: createJSONStorage(() => nativeStorage),
      partialize: (s) => ({ recent: s.recent }),
      merge: (persisted, current) => ({ ...current, recent: sanitizeRecent((persisted as { recent?: unknown } | null)?.recent) }),
    },
  ),
);

/** Controls whose click is a change. A radio that is already chosen changes nothing. */
const CLICKED = '[role="switch"], [role="radio"]:not([aria-checked="true"]), [role="checkbox"], [aria-pressed="false"], [data-records]';
/** Pointer travel (px) that makes a press a drag. */
const DRAG = 8;

/**
 * The row an event belongs to: the nearest element with `data-setting`. Inside
 * `data-no-record` nothing counts (a draft being tried on, a switch that asks first),
 * unless the control itself says it records (`data-records`, e.g. the button that applies the draft).
 */
function rowAt(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  if (target.closest("[data-no-record]") && !target.closest("[data-records]")) return null;
  return target.closest<HTMLElement>("[data-setting]");
}

/** For a change the page can't see happen: one decided in a dialog, or recorded from keys. */
export function recordChange(section: string, label: string): void {
  useRecentSettings.getState().record(section, label);
}

/**
 * Remembers which settings were changed, for "Zuletzt geändert" on the Settings home.
 * One listener on the page instead of a call in every control: every row carries its
 * name in `data-setting`, so what was touched says which setting it was. A row shown
 * outside its own section (the home's quick settings) names it in `data-setting-section`.
 */
export function useRecordChanges(page: RefObject<HTMLElement | null>, section: string): void {
  useEffect(() => {
    const root = page.current;
    if (!root) return;
    const record = (row: HTMLElement | null) => {
      const label = row?.dataset.setting;
      if (row && label) recordChange(row.dataset.settingSection ?? section, label);
    };

    // Text fields, sliders, selects and color pickers: when the value is committed.
    // A field in a form is committed by sending the form, not by leaving the field.
    const onChange = (event: Event) => {
      if (!(event.target instanceof Element && event.target.closest("form"))) record(rowAt(event.target));
    };
    const onSubmit = (event: Event) => record(rowAt(event.target));
    const onClick = (event: MouseEvent) => {
      const control = event.target instanceof Element ? event.target.closest(CLICKED) : null;
      if (control && !control.matches(":disabled")) record(rowAt(control));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.key.startsWith("Arrow") || !(event.target instanceof Element)) return;
      // A card that was picked up in a sortable list and is moved with the arrow keys.
      if (event.target.matches('[aria-pressed="true"]')) return record(rowAt(event.target));
      // Choice cards move the choice (and the focus) with the arrow keys.
      const radio = event.target.closest('[role="radio"]');
      if (!radio) return;
      requestAnimationFrame(() => {
        const now = document.activeElement;
        if (now !== radio && now?.matches('[role="radio"]')) record(rowAt(now));
      });
    };
    // Dragging a card to another place, or a chip into a slot.
    const onPointerDown = (down: PointerEvent) => {
      if (!(down.target instanceof Element) || !down.target.closest("li, button")) return;
      const row = rowAt(down.target);
      if (!row) return;
      const onUp = (up: PointerEvent) => {
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (up.type === "pointerup" && Math.hypot(up.clientX - down.clientX, up.clientY - down.clientY) >= DRAG) record(row);
      };
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };

    root.addEventListener("change", onChange);
    root.addEventListener("submit", onSubmit);
    root.addEventListener("click", onClick);
    root.addEventListener("keydown", onKeyDown);
    root.addEventListener("pointerdown", onPointerDown);
    return () => {
      root.removeEventListener("change", onChange);
      root.removeEventListener("submit", onSubmit);
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKeyDown);
      root.removeEventListener("pointerdown", onPointerDown);
    };
  }, [page, section]);
}

const UNITS: readonly [limit: number, seconds: number, unit: Intl.RelativeTimeFormatUnit][] = [
  [3600, 60, "minute"],
  [86_400, 3600, "hour"],
  [7 * 86_400, 86_400, "day"],
  [Number.POSITIVE_INFINITY, 7 * 86_400, "week"],
];

/** "vor 5 Minuten", "gestern": how long ago a setting was changed. */
export function ago(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "gerade eben";
  const [, size, unit] = UNITS.find(([limit]) => seconds < limit)!;
  return new Intl.RelativeTimeFormat("de", { numeric: "auto" }).format(-Math.floor(seconds / size), unit);
}
