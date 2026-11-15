// NOVA's design tokens for the phone (1.2): two palettes with the same names, one
// spacing scale, one type scale in Inter, radii, elevation, blur and motion. Screens
// and components read these and nothing else, so dark and light can't drift apart.
//
// Dark is the look NOVA has on the PC: layered glass over a near-black ground with a
// light rim from above, violet-to-cyan accents from assets/brand/nova-icon.svg.
import { type ImageStyle, StyleSheet, type TextStyle, useColorScheme, type ViewStyle } from "react-native";
import { useAppearance } from "./appearance";

export interface Tint {
  fg: string;
  bg: string;
}

export interface Palette {
  /** For the status bar and Android's own dialogs. */
  scheme: "dark" | "light";
  background: string;
  /** Solid ground for things that must not show what is behind them (sheets). */
  raised: string;
  /** Glass: cards and rows. */
  surface: string;
  surfaceStrong: string;
  surfaceHigh: string;
  /** Text fields sit a step below the surface. */
  field: string;
  border: string;
  /** The rim of light on the upper edge of glass. */
  borderTop: string;
  text: string;
  muted: string;
  subtle: string;
  accent: string;
  /** Accent as text or icon on the background. */
  accentText: string;
  accentDeep: string;
  /** Text on an accent fill. */
  onAccent: string;
  cyan: string;
  success: string;
  warning: string;
  danger: string;
  /** The floating tab bar and toasts, over blur. */
  bar: string;
  /** The same without blur behind it (Android 11 and older). */
  barSolid: string;
  scrim: string;
  shadow: string;
  /** How strong the backdrop's coloured lights are. */
  glow: number;
  tints: Record<"violet" | "cyan" | "green" | "amber" | "red" | "slate", Tint>;
}

const dark: Palette = {
  scheme: "dark",
  background: "#05060B",
  raised: "#11131F",
  surface: "rgba(255,255,255,0.045)",
  surfaceStrong: "rgba(255,255,255,0.08)",
  surfaceHigh: "rgba(255,255,255,0.12)",
  field: "rgba(0,0,0,0.32)",
  border: "rgba(255,255,255,0.08)",
  borderTop: "rgba(255,255,255,0.18)",
  text: "#F5F6FA",
  muted: "#A3A6B8",
  subtle: "#7F839A",
  accent: "#8B5CF6",
  accentText: "#A78BFA",
  accentDeep: "#5B2FD6",
  onAccent: "#FFFFFF",
  cyan: "#22D3EE",
  success: "#34D399",
  warning: "#FBBF24",
  danger: "#F87171",
  bar: "rgba(15,16,26,0.62)",
  barSolid: "rgba(15,16,26,0.96)",
  scrim: "rgba(2,3,8,0.66)",
  shadow: "#000000",
  glow: 1,
  tints: {
    violet: { fg: "#C4B5FD", bg: "rgba(139,92,246,0.18)" },
    cyan: { fg: "#67E8F9", bg: "rgba(34,211,238,0.15)" },
    green: { fg: "#6EE7B7", bg: "rgba(52,211,153,0.15)" },
    amber: { fg: "#FCD34D", bg: "rgba(251,191,36,0.15)" },
    red: { fg: "#FCA5A5", bg: "rgba(248,113,113,0.15)" },
    slate: { fg: "#CBD5E1", bg: "rgba(148,163,184,0.14)" },
  },
};

// Light keeps the structure and turns the glass into paper: white cards on a cool grey,
// darker accents so text and icons hold 4.5:1 against them.
const light: Palette = {
  scheme: "light",
  background: "#F3F4F9",
  raised: "#FFFFFF",
  surface: "rgba(255,255,255,0.82)",
  surfaceStrong: "rgba(17,19,40,0.05)",
  surfaceHigh: "rgba(17,19,40,0.09)",
  field: "rgba(17,19,40,0.045)",
  border: "rgba(17,19,40,0.09)",
  borderTop: "rgba(255,255,255,0.95)",
  text: "#11131C",
  muted: "#51566B",
  subtle: "#6A6F85",
  accent: "#7C3AED",
  accentText: "#6D28D9",
  accentDeep: "#5B21B6",
  onAccent: "#FFFFFF",
  cyan: "#0E7490",
  success: "#047857",
  warning: "#B45309",
  danger: "#DC2626",
  bar: "rgba(255,255,255,0.66)",
  barSolid: "rgba(255,255,255,0.97)",
  scrim: "rgba(17,19,40,0.38)",
  shadow: "#1B1F3B",
  glow: 0.45,
  tints: {
    violet: { fg: "#6D28D9", bg: "rgba(124,58,237,0.12)" },
    cyan: { fg: "#0E7490", bg: "rgba(8,145,178,0.12)" },
    green: { fg: "#047857", bg: "rgba(5,150,105,0.12)" },
    amber: { fg: "#B45309", bg: "rgba(217,119,6,0.14)" },
    red: { fg: "#B91C1C", bg: "rgba(220,38,38,0.11)" },
    slate: { fg: "#475569", bg: "rgba(71,85,105,0.11)" },
  },
};

