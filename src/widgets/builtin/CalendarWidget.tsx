import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { Button, IconButton } from "@/components/ui/Button";
import { buildMonthGrid, firstDayOfWeek, weekdayLabels } from "@/lib/calendar";
import { cn } from "@/lib/cn";
import { dayOfYear, isoWeek, uiLocale, useNow } from "@/lib/time";
import { useWidgetConfig } from "../config";
import { WidgetFrame } from "../WidgetFrame";

export function CalendarWidget() {
  const { weekStart: weekStartPreference, showWeekInfo } = useWidgetConfig<{ weekStart: string; showWeekInfo: boolean }>();
  // Minute resolution is enough for "today" to roll over at midnight.
  const today = useNow(60_000);
  // null: follows today, also across a month's end.
  const [chosen, setChosen] = useState<{ year: number; month: number } | null>(null);
  const cursor = chosen ?? { year: today.getFullYear(), month: today.getMonth() };
  const [direction, setDirection] = useState(0);
  const locale = uiLocale();
  const weekStart = weekStartPreference === "monday" ? 1 : weekStartPreference === "sunday" ? 0 : firstDayOfWeek(locale);

  const days = useMemo(() => buildMonthGrid(cursor.year, cursor.month, weekStart, today), [cursor.year, cursor.month, weekStart, today]);
  const labels = useMemo(() => weekdayLabels(locale, weekStart), [locale, weekStart]);
  const monthLabel = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(new Date(cursor.year, cursor.month, 1));
  const isCurrentMonth = cursor.year === today.getFullYear() && cursor.month === today.getMonth();
  const daysInYear = new Date(today.getFullYear(), 1, 29).getMonth() === 1 ? 366 : 365;

  const shift = (delta: number) => {
    setDirection(delta);
    const d = new Date(cursor.year, cursor.month + delta, 1);
    setChosen({ year: d.getFullYear(), month: d.getMonth() });
  };

  const goToToday = () => {
    setDirection(0);
    setChosen(null);
  };

  return (
    <WidgetFrame
      title="Calendar"
      icon={CalendarDays}
      actions={
        <>
          {!isCurrentMonth && (
            <Button size="sm" variant="ghost" onClick={goToToday} className="h-7 px-2">
              Today
            </Button>
          )}
          <IconButton size="sm" label="Previous month" onClick={() => shift(-1)}>
            <ChevronLeft size={16} />
          </IconButton>
          <IconButton size="sm" label="Next month" onClick={() => shift(1)}>
            <ChevronRight size={16} />
          </IconButton>
        </>
      }
    >
      <div className="flex h-full flex-col">
        <p className="mb-3 text-lg font-semibold tracking-tight text-fg" aria-live="polite">
          {monthLabel}
        </p>
        <div className="grid grid-cols-7 text-center text-[11px] font-medium text-fg-subtle">
          {labels.map((label, i) => (
            <span key={i} className="pb-2">
              {label}
            </span>
          ))}
        </div>
        <div className="relative flex-1 overflow-hidden">
          <AnimatePresence mode="popLayout" initial={false} custom={direction}>
            <motion.div
              key={`${cursor.year}-${cursor.month}`}
              custom={direction}
              initial={{ opacity: 0, x: direction * 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: direction * -24 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="grid h-full grid-cols-7 grid-rows-6 gap-0.5"
            >
              {days.map((day) => (
                <div
                  key={day.date.toISOString()}
                  aria-current={day.isToday ? "date" : undefined}
                  className={cn(
                    "flex items-center justify-center rounded-[9px] text-[13px] tabular-nums",
                    day.isToday
                      ? "bg-accent font-semibold text-on-accent shadow-[0_6px_18px_-6px_var(--nova-accent-glow)]"
                      : day.inMonth
                        ? day.isWeekend
                          ? "text-fg-muted"
                          : "text-fg"
                        : "text-fg-subtle/50",
                  )}
                >
                  {day.date.getDate()}
                </div>
              ))}
            </motion.div>
          </AnimatePresence>
        </div>
        {showWeekInfo && (
          <p className="mt-3 text-[12px] text-fg-subtle tabular-nums">
            Week {isoWeek(today)} · Day {dayOfYear(today)} of {daysInYear}
          </p>
        )}
      </div>
    </WidgetFrame>
  );
}
