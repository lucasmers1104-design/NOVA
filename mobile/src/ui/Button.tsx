import { ActivityIndicator, StyleSheet, View } from "react-native";
import type { Haptic } from "../haptics";
import { fonts, radius, space, themed, TOUCH, useTheme } from "../theme";
import { GlassSheen } from "./graphics";
import { Icon, type IconName } from "./Icon";
import { Press } from "./Press";
import { Text } from "./Text";

export interface ButtonProps {
  label: string;
  onPress: () => void;
  /** primary: the one thing to do here. secondary: beside it. danger: destroys or refuses. ghost: a way out. */
  kind?: "primary" | "secondary" | "danger" | "ghost";
  size?: "md" | "sm";
  icon?: IconName;
  disabled?: boolean;
  /** Shows a spinner and ignores taps. */
  busy?: boolean;
  haptic?: Haptic | false;
  /** Fill the row instead of hugging the label. */
  stretch?: boolean;
}

export function Button({ label, onPress, kind = "primary", size = "md", icon, disabled, busy, haptic, stretch = true }: ButtonProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const color = kind === "primary" ? colors.onPrimary : kind === "danger" ? colors.danger : colors.text;
  return (
    <Press
      label={label}
      state={{ busy: Boolean(busy) }}
      disabled={disabled || busy}
      onPress={onPress}
      haptic={haptic}
      containerStyle={stretch ? styles.stretch : styles.hug}
      style={[styles.button, size === "sm" && styles.small, kind === "primary" && styles.primary, kind === "secondary" && styles.secondary, kind === "danger" && styles.danger]}
    >
      {kind === "secondary" && (
        <View style={[StyleSheet.absoluteFill, styles.fill]}>
          <GlassSheen />
        </View>
      )}
      {busy ? <ActivityIndicator color={color} /> : icon ? <Icon name={icon} size={size === "sm" ? 17 : 19} color={color} /> : null}
      <Text variant={size === "sm" ? "callout" : "bodyStrong"} style={[styles.label, { color }]}>
        {label}
      </Text>
    </Press>
  );
}

export function IconButton({ icon, label, onPress, tone = "glass", disabled, size = TOUCH }: { icon: IconName; label: string; onPress: () => void; tone?: "glass" | "plain" | "accent"; disabled?: boolean; size?: number }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <Press label={label} onPress={onPress} disabled={disabled} style={[styles.round, { width: size, height: size, borderRadius: size / 2 }, tone === "glass" && styles.glass, tone === "accent" && { backgroundColor: colors.primary }]}>
      {tone === "glass" && <GlassSheen />}
      <Icon name={icon} size={20} color={tone === "accent" ? colors.onPrimary : colors.text} />
    </Press>
  );
}

const useStyles = themed(({ colors }) => ({
  stretch: { alignSelf: "stretch" },
  hug: { alignSelf: "flex-start" },
  // A minimum height, not a fixed one: with a large system font the label wraps and the button grows.
  button: { flexDirection: "row", gap: space.sm + 2, alignItems: "center", justifyContent: "center", minHeight: 56, paddingHorizontal: 24, paddingVertical: space.md, borderRadius: radius.pill, overflow: "hidden" },
  primary: { backgroundColor: colors.primary },
  small: { minHeight: TOUCH, paddingHorizontal: space.lg, paddingVertical: space.sm },
  fill: { borderRadius: radius.pill, overflow: "hidden" },
  secondary: { backgroundColor: colors.surfaceStrong, borderWidth: 1, borderColor: colors.border, borderTopColor: colors.borderTop },
  danger: { backgroundColor: colors.tints.red.bg },
  label: { fontFamily: fonts.semibold, flexShrink: 1, textAlign: "center" },
  round: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
  glass: { backgroundColor: colors.surfaceStrong, borderWidth: 1, borderColor: colors.border, borderTopColor: colors.borderTop },
}));
