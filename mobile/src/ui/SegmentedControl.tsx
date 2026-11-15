import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from "react-native-reanimated";
import { haptic } from "../haptics";
import { fonts, motion, radius, themed, TOUCH, useTheme } from "../theme";
import { Icon, type IconName } from "./Icon";
import { Text } from "./Text";

export interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
}

const PAD = 4;

/** A few choices side by side; the marker slides to the chosen one. */
export function SegmentedControl<T extends string>({ options, value, onChange, label }: { options: readonly Segment<T>[]; value: T; onChange: (value: T) => void; label: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const [width, setWidth] = useState(0);
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  const segment = width > 0 ? (width - PAD * 2) / options.length : 0;
  const x = useSharedValue(0);

  useEffect(() => {
    const target = index * segment;
    x.value = reduced ? target : withSpring(target, motion.spring);
  }, [index, segment, reduced, x]);

  const marker = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

  return (
    <View style={styles.track} accessibilityRole="radiogroup" accessibilityLabel={label} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {segment > 0 && <Animated.View style={[styles.marker, { width: segment }, marker]} />}
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ selected }}
            onPress={() => {
              if (selected) return;
              haptic("select");
              onChange(option.value);
            }}
            style={styles.option}
          >
            {option.icon && <Icon name={option.icon} size={16} color={selected ? colors.text : colors.muted} />}
            <Text variant="callout" tone={selected ? "text" : "muted"} style={selected && styles.selected} numberOfLines={2} center>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const useStyles = themed(({ colors }) => ({
  track: { flexDirection: "row", padding: PAD, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderTopColor: colors.borderTop },
  marker: { position: "absolute", top: PAD, bottom: PAD, left: PAD, borderRadius: radius.pill, backgroundColor: colors.scheme === "dark" ? colors.surfaceHigh : colors.raised, borderWidth: 1, borderColor: colors.border, borderTopColor: colors.borderTop },
  option: { flex: 1, minHeight: TOUCH, flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", paddingHorizontal: 6, paddingVertical: 6 },
  selected: { fontFamily: fonts.semibold },
}));
