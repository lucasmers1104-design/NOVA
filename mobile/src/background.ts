// While the app is closed, Android lets it run about every 15 minutes (WorkManager):
// enough to deliver tasks waiting for the PC and to pick up what NOVA wants to say.
// Decided 2026-11-08: no push service, so this is how notices arrive with the app closed.
//
// The work goes through the app's own store and its one connection. A second
// connection beside a running app made every notice arrive twice and left the
// chat on screen behind the file on disk.

import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { useCompanion } from "./store";

export const NOTICES_TASK = "nova-companion-notices";
const LISTEN_MS = 8000;

TaskManager.defineTask(NOTICES_TASK, async () => {
  try {
    await useCompanion.getState().sync(LISTEN_MS);
  } catch {
    // The PC is off or elsewhere; next time.
  }
  return BackgroundTask.BackgroundTaskResult.Success;
});

export async function registerBackground(): Promise<void> {
  const registered = await TaskManager.isTaskRegisteredAsync(NOTICES_TASK);
  if (!registered) await BackgroundTask.registerTaskAsync(NOTICES_TASK, { minimumInterval: 15 });
}
