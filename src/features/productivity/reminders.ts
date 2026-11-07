import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { useEffect } from "react";
import { notify } from "@/features/notifications/store";
import { isDesktop } from "@/lib/native";
import { readJson, writeJson } from "@/lib/persistence";
import { useSettings } from "@/stores/settings";
import { uiLocale } from "@/lib/time";
import { clockTime, dueReminders, reminderKey } from "./model";
import { useProductivity } from "./store";

const REMINDED_KEY = "nova.reminders";
const CHECK_INTERVAL_MS = 30_000;

async function showSystemNotification(title: string, body: string) {
  if (!isDesktop() || !useSettings.getState().systemNotifications) return;
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    // The in-app notification already covers this reminder.
  }
}

/**
 * Fires reminders for tasks whose due time has arrived, once per due moment,
 * while NOVA is running (including when it sits in the tray).
 */
export function useReminders(): void {
  useEffect(() => {
    let reminded = new Set<string>();
    let cancelled = false;

    const check = async () => {
      const store = useProductivity.getState();
      if (store.status === "idle") await store.load();
      const due = dueReminders(useProductivity.getState().tasks, new Date(), reminded);
      if (due.length === 0 || cancelled) return;
      for (const task of due) {
        reminded.add(reminderKey(task));
        const body = `Due at ${clockTime(task.dueTime!, useSettings.getState().use24HourClock, uiLocale())}${task.notes ? ` — ${task.notes.split("\n")[0]}` : ""}`;
        notify(task.title, { kind: "reminder", body });
        void showSystemNotification(`Reminder: ${task.title}`, body);
      }
      void writeJson(REMINDED_KEY, [...reminded].slice(-300));
    };

    void readJson(REMINDED_KEY).then((stored) => {
      if (Array.isArray(stored)) reminded = new Set(stored.filter((k): k is string => typeof k === "string"));
      if (!cancelled) void check();
    });
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
}
