import { useEffect } from "react";
import { Pressable, View } from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from "react-native-reanimated";
import { haptic } from "../haptics";
import { motion, radius, themed, TOUCH } from "../theme";

const WIDTH = 50;
const HEIGHT = 30;
const THUMB = 24;
const TRAVEL = WIDTH - THUMB - 6;

export interface SwitchProps {
  value: boolean;
  onChange: (on: boolean) => void;
  /** What the switch turns on, for screen readers. */
  label: string;
  disabled?: boolean;
}

/** On and off, with a thumb that springs across. */
export function Switch({ value, onChange, label, disabled }: SwitchProps) {
  const styles = useStyles();
  const reduced = useReducedMotion();
  const on = useSharedValue(value ? 1 : 0);

  useEffect(() => {
    on.value = reduced ? (value ? 1 : 0) : withSpring(value ? 1 : 0, motion.spring);
  }, [value, reduced, on]);

  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: on.value * TRAVEL }] }));
  const fill = useAnimatedStyle(() => ({ opacity: on.value }));

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      disabled={disabled}
      // The track is 30 high; the touch target reaches the 44 a finger needs.
      hitSlop={{ top: (TOUCH - HEIGHT) / 2, bottom: (TOUCH - HEIGHT) / 2, left: 8, right: 8 }}
      onPress={() => {
        haptic("select");
        onChange(!value);
      }}
      style={disabled && styles.disabled}
    >
      <View style={styles.track}>
        <Animated.View style={[styles.fill, fill]} />
        <Animated.View style={[styles.thumb, thumb]} />
      </View>
    </Pressable>
  );
}

const useStyles = themed(({ colors }) => ({
  track: { width: WIDTH, height: HEIGHT, borderRadius: radius.pill, backgroundColor: colors.surfaceHigh, justifyContent: "center", paddingHorizontal: 3, overflow: "hidden" },
  fill: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: colors.accent },
  thumb: { width: THUMB, height: THUMB, borderRadius: THUMB / 2, backgroundColor: "#FFFFFF", elevation: 2, shadowColor: colors.shadow, shadowOpacity: 0.25, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } },
  disabled: { opacity: 0.45 },
}));
