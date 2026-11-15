import { View } from "react-native";
import Animated, { FadeInUp, FadeOutUp, useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { fonts, motion, radius, space, themed, type TintName, TOUCH, useTheme } from "../theme";
import { type ToastTone, useToasts } from "../toast";
import { Icon, type IconName } from "./Icon";
import { Press } from "./Press";
import { Text } from "./Text";

const LOOK: Record<ToastTone, { icon: IconName; tint: TintName }> = {
  neutral: { icon: "info", tint: "slate" },
  success: { icon: "check", tint: "green" },
  warning: { icon: "alert", tint: "amber" },
  danger: { icon: "x", tint: "red" },
};

/**
 * Shows the current toast (toast.ts). It sits at the top, under the status bar: there
 * it never covers the tab bar, a composer, a keyboard or the buttons at the bottom of
 * a dialog. Rendered once, in the root layout.
 */
export function ToastHost() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const current = useToasts((s) => s.current);
  const act = useToasts((s) => s.act);
  const expire = useToasts((s) => s.expire);
  if (!current) return null;
  const look = LOOK[current.tone];
  const tint = colors.tints[look.tint];
  return (
    <View style={[styles.host, { top: insets.top + space.sm }]} pointerEvents="box-none">
      <Animated.View
        key={current.id}
        entering={reduced ? undefined : FadeInUp.duration(motion.base)}
        exiting={reduced ? undefined : FadeOutUp.duration(motion.quick)}
        style={styles.toast}
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
      >
        <View style={[styles.icon, { backgroundColor: tint.bg }]}>
          <Icon name={look.icon} size={15} color={tint.fg} strokeWidth={2.2} />
        </View>
        <Text variant="callout" tone="text" style={styles.text}>
          {current.text}
        </Text>
        {current.action ? (
          <Press label={current.action.label} onPress={act} style={styles.action} haptic="select">
            <Text variant="callout" tone="accent" style={styles.actionText}>
              {current.action.label}
            </Text>
          </Press>
        ) : (
          <Press label="Hinweis schließen" onPress={() => expire(current.id)} style={styles.close} haptic={false}>
            <Icon name="x" size={16} color={colors.subtle} />
          </Press>
        )}
      </Animated.View>
    </View>
  );
}

const useStyles = themed(({ colors, elevation }) => ({
  host: { position: "absolute", left: space.md, right: space.md, alignItems: "center" },
  toast: { flexDirection: "row", alignItems: "center", gap: space.sm + 2, maxWidth: 520, alignSelf: "stretch", backgroundColor: colors.raised, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, borderTopColor: colors.borderTop, paddingLeft: space.md, paddingRight: space.xs, paddingVertical: space.xs, ...elevation.floating },
  icon: { width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  text: { flex: 1, paddingVertical: space.sm },
  action: { minHeight: TOUCH, paddingHorizontal: space.md, justifyContent: "center" },
  actionText: { fontFamily: fonts.semibold },
  close: { width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center" },
}));
