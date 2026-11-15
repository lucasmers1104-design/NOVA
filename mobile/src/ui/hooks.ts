import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Keyboard } from "react-native";

/** Whether the on-screen keyboard is up: things that float at the bottom step aside. */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", () => setVisible(true));
    const hidden = Keyboard.addListener("keyboardDidHide", () => setVisible(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  return visible;
}

/** A clock for countdowns: the current time, refreshed every `everyMs` while mounted. */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** Closes the screen. Opened from a link there is nothing to go back to: then the start screen it is. */
export function goBack(): void {
  if (router.canGoBack()) router.back();
  else router.replace("/");
}
