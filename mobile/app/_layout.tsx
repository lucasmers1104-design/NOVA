import "../src/polyfills";
import "../src/background";
import { Inter_400Regular } from "@expo-google-fonts/inter/400Regular";
import { Inter_600SemiBold } from "@expo-google-fonts/inter/600SemiBold";
import { Inter_700Bold } from "@expo-google-fonts/inter/700Bold";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { registerBackground } from "../src/background";
import { prepareNotifications } from "../src/notify";
import { useCompanion } from "../src/store";
import { useTheme } from "../src/theme";
import { ToastHost } from "../src/ui";

export default function RootLayout() {
  const init = useCompanion((s) => s.init);
  const { colors } = useTheme();
  // Inter under the names the type scale uses (src/theme.ts). If loading fails the app
  // still works: Android then draws its own font.
  const [fontsLoaded, fontsFailed] = useFonts({ Inter_400Regular, Inter_600SemiBold, Inter_700Bold });

  useEffect(() => {
    void init();
    void prepareNotifications();
    void registerBackground().catch(() => {});
  }, [init]);

  const frame = { flex: 1, backgroundColor: colors.background };
  // A moment of plain background instead of text that jumps from one font to another.
  if (!fontsLoaded && !fontsFailed) return <View style={frame} />;

  return (
    <GestureHandlerRootView style={frame}>
      <StatusBar style={colors.scheme === "dark" ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background }, animation: "fade" }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="pair" />
        <Stack.Screen name="settings" options={{ animation: "slide_from_right" }} />
        <Stack.Screen name="capture" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
        <Stack.Screen name="approval/[id]" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
      </Stack>
      <ToastHost />
    </GestureHandlerRootView>
  );
}
