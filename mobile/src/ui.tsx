// The few building blocks every screen uses: backdrop, glass card, buttons, icons.
import type { ReactNode } from "react";
import { ActivityIndicator, type ColorValue, Pressable, type StyleProp, StyleSheet, Text, View, type ViewStyle } from "react-native";
import Svg, { Circle, Defs, Path, RadialGradient, Rect, Stop } from "react-native-svg";
import { colors, radius, ui } from "./theme";

/** The dark background with NOVA's two soft lights, drawn once. */
export function Backdrop() {
  return (
    <Svg style={StyleSheet.absoluteFill} preserveAspectRatio="xMidYMid slice" viewBox="0 0 400 800">
      <Defs>
        <RadialGradient id="violet" cx="20%" cy="8%" r="60%">
          <Stop offset="0" stopColor={colors.violet} stopOpacity="0.32" />
          <Stop offset="1" stopColor={colors.violet} stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id="cyan" cx="95%" cy="70%" r="55%">
          <Stop offset="0" stopColor={colors.cyan} stopOpacity="0.16" />
          <Stop offset="1" stopColor={colors.cyan} stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Rect width="400" height="800" fill={colors.background} />
      <Rect width="400" height="800" fill="url(#violet)" />
      <Rect width="400" height="800" fill="url(#cyan)" />
    </Svg>
  );
}

export function Glass({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[ui.glass, style]}>{children}</View>;
}

interface ButtonProps {
  label: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  busy?: boolean;
  icon?: ReactNode;
}

export function Button({ label, onPress, kind = "primary", disabled, busy, icon }: ButtonProps) {
  const background = { primary: colors.violet, secondary: colors.glassStrong, danger: "rgba(248,113,113,0.18)", ghost: "transparent" }[kind];
  const color = kind === "danger" ? colors.danger : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled || busy), busy: Boolean(busy) }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: background, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 }, kind === "secondary" && styles.rim]}
    >
      {busy ? <ActivityIndicator color={color} /> : icon}
      <Text style={[styles.buttonText, { color }]}>{label}</Text>
    </Pressable>
  );
}

export function Dot({ color }: { color: string }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}

type IconName = "home" | "chat" | "tasks" | "shield" | "mic" | "send" | "plus" | "check" | "x" | "fingerprint" | "music" | "monitor" | "camera" | "image";

const PATHS: Record<IconName, string[]> = {
  home: ["M3 10.5 12 3l9 7.5", "M5 9.5V20h5v-6h4v6h5V9.5"],
  chat: ["M4 5h16v11H9l-5 4z"],
  tasks: ["M9 6h11", "M9 12h11", "M9 18h11", "M4 6h.01", "M4 12h.01", "M4 18h.01"],
  shield: ["M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z", "m9 12 2 2 4-4"],
  mic: ["M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z", "M5 11a7 7 0 0 0 14 0", "M12 18v3"],
  send: ["M4 12 20 4l-6 16-3-7z"],
  plus: ["M12 5v14", "M5 12h14"],
  check: ["m5 12 5 5 9-10"],
  x: ["M6 6l12 12", "M18 6 6 18"],
  fingerprint: ["M7 11a5 5 0 0 1 10 0v2", "M12 11v4a7 7 0 0 0 2 5", "M9 12v2a10 10 0 0 0 2 6", "M15 15a10 10 0 0 1-.5 3", "M5 9a7.5 7.5 0 0 1 14 0"],
  music: ["M9 18V5l11-2v13", "M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3z", "M20 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3z"],
  monitor: ["M3 4h18v12H3z", "M8 20h8", "M12 16v4"],
  camera: ["M4 7h4l2-3h4l2 3h4v12H4z", "M12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"],
  image: ["M4 4h16v16H4z", "m4 16 5-5 4 4 3-3 4 4", "M15 8h.01"],
};

export function Icon({ name, size = 22, color = colors.text }: { name: IconName; size?: number; color?: ColorValue }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {PATHS[name].map((d) => (
        <Path key={d} d={d} />
      ))}
    </Svg>
  );
}

/** NOVA's mark: a violet-to-cyan orb. */
export function Orb({ size = 40, active = false }: { size?: number; active?: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 40 40">
      <Defs>
        <RadialGradient id="orb" cx="35%" cy="30%" r="75%">
          <Stop offset="0" stopColor={colors.cyan} />
          <Stop offset="0.55" stopColor={colors.violet} />
          <Stop offset="1" stopColor="#3B1C8C" />
        </RadialGradient>
      </Defs>
      {active && <Circle cx="20" cy="20" r="19" fill={colors.violet} opacity={0.25} />}
      <Circle cx="20" cy="20" r={active ? 15 : 16} fill="url(#orb)" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  button: { flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center", minHeight: 48, paddingHorizontal: 20, borderRadius: radius.pill },
  buttonText: { fontSize: 15.5, fontWeight: "600" },
  rim: { borderWidth: 1, borderColor: colors.rim },
});
