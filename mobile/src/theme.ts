// NOVA's dark glass look on the phone. Accents from assets/brand/nova-icon.svg.
import { StyleSheet } from "react-native";

export const colors = {
  background: "#07070C",
  glass: "rgba(255,255,255,0.06)",
  glassStrong: "rgba(255,255,255,0.10)",
  rim: "rgba(255,255,255,0.12)",
  rimTop: "rgba(255,255,255,0.22)",
  text: "#F4F4F8",
  muted: "#A1A1B5",
  subtle: "#6E6E82",
  violet: "#8B5CF6",
  cyan: "#22D3EE",
  success: "#34D399",
  warning: "#FBBF24",
  danger: "#F87171",
};

export const radius = { card: 22, control: 14, pill: 999 };

export const ui = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  glass: {
    backgroundColor: colors.glass,
    borderColor: colors.rim,
    borderTopColor: colors.rimTop,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: radius.card,
    padding: 18,
  },
  title: { color: colors.text, fontSize: 28, fontWeight: "700", letterSpacing: -0.5 },
  heading: { color: colors.text, fontSize: 17, fontWeight: "600" },
  body: { color: colors.text, fontSize: 15, lineHeight: 21 },
  muted: { color: colors.muted, fontSize: 13.5, lineHeight: 19 },
  input: {
    color: colors.text,
    backgroundColor: "rgba(0,0,0,0.35)",
    borderColor: colors.rim,
    borderWidth: 1,
    borderRadius: radius.control,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
});
