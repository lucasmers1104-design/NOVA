export interface CalendarDay {
  date: Date;
  inMonth: boolean;
  isToday: boolean;
  isWeekend: boolean;
}

/** 0 = Sunday, 1 = Monday. Uses Intl week info where the runtime provides it. */
export function firstDayOfWeek(locale: string): 0 | 1 {
  try {
    const loc = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info) return info.firstDay === 7 ? 0 : 1;
  } catch {
    // Fall through to the default below.
  }
  return locale.toLowerCase() === "en-us" ? 0 : 1;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** A fixed 6×7 grid covering the given month, padded with adjacent days. */
export function buildMonthGrid(year: number, month: number, weekStartsOn: 0 | 1, today: Date): CalendarDay[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() - weekStartsOn + 7) % 7;
  const start = new Date(year, month, 1 - offset);

  return Array.from({ length: 42 }, (_, i) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const weekday = date.getDay();
    return {
      date,
      inMonth: date.getMonth() === month,
      isToday: sameDay(date, today),
      isWeekend: weekday === 0 || weekday === 6,
    };
  });
}

export function weekdayLabels(locale: string, weekStartsOn: 0 | 1): string[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: "narrow" });
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => format.format(new Date(2023, 0, 1 + ((i + weekStartsOn) % 7))));
}
