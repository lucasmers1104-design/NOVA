import type { SelectConfigField } from "../../types";

export type ClockStyle = "digital" | "minimal" | "analog" | "flip" | "words";

/** Shared `style` option; "digital" keeps existing layouts unchanged. */
export const CLOCK_STYLE_FIELD: SelectConfigField = {
  type: "select",
  key: "style",
  label: "Style",
  default: "digital",
  options: [
    { value: "digital", label: "Digital" },
    { value: "minimal", label: "Minimal" },
    { value: "analog", label: "Analog" },
    { value: "flip", label: "Flip" },
    { value: "words", label: "Words" },
  ],
};

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
