// While the app is closed, Android lets it run about every 15 minutes (WorkManager):
// enough to deliver tasks waiting for the PC and to pick up what NOVA wants to say.
// Decided 2026-11-08: no push service, so this is how notices arrive with the app closed.

import { Connection, newId } from "@nova/companion-protocol/client";
import { applyMessage, noticeTitle } from "@nova/companion-protocol/state";
import * as BackgroundTask from "expo-background-task";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { socketFactory } from "./store";
import { identity, loadPc, loadState, saveState } from "./storage";

export const NOTICES_TASK = "nova-companion-notices";
const LISTEN_MS = 8000;

TaskManager.defineTask(NOTICES_TASK, async () => {
  try {
    const pc = await loadPc();
    const id = pc && (await identity(pc));
    if (!pc || !id) return BackgroundTask.BackgroundTaskResult.Success;
    let state = await loadState();
    const connection = await Connection.open(pc.hosts, id, socketFactory);
    await new Promise<void>((resolve) => {
      const done = setTimeout(() => connection.close(), LISTEN_MS);
      connection.onClose = () => {
        clearTimeout(done);
        resolve();
      };
      connection.onMessage = (message) => {
        state = applyMessage(state, message);
        if (message.type === "notices" && message.items.length) {
          for (const notice of message.items) {
            void Notifications.scheduleNotificationAsync({ content: { title: "NOVA", body: noticeTitle(notice.kind) }, trigger: null });
          }
          connection.send({ type: "notices.ack", id: newId(), ts: Date.now(), ids: message.items.map((n) => n.id) });
        }
        if (message.type === "approval.request") {
          void Notifications.scheduleNotificationAsync({ content: { title: "NOVA", body: noticeTitle("approval") }, trigger: null });
        }
      };
      connection.send({ type: "notices.get", id: newId(), ts: Date.now() });
      for (const task of state.outbox) connection.send(task);
    });
    await saveState(state);
  } catch {
    // The PC is off or elsewhere; next time.
  }
  return BackgroundTask.BackgroundTaskResult.Success;
});

export async function registerBackground(): Promise<void> {
  const registered = await TaskManager.isTaskRegisteredAsync(NOTICES_TASK);
  if (!registered) await BackgroundTask.registerTaskAsync(NOTICES_TASK, { minimumInterval: 15 });
}
