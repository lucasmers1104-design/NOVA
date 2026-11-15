import { View } from "react-native";
import { CHROME_FONT_SCALE, fonts, radius, themed, type TintName, useTheme } from "../theme";
import { Text } from "./Text";

/** A small rounded label, optionally with a status dot: "Verbunden", "KI bereit", "Schwer rückgängig". */
export function Badge({ label, tint, dot }: { label: string; tint?: TintName; dot?: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const t = tint ? colors.tints[tint] : null;
  return (
    <View style={[styles.badge, t && { backgroundColor: t.bg, borderColor: "transparent" }]}>
      {dot && <Dot color={dot} size={7} />}
      <Text variant="footnote" style={[styles.label, { color: t ? t.fg : colors.text }]}>
        {label}
      </Text>
    </View>
  );
}

/** A count on top of something else (the Approvals tab). Stays small with a large system font. */
export function CountBadge({ count }: { count: number }) {
  const styles = useStyles();
  return (
    <View style={styles.count}>
      <Text variant="footnote" maxFontSizeMultiplier={CHROME_FONT_SCALE} style={styles.countText}>
        {count > 9 ? "9+" : count}
      </Text>
    </View>
  );
}

export function Dot({ color, size = 8 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

const useStyles = themed(({ colors }) => ({
  badge: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: colors.surfaceStrong, borderWidth: 1, borderColor: colors.border, alignSelf: "flex-start" },
  label: { fontFamily: fonts.semibold },
  count: { minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: colors.warning, alignItems: "center", justifyContent: "center" },
  countText: { fontFamily: fonts.bold, fontSize: 10.5, lineHeight: 14, color: "#1A1406" },
}));
