import { Text as NativeText, type TextProps as NativeTextProps } from "react-native";
import { type Palette, type, type TypeVariant, useTheme } from "../theme";

export type Tone = "text" | "muted" | "subtle" | "accent" | "success" | "warning" | "danger" | "onAccent";

export function toneColor(colors: Palette, tone: Tone): string {
  switch (tone) {
    case "text":
      return colors.text;
    case "muted":
      return colors.muted;
    case "subtle":
      return colors.subtle;
    case "accent":
      return colors.accentText;
    case "success":
      return colors.success;
    case "warning":
      return colors.warning;
    case "danger":
      return colors.danger;
    case "onAccent":
      return colors.onAccent;
  }
}

const DEFAULT_TONE: Record<TypeVariant, Tone> = { display: "text", title: "text", headline: "text", body: "text", bodyStrong: "text", callout: "muted", footnote: "muted", caption: "subtle" };

export interface TextProps extends NativeTextProps {
  variant?: TypeVariant;
  tone?: Tone;
  center?: boolean;
}

/** Text in the type scale and the theme's colours. Scales with the system font size unless told otherwise. */
export function Text({ variant = "body", tone, center, style, ...rest }: TextProps) {
  const { colors } = useTheme();
  return <NativeText {...rest} style={[type[variant], { color: toneColor(colors, tone ?? DEFAULT_TONE[variant]) }, center && { textAlign: "center" }, style]} />;
}
