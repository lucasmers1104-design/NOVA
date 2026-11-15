import { type ColorValue, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { type TintName, useTheme } from "../theme";

const PATHS = {
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
  settings: [
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  ],
  chevron: ["m9 6 6 6-6 6"],
  back: ["m15 6-6 6 6 6"],
  bell: ["M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.9 1.9 0 0 0 3.4 0"],
  phone: ["M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"],
  download: ["M12 3v12", "m7 10 5 5 5-5", "M5 21h14"],
  wifi: ["M5 12.5a10 10 0 0 1 14 0", "M8.5 16a5 5 0 0 1 7 0", "M2 9a15 15 0 0 1 20 0", "M12 19.5h.01"],
  cable: ["M4 9h3v6H4z", "M7 12h4a3 3 0 0 1 3 3v2a3 3 0 0 0 3 3h3", "M17 3v3", "M20 3v3", "M16 6h5v4a2.5 2.5 0 0 1-5 0z"],
  usb: ["M12 3v15", "m9 6 3-3 3 3", "M7 11v2l5 3 5-3V9", "M17 9h.01", "M7 11h.01", "M12 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"],
  sparkles: ["M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z", "M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"],
  bolt: ["M13 2 4 14h7l-1 8 9-12h-7z"],
  trash: ["M4 7h16", "M10 11v6", "M14 11v6", "M5 7l1 13h12l1-13", "M9 7V4h6v3"],
  eyeOff: ["M3 3l18 18", "M10.6 6.1A10 10 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3 3.6", "M6.6 6.6A17 17 0 0 0 2.5 12S6 18 12 18a9.7 9.7 0 0 0 4.4-1", "M9.9 9.9a3 3 0 0 0 4.2 4.2"],
  refresh: ["M20 11a8 8 0 0 0-14.6-4.5L4 8", "M4 3v5h5", "M4 13a8 8 0 0 0 14.6 4.5L20 16", "M20 21v-5h-5"],
  island: ["M7 4h10a4 4 0 0 1 0 8H7a4 4 0 0 1 0-8z", "M4 17h16", "M7 20h10"],
  link: ["M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7", "M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"],
  lock: ["M6 11h12v9H6z", "M8 11V8a4 4 0 0 1 8 0v3"],
  play: ["M7 4v16l13-8z"],
  pause: ["M8 5v14", "M16 5v14"],
  next: ["M6 5v14l9-7z", "M18 5v14"],
  previous: ["M18 5v14l-9-7z", "M6 5v14"],
  note: ["M5 4h14v12l-4 4H5z", "M15 20v-4h4", "M8 9h8", "M8 13h5"],
  info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 11v5", "M12 8h.01"],
  alert: ["M12 3 2 20h20z", "M12 10v4", "M12 17h.01"],
  vibrate: ["M9 5h6v14H9z", "M5 9v6", "M19 9v6"],
  volumeOff: ["M4 9v6h4l5 4V5L8 9z", "m17 9 4 6", "m21 9-4 6"],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 22, color, strokeWidth = 1.8 }: { name: IconName; size?: number; color?: ColorValue; strokeWidth?: number }) {
  const { colors } = useTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? colors.text} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {PATHS[name].map((d) => (
        <Path key={d} d={d} />
      ))}
    </Svg>
  );
}

/** An icon on a tinted, rounded tile. */
export function IconTile({ name, tint = "violet", size = 40 }: { name: IconName; tint?: TintName; size?: number }) {
  const { colors } = useTheme();
  const t = colors.tints[tint];
  return (
    <View style={{ width: size, height: size, borderRadius: size * 0.32, backgroundColor: t.bg, alignItems: "center", justifyContent: "center" }}>
      <Icon name={name} size={size * 0.5} color={t.fg} />
    </View>
  );
}
