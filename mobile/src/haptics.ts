// Small taps under the finger for actions that matter. One switch in the settings
// turns them all off; a phone without a vibration motor just stays quiet.

import * as Haptics from "expo-haptics";

export type Haptic = "tap" | "select" | "success" | "warning" | "error";

let enabled = true;

export function setHapticsEnabled(on: boolean): void {
  enabled = on;
}

export function haptic(kind: Haptic): void {
  if (!enabled) return;
  const done =
    kind === "tap"
      ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      : kind === "select"
        ? Haptics.selectionAsync()
        : Haptics.notificationAsync(kind === "success" ? Haptics.NotificationFeedbackType.Success : kind === "warning" ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Error);
  done.catch(() => {});
}
