// How the island's preferences become its looks: CSS variables on `.island-stage`,
// read by island.css. Pure functions, shared by the island's window and Island Studio,
// so a change of look never rebuilds anything.

import type { CSSProperties } from "react";
import { deriveAccentTokens } from "@/design/accent";
import { isHexColor, parseHex, relativeLuminance } from "@/design/color";
import { DEFAULT_LOOK, type IslandLook, type IslandMotion, type IslandMotionStyle, type IslandPrefs, LIMITS } from "./types";

export interface MotionTiming {
  /** How long the pill takes to grow or shrink (ms). */
  morph: number;
  /** How long new content takes to appear (ms). */
  enter: number;
  /** How long replaced content takes to fade (ms); the page keeps it mounted that long. */
  leave: number;
  /** Easing of the pill's size. */
  spring: string;
  /** Easing of everything else. */
  ease: string;
}

const STYLES: Record<IslandMotionStyle, MotionTiming> = {
  // Overshoots a little, like a drop of liquid.
  springy: { morph: 520, enter: 340, leave: 260, spring: "cubic-bezier(0.32, 1.18, 0.4, 1)", ease: "cubic-bezier(0.32, 0.72, 0, 1)" },
  // The same path without the overshoot.
  soft: { morph: 480, enter: 320, leave: 260, spring: "cubic-bezier(0.32, 0.72, 0, 1)", ease: "cubic-bezier(0.32, 0.72, 0, 1)" },
  // Quick and plain: sizes snap into place, content just fades.
  minimal: { morph: 200, enter: 140, leave: 120, spring: "cubic-bezier(0.2, 0, 0, 1)", ease: "cubic-bezier(0.2, 0, 0, 1)" },
};

function clamp(value: number, { min, max }: { min: number; max: number }): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

/** The durations and curves of a motion setting; a higher tempo shortens every duration. */
export function motionTiming(motion: IslandMotion): MotionTiming {
  const base = STYLES[motion.style] ?? STYLES.springy;
  const tempo = clamp(motion.speed, LIMITS.speed) / 100;
  const ms = (value: number) => Math.round(value / tempo);
  return { ...base, morph: ms(base.morph), enter: ms(base.enter), leave: ms(base.leave) };
}

/** The curve one axis of the pill's size takes: the style's spring, or the plain ease. */
export type MorphCurve = "spring" | "settle";

/**
 * Which curve each axis takes for a change of the pill's size from `from` to `to`.
 * Growing keeps the style's spring (the little overshoot of opening). Shrinking never
 * overshoots: on a closing pill it would sink below its closed size and swing back
 * just before it comes to rest, which reads as a wobble at the very end.
 */
export function morphCurves(from: { width: number; height: number }, to: { width: number; height: number }): { width: MorphCurve; height: MorphCurve } {
  return { width: to.width < from.width ? "settle" : "spring", height: to.height < from.height ? "settle" : "spring" };
}

/** Whether text on this background must be dark ("light" pane) or light ("dark" pane). */
export function paneTone(background: string): "dark" | "light" {
  return isHexColor(background) && relativeLuminance(parseHex(background)) > 0.42 ? "light" : "dark";
}

/** The pane's tone for a set of preferences: only a custom background can change it. */
export function islandTone(prefs: Pick<IslandPrefs, "theme" | "look">): "dark" | "light" {
  if (prefs.theme === "white") return "light";
  return prefs.theme === "custom" ? paneTone(prefs.look.background) : "dark";
}

function rgba(hex: string, alpha: number): string {
  const { r, g, b } = parseHex(isHexColor(hex) ? hex : DEFAULT_LOOK.background);
  return `rgb(${r} ${g} ${b} / ${alpha.toFixed(3)})`;
}

/** The material of the theme "custom": background, veil, rim and shadow. */
function materialVariables(look: IslandLook): Record<string, string> {
  const light = paneTone(look.background) === "light";
  const ink = light ? "0 0 0" : "255 255 255";
  const shadow = clamp(look.shadow, LIMITS.shadow) / 100;
  const frost = clamp(look.frost, LIMITS.frost) / 100;
  const rim = look.border === "off" ? "transparent" : look.border === "glow" ? "color-mix(in srgb, var(--nova-accent) 70%, transparent)" : `rgb(${ink} / ${light ? 0.1 : 0.12})`;
  const glow = look.border === "glow" ? ", 0 0 22px -4px color-mix(in srgb, var(--nova-accent) 75%, transparent)" : "";
  return {
    "--island-bg": rgba(look.background, clamp(look.opacity, LIMITS.opacity) / 100),
    "--island-rim": rim,
    "--island-shadow": `0 10px 28px -6px rgb(0 0 0 / ${(0.9 * shadow).toFixed(3)}), 0 2px 6px rgb(0 0 0 / ${(0.55 * shadow).toFixed(3)})${glow}`,
    // A veil of the ink's opposite: it lifts a dark pane and calms a see-through one.
    "--island-veil": `linear-gradient(180deg, rgb(255 255 255 / ${(frost * 0.16).toFixed(3)}), rgb(255 255 255 / ${(frost * 0.05).toFixed(3)}))`,
    "--island-grain": (frost * 0.5).toFixed(3),
  };
}

/** Everything `.island-stage` needs to draw the island the way the preferences say. */
export function islandVariables(prefs: Pick<IslandPrefs, "theme" | "look" | "motion">): CSSProperties {
  const { look } = prefs;
  const timing = motionTiming(prefs.motion);
  const radius = clamp(look.radius, LIMITS.radius);
  const variables: Record<string, string> = {
    "--island-scale": String(clamp(look.scale, LIMITS.scale) / 100),
    "--island-radius": `${radius}px`,
    "--island-radius-open": `${radius + 8}px`,
    "--island-morph": `${timing.morph}ms`,
    "--island-enter": `${timing.enter}ms`,
    "--island-leave": `${timing.leave}ms`,
    "--island-spring": timing.spring,
    "--island-ease": timing.ease,
  };
  if (look.accent && isHexColor(look.accent)) {
    const tokens = deriveAccentTokens(look.accent);
    variables["--nova-accent"] = tokens.accent;
    variables["--nova-accent-text"] = tokens.accentText;
  }
  if (prefs.theme === "custom") Object.assign(variables, materialVariables(look));
  return variables as CSSProperties;
}