export type TintName = keyof Palette["tints"];

/** One scale for every gap and padding. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28, page: 20 } as const;

export const radius = { sm: 10, md: 14, lg: 18, xl: 24, pill: 999 } as const;

/** Nothing a finger has to hit is smaller than this (Android's own minimum is 48 dp, Apple's 44 pt). */
export const TOUCH = 44;

/** Room screens leave at the bottom for the floating tab bar. */
export const TAB_BAR_ROOM = 104;

// Inter, loaded once at start (app/_layout.tsx) under these names. One family name per
// weight and no `fontWeight` beside it: Android would thicken the face a second time.
export const fonts = {
  regular: "Inter_400Regular",
  semibold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
} as const;

export type TypeVariant = "display" | "title" | "headline" | "body" | "bodyStrong" | "callout" | "footnote" | "caption";

/** The type scale. Sizes scale with Android's font size setting; line heights follow. */
export const type: Record<TypeVariant, TextStyle> = {
  display: { fontFamily: fonts.bold, fontSize: 31, lineHeight: 37, letterSpacing: -0.8 },
  title: { fontFamily: fonts.bold, fontSize: 23, lineHeight: 29, letterSpacing: -0.45 },
  headline: { fontFamily: fonts.semibold, fontSize: 16.5, lineHeight: 22, letterSpacing: -0.2 },
  body: { fontFamily: fonts.regular, fontSize: 15.5, lineHeight: 22, letterSpacing: -0.1 },
  bodyStrong: { fontFamily: fonts.semibold, fontSize: 15.5, lineHeight: 22, letterSpacing: -0.1 },
  callout: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20 },
  footnote: { fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18 },
  caption: { fontFamily: fonts.semibold, fontSize: 11.5, lineHeight: 15, letterSpacing: 1.1, textTransform: "uppercase" },
};

/** How far fixed-size chrome (tab labels, badges) may grow with the system font size. */
export const CHROME_FONT_SCALE = 1.25;

/** Blur strength behind floating surfaces (expo-blur's 1 to 100). */
export const blur = { bar: 42 } as const;

/**
 * Motion. Presses and the tab pill are springs: they follow the finger and settle.
 * Things that appear or leave use short timed fades, so nothing bounces into view.
 */
export const motion = {
  pressScale: 0.97,
  press: { damping: 22, stiffness: 420, mass: 0.6 },
  spring: { damping: 20, stiffness: 240, mass: 0.9 },
  quick: 140,
  base: 220,
} as const;

export interface Theme {
  colors: Palette;
  /** Shadows by height: cards lie flat on the glass, bars and sheets float. */
  elevation: Record<"none" | "raised" | "floating", ViewStyle>;
}

function build(colors: Palette): Theme {
  const strength = colors.scheme === "dark" ? 1 : 0.5;
  return {
    colors,
    elevation: {
      none: {},
      raised: { elevation: 3, shadowColor: colors.shadow, shadowOpacity: 0.18 * strength, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
      floating: { elevation: 16, shadowColor: colors.shadow, shadowOpacity: 0.45 * strength, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } },
    },
  };
}

const darkTheme = build(dark);
const lightTheme = build(light);

/** The theme in use: the user's choice, or the phone's setting. */
export function useTheme(): Theme {
  const mode = useAppearance((s) => s.mode);
  const system = useColorScheme();
  const scheme = mode === "system" ? (system === "light" ? "light" : "dark") : mode;
  return scheme === "light" ? lightTheme : darkTheme;
}

/**
 * Styles that depend on the theme, made once per theme. Use like StyleSheet.create:
 * `const useStyles = themed((t) => ({ card: { backgroundColor: t.colors.surface } }))`.
 */
export function themed<T extends Record<string, ViewStyle | TextStyle | ImageStyle>>(factory: (theme: Theme) => T): () => T {
  const cache = new WeakMap<Theme, T>();
  return () => {
    const theme = useTheme();
    let styles = cache.get(theme);
    if (!styles) {
      styles = StyleSheet.create(factory(theme)) as T;
      cache.set(theme, styles);
    }
    return styles;
  };
}
