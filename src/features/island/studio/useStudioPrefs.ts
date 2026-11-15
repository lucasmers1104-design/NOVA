import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { notifyError } from "@/features/notifications/store";
import { isDesktop } from "@/lib/native";
import { configureIsland, ISLAND_STATUS_KEY, islandStatus } from "../api";
import { DEFAULT_ISLAND_PREFS, type IslandPrefs, type IslandStatus } from "../types";
import { commit, type History, redo, startHistory, undo } from "./history";

/** How long a change waits before it is saved, so a dragged slider saves once. */
const SAVE_AFTER_MS = 300;

export type UpdatePrefs = (change: (prefs: IslandPrefs) => IslandPrefs, tag?: string) => void;

export interface StudioPrefs {
  /** `null` until Rust has answered. */
  prefs: IslandPrefs | null;
  status: IslandStatus | undefined;
  /** In the browser preview there is no Rust: everything works, nothing is kept. */
  desktop: boolean;
  update: UpdatePrefs;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * Island Studio's working copy of the preferences. Every change shows at once (the
 * stage draws from this copy), is saved a moment later, and can be taken back.
 */
export function useStudioPrefs(): StudioPrefs {
  const desktop = isDesktop();
  const client = useQueryClient();
  const { data: status } = useQuery({ queryKey: ISLAND_STATUS_KEY, queryFn: islandStatus, enabled: desktop });
  const [history, setHistory] = useState<History<IslandPrefs> | null>(desktop ? null : startHistory(DEFAULT_ISLAND_PREFS));
  // Rust's first answer is where the history starts.
  if (history === null && status) setHistory(startHistory(status.prefs));
  const prefs = history?.present ?? null;

  /** What Rust has, or has been sent: only a present that differs needs saving. */
  const sent = useRef<IslandPrefs | null>(null);
  if (sent.current === null && status) sent.current = status.prefs;
  const latest = useRef(prefs);
  latest.current = prefs;
  const request = useRef(0);

  const save = useCallback(
    (next: IslandPrefs) => {
      sent.current = next;
      const mine = ++request.current;
      configureIsland(next).then(
        // Only the newest answer counts; an older one would undo what came after it.
        (answer) => mine === request.current && client.setQueryData(ISLAND_STATUS_KEY, answer),
        (error: unknown) => {
          notifyError("Nova Island ließ sich nicht ändern", error);
          void client.invalidateQueries({ queryKey: ISLAND_STATUS_KEY });
        },
      );
    },
    [client],
  );

  useEffect(() => {
    if (!desktop || !prefs || prefs === sent.current) return;
    const timer = setTimeout(() => save(prefs), SAVE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [desktop, prefs, save]);

  // Leaving the page mid-wait must not lose the last change.
  useEffect(
    () => () => {
      if (desktop && latest.current && latest.current !== sent.current) save(latest.current);
    },
    [desktop, save],
  );

  const update = useCallback<UpdatePrefs>((change, tag) => setHistory((now) => (now ? commit(now, change(now.present), tag ?? null, Date.now()) : now)), []);
  const back = useCallback(() => setHistory((now) => (now ? undo(now) : now)), []);
  const forward = useCallback(() => setHistory((now) => (now ? redo(now) : now)), []);

  // Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z). A text field keeps its own undo.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey) return;
      // The target can be the window itself, which is no element.
      if (event.target instanceof Element && event.target.closest("input:not([type=range]), textarea, [contenteditable=true]")) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        back();
      } else if (key === "y" || (key === "z" && event.shiftKey)) {
        event.preventDefault();
        forward();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [back, forward]);

  return { prefs, status, desktop, update, undo: back, redo: forward, canUndo: (history?.past.length ?? 0) > 0, canRedo: (history?.future.length ?? 0) > 0 };
}
