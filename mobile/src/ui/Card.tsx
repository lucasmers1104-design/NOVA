import type { ReactNode } from "react";
import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { radius, space, themed } from "../theme";
import { GradientFill } from "./graphics";
import { Press } from "./Press";

export interface CardProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** A violet-to-cyan wash and a brighter rim, for the one card that leads the screen. */
  accent?: boolean;
  /** A red rim: what is on it can't easily be undone. */
  danger?: boolean;
  /** Makes the whole card a button. `label` is what a screen reader says for it. */
  onPress?: () => void;
  label?: string;
}

/** A sheet of glass: the surface every group of content lies on. */
export function Card({ children, style, accent, danger, onPress, label }: CardProps) {
  const styles = useStyles();
  const body = (
    <>
      {accent && (
        <View style={[StyleSheet.absoluteFill, styles.wash]} pointerEvents="none">
          <GradientFill />
        </View>
      )}
      {children}
    </>
  );
  const shape = [styles.card, accent && styles.accent, danger && styles.danger, style];
  return onPress ? (
    <Press label={label} onPress={onPress} style={shape}>
      {body}
    </Press>
  ) : (
    <View style={shape}>{body}</View>
  );
}

const useStyles = themed(({ colors }) => ({
  card: { backgroundColor: colors.surface, borderColor: colors.border, borderTopColor: colors.borderTop, borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: radius.xl, padding: space.lg + 2, overflow: "hidden" },
  accent: { borderColor: colors.tints.violet.bg, borderTopColor: colors.tints.violet.fg },
  danger: { borderColor: colors.tints.red.bg, borderTopColor: colors.danger },
  wash: { opacity: 0.16 },
}));
