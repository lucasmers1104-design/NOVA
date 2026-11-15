import type { CSSProperties } from "react";
import type { SelectConfigField } from "../../types";

export type ClockStyle = "digital" | "minimal" | "glass" | "stacked" | "analog" | "flip" | "words";
export type ClockFont = "classic" | "thin" | "bold" | "rounded" | "serif" | "condensed" | "mono";

/** Shared `style` option; "digital" keeps existing layouts unchanged. */
export const CLOCK_STYLE_FIELD: SelectConfigField = {
  type: "select",
  key: "style",
  label: "Style",
  default: "digital",
  options: [
    { value: "digital", label: "Digital" },
    { value: "minimal", label: "Minimal" },
    { value: "glass", label: "Glass" },
    { value: "stacked", label: "Stacked" },
    { value: "analog", label: "Analog" },
    { value: "flip", label: "Flip" },
    { value: "words", label: "Words" },
  ],
};

/** Shared `font` option, like the lock screen's typefaces; only the digital faces use it. */
export const CLOCK_FONT_FIELD: SelectConfigField = {
  type: "select",
  key: "font",
  label: "Typeface",
  default: "classic",
  options: [
    { value: "classic", label: "Classic" },
    { value: "thin", label: "Thin" },
    { value: "bold", label: "Bold" },
    { value: "rounded", label: "Rounded" },
    { value: "serif", label: "Serif" },
    { value: "condensed", label: "Condensed" },
    { value: "mono", label: "Mono" },
  ],
};

/** The typeface for a `font` setting, as inline style so it wins over each face's own weight. */
export function clockFontStyle(font: ClockFont | undefined): CSSProperties | undefined {
  switch (font) {
    case "thin":
      return { fontWeight: 100 };
    case "bold":
      return { fontWeight: 700, letterSpacing: "-0.04em" };
    case "rounded":
      return { fontFamily: '"Arial Rounded MT Bold", "Nunito", ui-rounded, var(--font-sans)', fontWeight: 400 };
    case "serif":
      return { fontFamily: '"New York", Georgia, Cambria, "Times New Roman", serif', fontWeight: 400, letterSpacing: "-0.02em" };
    case "condensed":
      return { fontFamily: 'Bahnschrift, "DIN Alternate", "Roboto Condensed", var(--font-sans)', fontStretch: "condensed", fontWeight: 500 };
    case "mono":
      return { fontFamily: '"Cascadia Mono", Consolas, ui-monospace, monospace', fontWeight: 400, letterSpacing: "-0.03em" };
    default:
      return undefined;
  }
}

export function clockParts(date: Date, use24Hour: boolean, locale: string, timeZone?: string) {
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: use24Hour ? "2-digit" : "numeric",
    minute: "2-digit",
    hourCycle: use24Hour ? "h23" : "h12",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    time: `${get("hour")}:${get("minute")}`,
    hour: get("hour"),
    minute: get("minute"),
    seconds: String(date.getSeconds()).padStart(2, "0"),
    period: use24Hour ? null : get("dayPeriod").toUpperCase() || null,
  };
}

export type ClockParts = ReturnType<typeof clockParts>;

export interface WallClock {
  hours: number;
  minutes: number;
  seconds: number;
}

// Clocks re-render every second; building a formatter per tick is needlessly costly.
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "numeric", minute: "numeric", second: "numeric" });
    zoneFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The hour, minute and second shown on a wall clock in `timeZone` (local time when omitted). */
export function wallClock(date: Date, timeZone?: string): WallClock {
  if (!timeZone) return { hours: date.getHours(), minutes: date.getMinutes(), seconds: date.getSeconds() };
  const parts = zoneFormatter(timeZone).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { hours: get("hour"), minutes: get("minute"), seconds: get("second") };
}

/** Clockwise hand angles in degrees from 12 o'clock; hour and minute hands sweep between marks. */
export function handAngles({ hours, minutes, seconds }: WallClock) {
  return {
    hour: (hours % 12) * 30 + minutes * 0.5 + seconds / 120,
    minute: minutes * 6 + seconds * 0.1,
    second: seconds * 6,
  };
}
