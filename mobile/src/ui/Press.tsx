import { type ReactNode, useRef } from "react";
import { type AccessibilityRole, type AccessibilityState, Pressable, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from "react-native-reanimated";
import { type Haptic, haptic as play } from "../haptics";
import { motion } from "../theme";

/** A second tap this soon after the first is the same intent: one task, one dialog. */
const DOUBLE_TAP_MS = 400;

export interface PressProps {
  children: ReactNode;
  onPress?: () => void;
  /** The shape: background, padding, radius. Scales while pressed. */
  style?: StyleProp<ViewStyle>;
  /** Where it sits in its parent (flex, width, alignSelf). */
  containerStyle?: StyleProp<ViewStyle>;
  disabled?: boolean;
  /** What a screen reader says. Leave out only if the children already say it. */
  label?: string;
  role?: AccessibilityRole;
  state?: AccessibilityState;
  haptic?: Haptic | false;
}

/** Everything tappable: springs down to 0.97 under the finger, ticks, and ignores a double tap. */
export function Press({ children, onPress, style, containerStyle, disabled, label, role = "button", state, haptic = "tap" }: PressProps) {
  const pressed = useSharedValue(0);
  const reduced = useReducedMotion();
  const last = useRef(0);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: 1 - pressed.value * (1 - motion.pressScale) }] }));

  const to = (value: number) => {
    if (!reduced) pressed.value = withSpring(value, motion.press);
  };

  const press = () => {
    const now = Date.now();
    if (now - last.current < DOUBLE_TAP_MS) return;
    last.current = now;
    if (haptic) play(haptic);
    onPress?.();
  };

  return (
    <Pressable
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled), ...state }}
      disabled={disabled}
      onPress={onPress ? press : undefined}
      onPressIn={() => to(1)}
      onPressOut={() => to(0)}
      style={containerStyle}
    >
      <Animated.View style={[style, animated, disabled && { opacity: 0.45 }]}>{children}</Animated.View>
    </Pressable>
  );
}
