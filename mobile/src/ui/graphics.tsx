// NOVA's own drawings: the backdrop with its soft lights, the violet-to-cyan fill,
// and the orb that breathes only while NOVA works.
import { useEffect, useId } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import Svg, { Circle, Defs, LinearGradient, RadialGradient, Rect, Stop } from "react-native-svg";
import { useTheme } from "../theme";

/** The ground every screen stands on, drawn once per screen: three soft lights behind the glass. */
export function Backdrop() {
  const { colors } = useTheme();
  const [top, side, bottom] = colors.lights;
  return (
    <Svg style={StyleSheet.absoluteFill} preserveAspectRatio="xMidYMid slice" viewBox="0 0 400 860" pointerEvents="none">
      <Defs>
        <RadialGradient id="bd-top" cx="18%" cy="6%" rx="62%" ry="42%">
          <Stop offset="0" stopColor={top} stopOpacity={0.55 * colors.glow} />
          <Stop offset="1" stopColor={top} stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id="bd-side" cx="98%" cy="34%" rx="52%" ry="36%">
          <Stop offset="0" stopColor={side} stopOpacity={0.28 * colors.glow} />
          <Stop offset="1" stopColor={side} stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id="bd-bottom" cx="28%" cy="98%" rx="62%" ry="40%">
          <Stop offset="0" stopColor={bottom} stopOpacity={0.22 * colors.glow} />
          <Stop offset="1" stopColor={bottom} stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Rect width="400" height="860" fill={colors.background} />
      <Rect width="400" height="860" fill="url(#bd-top)" />
      <Rect width="400" height="860" fill="url(#bd-side)" />
      <Rect width="400" height="860" fill="url(#bd-bottom)" />
    </Svg>
  );
}

/**
 * The light on a pane of glass: bright at the top edge, gone by the middle. Lies over a
 * surface's own colour; with the rim (borderTopColor) it reads as liquid glass.
 */
export function GlassSheen({ strength = 1 }: { strength?: number }) {
  const { colors } = useTheme();
  const id = `sh${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <Svg style={StyleSheet.absoluteFill} preserveAspectRatio="none" viewBox="0 0 100 100" pointerEvents="none">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#FFFFFF" stopOpacity={colors.sheen * strength} />
          <Stop offset="0.6" stopColor="#FFFFFF" stopOpacity={colors.sheen * strength * 0.25} />
          <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </LinearGradient>
      </Defs>
      <Rect width="100" height="100" fill={`url(#${id})`} />
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

/**
 * NOVA's mark: a bead of liquid glass with a colour glow low inside and a highlight
 * above. Its halo breathes while `active`; with reduced motion it just stays lit.
 */
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

  const halo = useAnimatedStyle(() => ({ opacity: 0.3 + pulse.value * 0.4, transform: [{ scale: 0.96 + pulse.value * 0.22 }] }));
  const dark = colors.scheme === "dark";

  return (
    <View style={{ width: size, height: size }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Animated.View style={[StyleSheet.absoluteFill, active ? halo : { opacity: 0.55 }]}>
        <Svg width={size} height={size} viewBox="0 0 40 40">
          <Defs>
            <RadialGradient id={`h${id}`} cx="50%" cy="60%" r="50%">
              <Stop offset="0" stopColor={colors.accent} stopOpacity="0.7" />
              <Stop offset="1" stopColor={colors.accent} stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Circle cx="20" cy="20" r="20" fill={`url(#h${id})`} />
        </Svg>
      </Animated.View>
      <Svg width={size} height={size} viewBox="0 0 40 40">
        <Defs>
          <RadialGradient id={`g${id}`} cx="66%" cy="104%" r="70%">
            <Stop offset="0" stopColor={colors.accent} stopOpacity="0.95" />
            <Stop offset="0.7" stopColor={colors.accent} stopOpacity="0.15" />
            <Stop offset="1" stopColor={colors.accent} stopOpacity="0" />
          </RadialGradient>
          <RadialGradient id={`s${id}`} cx="34%" cy="24%" r="42%">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity="0.85" />
            <Stop offset="0.6" stopColor="#FFFFFF" stopOpacity="0.1" />
            <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Circle cx="20" cy="20" r="15.5" fill={dark ? "rgba(255,255,255,0.08)" : "rgba(91,75,234,0.12)"} />
        <Circle cx="20" cy="20" r="15.5" fill={`url(#g${id})`} />
        <Circle cx="20" cy="20" r="15.5" fill={`url(#s${id})`} />
        <Circle cx="20" cy="20" r="15.1" fill="none" stroke="#FFFFFF" strokeOpacity={dark ? 0.35 : 0.8} strokeWidth="0.8" />
      </Svg>
    </View>
  );
}
