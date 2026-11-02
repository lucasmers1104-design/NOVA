import { useEffect, useState } from "react";

/**
 * Locale used for dates in NOVA's English UI: the system locale when it is an
 * English variant, otherwise British English (day-month order, Monday weeks).
 */
export function uiLocale(): string {
  const system = typeof navigator === "undefined" ? "en-GB" : navigator.language;
  return system.toLowerCase().startsWith("en") ? system : "en-GB";
}

/** Whether the OS locale prefers a 24-hour clock. */
export function systemPrefers24Hour(): boolean {
  const locale = typeof navigator === "undefined" ? undefined : navigator.language;
  const cycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
  return cycle === "h23" || cycle === "h24";
}

export function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** ISO-8601 week number (weeks start Monday; week 1 contains Jan 4th). */
export function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

export function dayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date.getTime() - start.getTime() + (start.getTimezoneOffset() - date.getTimezoneOffset()) * 60_000;
  return Math.floor(diff / 86_400_000);
}

/**
 * Current time, re-rendering on whole-unit boundaries (seconds by default)
 * so clocks tick in sync with the system clock instead of drifting.
 */
export function useNow(unitMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: number;
    const schedule = () => {
      timer = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, unitMs - (Date.now() % unitMs) + 5);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [unitMs]);
  return now;
}
