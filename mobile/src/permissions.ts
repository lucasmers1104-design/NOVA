// What Android has allowed the app, read fresh whenever the user comes back from
// Android's settings. Each permission is asked for where it is explained (onboarding,
// settings), never at start without a word.

import * as Notifications from "expo-notifications";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { useCallback, useEffect, useState } from "react";
import { AppState, Linking } from "react-native";
import { bridgeAvailable, NovaBridge } from "../modules/nova-bridge";
import { hasNotificationAccess, mayAnswerCalls, requestAnswerCalls } from "./phone";

export interface PermissionStates {
  /** The app's own notifications ("Neue Freigabe"). */
  notifications: boolean;
  /** Microphone and speech recognition, for dictation. */
  microphone: boolean;
  /** Reading other apps' notifications, for Nova Island. Granted in Android's settings, not by a dialog. */
  notificationAccess: boolean;
  /** Answering and ending calls itself, for phone apps that offer no buttons of their own. */
  answerCalls: boolean;
}

const NONE: PermissionStates = { notifications: false, microphone: false, notificationAccess: false, answerCalls: false };

async function read(): Promise<PermissionStates> {
  const [notifications, microphone] = await Promise.all([
    Notifications.getPermissionsAsync().then(
      (p) => p.granted,
      () => false,
    ),
    ExpoSpeechRecognitionModule.getPermissionsAsync().then(
      (p) => p.granted,
      () => false,
    ),
  ]);
  return { notifications, microphone, notificationAccess: hasNotificationAccess(), answerCalls: mayAnswerCalls() };
}

/** Android's page for this app, where a permission refused for good can still be turned on. */
export function openAppSettings(): void {
  void Linking.openSettings().catch(() => {});
}

export function usePermissions() {
  const [states, setStates] = useState(NONE);

  const refresh = useCallback(async () => setStates(await read()), []);

  useEffect(() => {
    void refresh();
    // Notification access is granted on a settings page: the answer is there when the user returns.
    const subscription = AppState.addEventListener("change", (now) => {
      if (now === "active") void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  /**
   * Asks with Android's dialog. After two refusals Android shows no dialog any more:
   * then this opens the app's settings page, the only place left to allow it.
   */
  const ask = useCallback(
    async (which: "notifications" | "microphone" | "answerCalls") => {
      let granted = false;
      try {
        if (which === "answerCalls") {
          const result = await requestAnswerCalls();
          granted = result === "granted";
          if (result === "blocked") openAppSettings();
        } else {
          const api = which === "notifications" ? Notifications : ExpoSpeechRecognitionModule;
          const before = await api.getPermissionsAsync();
          if (before.granted) granted = true;
          else if (!before.canAskAgain) openAppSettings();
          else granted = (await api.requestPermissionsAsync()).granted;
        }
      } catch {
        granted = false;
      }
      await refresh();
      return granted;
    },
    [refresh],
  );

  const openNotificationAccess = useCallback(() => NovaBridge?.openNotificationAccess(), []);

  return { states, ask, openNotificationAccess, bridgeAvailable };
}
