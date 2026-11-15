import { emit } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { notify } from "@/features/notifications/store";
import { ASSISTANT_EVENTS } from "@/features/nova-assistant/types";
import { callNative, isDesktop } from "@/lib/native";

/** A task reminder that fired while no main window existed (reminders.rs). */
const REMINDER_EVENT = "nova://reminder";

/** Mirrors `MainReady` in src-tauri/src/desktop.rs. */
export interface MainReady {
  goTo: { route: string; section: string } | null;
  missed: { event: string; payload: unknown }[];
}

/**
 * Hands the page what it missed: closing to the tray ends the main window, and
 * until it is made again nobody is there for "Pair this phone?" or a reminder.
 */
export function catchUp(ready: MainReady): void {
  // Through the events themselves: whoever handles them live handles them now.
  if (ready.goTo) void emit(ASSISTANT_EVENTS.navigate, ready.goTo).catch(() => {});
  for (const { event, payload } of ready.missed) {
    if (event !== REMINDER_EVENT) {
      void emit(event, payload).catch(() => {});
      continue;
    }
    // Windows already showed it; this is the entry in NOVA's own notification list.
    const reminder = payload as { title?: unknown; body?: unknown } | null;
    if (typeof reminder?.title === "string") notify(reminder.title, { kind: "reminder", body: typeof reminder.body === "string" ? reminder.body : undefined, toast: false });
  }
}

/**
 * Tells Rust that the main window's page is up. Called last in the app shell:
 * by the time Rust answers, every listener in the page is registered.
 */
export function useMainWindowReady(): void {
  useEffect(() => {
    if (!isDesktop()) return;
    void callNative<MainReady>("desktop_main_ready").then(catchUp, () => {});
  }, []);
}
