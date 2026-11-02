import { CloudSun, Hourglass, Newspaper } from "lucide-react";
import { MeterBar } from "@/components/ui/Meter";
import { NewsList, WeatherCard } from "@/features/live/LiveWidgets";
import { useNow } from "@/lib/time";
import { WidgetFrame } from "../WidgetFrame";

export function WeatherWidget() {
  return (
    <WidgetFrame title="Weather" icon={CloudSun}>
      <WeatherCard compact />
    </WidgetFrame>
  );
}

export function NewsWidget() {
  return (
    <WidgetFrame title="Headlines" icon={Newspaper}>
      <NewsList limit={12} compact />
    </WidgetFrame>
  );
}

/** Share of the current day, week (Monday start), month and year that has passed. */
export function progressOf(now: Date) {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = (now.getTime() - startOfDay.getTime()) / 86_400_000;
  const weekday = (now.getDay() + 6) % 7;
  const week = (weekday + day) / 7;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const month = (now.getDate() - 1 + day) / daysInMonth;
  const startOfYear = new Date(now.getFullYear(), 0, 1).getTime();
  const year = (now.getTime() - startOfYear) / (new Date(now.getFullYear() + 1, 0, 1).getTime() - startOfYear);
  return { day: day * 100, week: week * 100, month: month * 100, year: year * 100 };
}

export function ProgressWidget() {
  const now = useNow(60_000);
  const progress = progressOf(now);
  const rows = [
    ["Today", progress.day],
    ["This week", progress.week],
    ["This month", progress.month],
    [String(now.getFullYear()), progress.year],
  ] as const;
  return (
    <WidgetFrame title="Progress" icon={Hourglass}>
      <ul className="flex h-full flex-col justify-center gap-3.5">
        {rows.map(([label, value]) => (
          <li key={label}>
            <div className="mb-1.5 flex justify-between text-[12.5px]">
              <span className="text-fg-muted">{label}</span>
              <span className="font-semibold text-fg tabular-nums">{value.toFixed(1)}%</span>
            </div>
            <MeterBar percent={value} label={`${label} progress`} />
          </li>
        ))}
      </ul>
    </WidgetFrame>
  );
}
