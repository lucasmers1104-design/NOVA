// The app's own notifications: "Neue Freigabe", "Auftrag fertig". Local only, no
// push service, and never with content (decided 2026-11-08): details stay in the app.

import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";

const CHANNEL = "nova";

/** Where tapping the notification leads. */
export type NotifyTarget = "approvals" | "chat";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

/** Android shows a channel's name in the system settings; without this it would be "Miscellaneous". */
export async function prepareNotifications(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(CHANNEL, { name: "Aufträge und Freigaben", importance: Notifications.AndroidImportance.HIGH }).catch(() => {});
}

/** Shows a notification unless the app is in front, where the screen itself says it. */
export async function notify(body: string, open: NotifyTarget): Promise<void> {
  if (AppState.currentState === "active") return;
  const trigger = Platform.OS === "android" ? { channelId: CHANNEL } : null;
  await Notifications.scheduleNotificationAsync({ content: { title: "NOVA", body, data: { open } }, trigger }).catch(() => {});
}

/** The tap already acted on: Android hands out the last one again whenever it is asked. */
let handled: string | null = null;

/** Calls `open` when the user taps one of the app's notifications; returns the function that stops it. */
export function onNotificationTap(open: (target: NotifyTarget) => void): () => void {
  const read = (response: Notifications.NotificationResponse | null) => {
    if (!response || response.notification.request.identifier === handled) return;
    handled = response.notification.request.identifier;
    const target = response.notification.request.content.data?.open;
    if (target === "approvals" || target === "chat") open(target);
  };
  // The tap that started the app arrived before anyone listened.
  read(Notifications.getLastNotificationResponse());
  const subscription = Notifications.addNotificationResponseReceivedListener(read);
  return () => subscription.remove();
}
