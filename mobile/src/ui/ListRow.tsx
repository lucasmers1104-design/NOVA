import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { radius, space, themed, type TintName, useTheme } from "../theme";
import { Icon, type IconName, IconTile } from "./Icon";
import { Press } from "./Press";
import { Switch } from "./Switch";
import { Text } from "./Text";

/** A group of rows on one glass card. */
export function ListGroup({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <View style={styles.group}>{children}</View>;
}

export interface ListRowProps {
  icon?: IconName;
  tint?: TintName;
  title: string;
  subtitle?: string;
  /** Short text on the right, e.g. "12 ms". */
  value?: string;
  /** Tapping the row does this; a chevron shows it. Not together with `toggle`. */
  onPress?: () => void;
  toggle?: { value: boolean; onChange: (on: boolean) => void; disabled?: boolean };
  /** Anything else on the right (a badge, a button). */
  right?: ReactNode;
  /** The last row in its group has no line under it. */
  last?: boolean;
  danger?: boolean;
  disabled?: boolean;
}

/** One line in a grouped list: icon tile, text, and a switch, a value or a chevron. */
export function ListRow({ icon, tint = "violet", title, subtitle, value, onPress, toggle, right, last, danger, disabled }: ListRowProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const body = (
    <View style={[styles.row, !last && styles.line]}>
      {icon && <IconTile name={icon} tint={danger ? "red" : tint} size={34} />}
      <View style={styles.text}>
        <Text tone={danger ? "danger" : "text"}>{title}</Text>
        {subtitle ? <Text variant="footnote">{subtitle}</Text> : null}
      </View>
      {value ? (
        <Text variant="callout" style={styles.value} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {right}
      {toggle && <Switch label={title} value={toggle.value} disabled={toggle.disabled} onChange={toggle.onChange} />}
      {onPress && !toggle && <Icon name="chevron" size={18} color={colors.subtle} />}
    </View>
  );
  if (!onPress || toggle) return body;
  return (
    <Press label={subtitle ? `${title}. ${subtitle}` : title} onPress={onPress} disabled={disabled} haptic={false}>
      {body}
    </Press>
  );
}

const useStyles = themed(({ colors }) => ({
  group: { backgroundColor: colors.surface, borderColor: colors.border, borderTopColor: colors.borderTop, borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: radius.xl, paddingHorizontal: space.md + 2, paddingVertical: space.xs },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md, minHeight: 58 },
  line: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  text: { flex: 1, gap: 2 },
  value: { maxWidth: "40%" },
}));
