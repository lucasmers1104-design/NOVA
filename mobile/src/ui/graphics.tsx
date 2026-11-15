// NOVA's own drawings: the backdrop with its soft lights, the violet-to-cyan fill,
// and the orb that breathes only while NOVA works.
import { useEffect, useId } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import Svg, { Circle, Defs, LinearGradient, RadialGradient, Rect, Stop } from "react-native-svg";
import { useTheme } from "../theme";

/** The ground every screen stands on, drawn once per screen. */
export function Backdrop() {
  const { colors } = useTheme();
  return (
    <Svg style={StyleSheet.absoluteFill} preserveAspectRatio="xMidYMid slice" viewBox="0 0 400 860" pointerEvents="none">
      <Defs>
        <RadialGradient id="bd-violet" cx="12%" cy="4%" r="70%">
          <Stop offset="0" stopColor={colors.accent} stopOpacity={0.36 * colors.glow} />
          <Stop offset="0.55" stopColor={colors.accentDeep} stopOpacity={0.08 * colors.glow} />
          <Stop offset="1" stopColor={colors.accent} stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id="bd-cyan" cx="100%" cy="62%" r="60%">
          <Stop offset="0" stopColor={colors.cyan} stopOpacity={0.14 * colors.glow} />
          <Stop offset="1" stopColor={colors.cyan} stopOpacity="0" />
        </RadialGradient>
        <LinearGradient id="bd-fade" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={colors.background} stopOpacity="0" />
          <Stop offset="1" stopColor={colors.background} stopOpacity="0.9" />
        </LinearGradient>
      </Defs>
      <Rect width="400" height="860" fill={colors.background} />
      <Rect width="400" height="860" fill="url(#bd-violet)" />
      <Rect width="400" height="860" fill="url(#bd-cyan)" />
      <Rect y="560" width="400" height="300" fill="url(#bd-fade)" />
    </Svg>
  );
}

/** A diagonal fill for whatever it sits in (buttons, bubbles, tiles); violet to cyan unless told otherwise. */
export function GradientFill({ radius = 0, opacity = 1, from, to }: { radius?: number; opacity?: number; from?: string; to?: string }) {
  const { colors } = useTheme();
  const id = `g${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <Svg style={StyleSheet.absoluteFill} preserveAspectRatio="none" viewBox="0 0 100 100" pointerEvents="none">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={from ?? colors.accent} stopOpacity={opacity} />
          <Stop offset="1" stopColor={to ?? colors.cyan} stopOpacity={opacity} />
        </LinearGradient>
      </Defs>
      <Rect width="100" height="100" rx={radius} fill={`url(#${id})`} />
    </Svg>
  );
}

/** NOVA's mark. Its halo breathes while `active`; with reduced motion it just stays lit. */
export function Orb({ size = 40, active = false }: { size?: number; active?: boolean }) {
  const { colors } = useTheme();
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const pulse = useSharedValue(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (!active || reduced) {
      cancelAnimation(pulse);
      pulse.value = active ? 0.5 : 0;
      return;
    }
    pulse.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.quad) }), -1, true);
    return () => cancelAnimation(pulse);
  }, [active, reduced, pulse]);

  const halo = useAnimatedStyle(() => ({ opacity: 0.25 + pulse.value * 0.35, transform: [{ scale: 0.92 + pulse.value * 0.2 }] }));

  return (
    <View style={{ width: size, height: size }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {active && (
        <Animated.View style={[StyleSheet.absoluteFill, halo]}>
          <Svg width={size} height={size} viewBox="0 0 40 40">
            <Circle cx="20" cy="20" r="19.5" fill={colors.accent} opacity={0.35} />
          </Svg>
        </Animated.View>
      )}
      <Svg width={size} height={size} viewBox="0 0 40 40">
        <Defs>
          <RadialGradient id={`o${id}`} cx="34%" cy="28%" r="78%">
            <Stop offset="0" stopColor="#B9F6FF" />
            <Stop offset="0.28" stopColor="#22D3EE" />
            <Stop offset="0.62" stopColor="#8B5CF6" />
            <Stop offset="1" stopColor="#2A1170" />
          </RadialGradient>
          <RadialGradient id={`s${id}`} cx="32%" cy="24%" r="30%">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity="0.85" />
            <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Circle cx="20" cy="20" r={active ? 15 : 16} fill={`url(#o${id})`} />
        <Circle cx="20" cy="20" r={active ? 15 : 16} fill={`url(#s${id})`} />
      </Svg>
    </View>
  );
}
