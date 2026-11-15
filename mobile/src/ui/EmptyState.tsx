import { StyleSheet, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { space, themed, type TintName, useTheme } from "../theme";
import { Button } from "./Button";
import { GradientFill } from "./graphics";
import { Icon, type IconName } from "./Icon";
import { Text } from "./Text";

export interface StateAction {
  label: string;
  onPress: () => void;
  icon?: IconName;
}

function Illustration({ icon, tint }: { icon: IconName; tint: TintName }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const t = colors.tints[tint];
  return (
    <View style={styles.art} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg style={StyleSheet.absoluteFill} viewBox="0 0 132 132">
        <Circle cx="66" cy="66" r="65" stroke={t.fg} strokeOpacity={0.1} strokeWidth="1" fill="none" />
        <Circle cx="66" cy="66" r="50" stroke={t.fg} strokeOpacity={0.18} strokeWidth="1" fill="none" />
        <Circle cx="112" cy="30" r="3" fill={colors.cyan} fillOpacity={0.7} />
        <Circle cx="20" cy="96" r="2" fill={t.fg} fillOpacity={0.6} />
      </Svg>
      <View style={[styles.tile, { borderColor: t.bg }]}>
        {tint === "violet" ? <GradientFill opacity={0.22} /> : <View style={[StyleSheet.absoluteFill, { backgroundColor: t.bg }]} />}
        <Icon name={icon} size={30} color={t.fg} />
      </View>
    </View>
  );
}

/** Nothing here yet: a small drawing, what would be here, and the way to get it. */
export function EmptyState({ icon, title, text, action, tint = "violet" }: { icon: IconName; title: string; text: string; action?: StateAction; tint?: TintName }) {
  const styles = useStyles();
  return (
    <View style={styles.state}>
      <Illustration icon={icon} tint={tint} />
      <Text variant="headline" center>
        {title}
      </Text>
      <Text variant="callout" center style={styles.text}>
        {text}
      </Text>
      {action && (
        <View style={styles.action}>
          <Button label={action.label} icon={action.icon} kind="secondary" size="sm" stretch={false} onPress={action.onPress} />
        </View>
      )}
    </View>
  );
}

/** Something went wrong: what, in words the user can act on, and "Erneut versuchen". */
export function ErrorState({ title = "Das hat nicht geklappt", text, onRetry, retryLabel = "Erneut versuchen" }: { title?: string; text: string; onRetry?: () => void; retryLabel?: string }) {
  return <EmptyState icon="alert" tint="amber" title={title} text={text} action={onRetry ? { label: retryLabel, onPress: onRetry, icon: "refresh" } : undefined} />;
}

const useStyles = themed(() => ({
  state: { alignItems: "center", gap: space.sm + 2, paddingVertical: 36, paddingHorizontal: space.xl },
  art: { width: 132, height: 132, alignItems: "center", justifyContent: "center", marginBottom: space.xs },
  tile: { width: 68, height: 68, borderRadius: 24, alignItems: "center", justifyContent: "center", overflow: "hidden", borderWidth: 1 },
  text: { maxWidth: 320 },
  action: { marginTop: space.sm },
}));
