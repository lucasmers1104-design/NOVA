import { liveApprovals } from "@nova/companion-protocol/state";
import { BlurView } from "expo-blur";
import { Redirect, router, Tabs } from "expo-router";
import type { BottomTabBarProps } from "expo-router/tabs";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { haptic } from "../../src/haptics";
import { onNotificationTap } from "../../src/notify";
import { useCompanion } from "../../src/store";
import { blur, CHROME_FONT_SCALE, fonts, motion, radius, themed, TOUCH, useTheme } from "../../src/theme";
import { toast } from "../../src/toast";
import { CountBadge, GradientFill, Icon, type IconName, Screen, SkeletonScreen, Text, useBlurTarget, useKeyboardVisible, useNow } from "../../src/ui";

const ICONS: Record<string, IconName> = { index: "home", chat: "chat", tasks: "tasks", approvals: "shield" };
const PILL_WIDTH = 56;
// Android blurs with RenderEffect from version 12 (API 31). Older phones get the same bar, just less see-through.
const CAN_BLUR = Platform.OS !== "android" || Number(Platform.Version) >= 31;

/** The floating bar: glass over the blurred screen, with a pill that springs to the active tab. */
function TabBar({ state, descriptors, navigateToTab, insets }: BottomTabBarProps) {
  const styles = useStyles();
  const { colors, elevation } = useTheme();
  const target = useBlurTarget((s) => s.target);
  const blurred = CAN_BLUR && target !== null;
  const keyboard = useKeyboardVisible();
  const reduced = useReducedMotion();
  const [width, setWidth] = useState(0);
  const tab = width > 0 ? width / state.routes.length : 0;
  const x = useSharedValue(0);

  useEffect(() => {
    const to = state.index * tab + (tab - PILL_WIDTH) / 2;
    x.value = reduced ? to : withSpring(to, motion.spring);
  }, [state.index, tab, reduced, x]);

  const pill = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

  // The keyboard needs the room, and a bar floating on top of it helps no one.
  if (keyboard) return null;

  return (
    <View style={[styles.wrap, { bottom: Math.max(insets.bottom, 10) + 6 }]} pointerEvents="box-none">
      {/* A shadow under see-through glass shows through it as a grey smudge, so only the solid bar casts one. */}
      <View style={[styles.bar, !blurred && elevation.floating]}>
        <BlurView
          style={StyleSheet.absoluteFill}
          tint={colors.scheme}
          intensity={blur.bar}
          blurMethod="dimezisBlurViewSdk31Plus"
          blurTarget={target ?? undefined}
        />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: blurred ? colors.bar : colors.barSolid }]} />
        <View style={styles.tabs} accessibilityRole="tablist" onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
          {tab > 0 && (
            <Animated.View style={[styles.pill, pill]} pointerEvents="none">
              <GradientFill opacity={0.3} />
            </Animated.View>
          )}
          {state.routes.map((route, index) => {
            const options = descriptors[route.key]?.options ?? {};
            const focused = state.index === index;
            const label = typeof options.title === "string" ? options.title : route.name;
            const badge = typeof options.tabBarBadge === "number" ? options.tabBarBadge : 0;
            return (
              <Pressable
                key={route.key}
                accessibilityRole="tab"
                accessibilityState={{ selected: focused }}
                accessibilityLabel={badge ? `${label}, ${badge} offen` : label}
                onPress={() => {
                  if (focused) return;
                  haptic("select");
                  navigateToTab(route.key);
                }}
                style={styles.tab}
              >
                <View style={styles.icon}>
                  <Icon name={ICONS[route.name] ?? "home"} size={21} color={focused ? colors.text : colors.subtle} strokeWidth={focused ? 2 : 1.8} />
                  {badge > 0 && (
                    <View style={styles.badge}>
                      <CountBadge count={badge} />
                    </View>
                  )}
                </View>
                {/* Capped: four labels share the width of the screen, whatever the system font size. */}
                <Text variant="footnote" maxFontSizeMultiplier={CHROME_FONT_SCALE} numberOfLines={1} style={[styles.label, { color: focused ? colors.text : colors.subtle }]}>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

export default function TabsLayout() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const ready = useCompanion((s) => s.ready);
  const paired = useCompanion((s) => s.pc !== null);
  const approvals = useCompanion((s) => s.approvals);
  const offset = useCompanion((s) => s.clockOffset);
  const now = useNow(5000);
  const open = liveApprovals(approvals, now + offset);
  const told = useRef(new Set<string>());

  useEffect(() => onNotificationTap((target) => router.navigate(target === "approvals" ? "/approvals" : "/chat")), []);

  // An approval is only good for two minutes: say so wherever the user is in the app.
  // Once per approval; the PC sends open ones again after every reconnect.
  const fresh = open.filter((request) => !told.current.has(request.requestId)).map((request) => request.requestId);
  const freshKey = fresh.join();
  useEffect(() => {
    if (!freshKey) return;
    for (const id of freshKey.split(",")) told.current.add(id);
    haptic("warning");
    toast("NOVA braucht deine Freigabe", { tone: "warning", action: { label: "Ansehen", onPress: () => router.navigate("/approvals") } });
  }, [freshKey]);

  // Until the saved pairing is read there is nothing true to show: not the start
  // screen, and not the welcome either.
  if (!ready) {
    return (
      <Screen style={{ paddingTop: insets.top + 24 }}>
        <SkeletonScreen />
      </Screen>
    );
  }
  if (!paired) return <Redirect href="/pair" />;

  return (
    <Tabs tabBar={(props) => <TabBar {...props} />} screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.background } }}>
      <Tabs.Screen name="index" options={{ title: "Start" }} />
      <Tabs.Screen name="chat" options={{ title: "Chat" }} />
      <Tabs.Screen name="tasks" options={{ title: "Aufgaben" }} />
      <Tabs.Screen name="approvals" options={{ title: "Freigaben", tabBarBadge: open.length > 0 ? open.length : undefined }} />
    </Tabs>
  );
}

const useStyles = themed(({ colors }) => ({
  wrap: { position: "absolute", left: 16, right: 16 },
  bar: { borderRadius: 28, borderWidth: 1, borderColor: colors.border, borderTopColor: colors.borderTop, overflow: "hidden" },
  tabs: { flexDirection: "row", paddingVertical: 8 },
  tab: { flex: 1, alignItems: "center", gap: 3, minHeight: TOUCH, justifyContent: "center" },
  icon: { width: PILL_WIDTH, height: 30, alignItems: "center", justifyContent: "center" },
  pill: { position: "absolute", top: 8, left: 0, width: PILL_WIDTH, height: 30, borderRadius: radius.pill, backgroundColor: colors.tints.violet.bg, overflow: "hidden" },
  label: { fontFamily: fonts.semibold, fontSize: 11, lineHeight: 14, letterSpacing: 0.1 },
  badge: { position: "absolute", top: -4, right: 4 },
}));
