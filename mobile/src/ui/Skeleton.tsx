import { useEffect } from "react";
import { type DimensionValue, View } from "react-native";
import Animated, { cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { radius as radii, space, themed } from "../theme";

/** A grey shape where content is about to be. Pulses gently; stands still with reduced motion. */
export function Skeleton({ width = "100%", height = 16, radius = radii.sm }: { width?: DimensionValue; height?: number; radius?: number }) {
  const styles = useStyles();
  const reduced = useReducedMotion();
  const pulse = useSharedValue(0);

  useEffect(() => {
    if (reduced) return;
    pulse.value = withRepeat(withTiming(1, { duration: 900 }), -1, true);
    return () => cancelAnimation(pulse);
  }, [reduced, pulse]);

  const animated = useAnimatedStyle(() => ({ opacity: 0.55 + pulse.value * 0.45 }));
  return <Animated.View style={[styles.block, { width, height, borderRadius: radius }, animated]} />;
}

/** The loading state of a screen: a header and a few cards' worth of shapes. */
export function SkeletonScreen({ rows = 3 }: { rows?: number }) {
  const styles = useStyles();
  return (
    <View style={styles.screen} accessibilityRole="progressbar" accessibilityLabel="Lädt">
      <Skeleton width="38%" height={14} />
      <Skeleton width="64%" height={34} radius={radii.md} />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={i === 0 ? 132 : 76} radius={radii.xl} />
      ))}
    </View>
  );
}

const useStyles = themed(({ colors }) => ({
  block: { backgroundColor: colors.surfaceStrong },
  screen: { gap: space.md, paddingHorizontal: space.page },
}));
