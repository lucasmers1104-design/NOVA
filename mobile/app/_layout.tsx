import "../src/polyfills";
import "../src/background";
import * as Notifications from "expo-notifications";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { registerBackground } from "../src/background";
import { useCompanion } from "../src/store";
import { colors } from "../src/theme";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

export default function RootLayout() {
  const init = useCompanion((s) => s.init);
  useEffect(() => {
    void init();
    void Notifications.requestPermissionsAsync().catch(() => {});
    void registerBackground().catch(() => {});
  }, [init]);

  return (
    <>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background }, animation: "fade" }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="pair" options={{ presentation: "modal" }} />
        <Stack.Screen name="capture" options={{ presentation: "modal" }} />
        <Stack.Screen name="approval/[id]" options={{ presentation: "modal" }} />
      </Stack>
    </>
  );
}
