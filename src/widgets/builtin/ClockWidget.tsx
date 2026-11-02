import { Clock } from "lucide-react";
import { uiLocale, useNow } from "@/lib/time";
import { useSettings } from "@/stores/settings";
import { useWidgetConfig } from "../config";
import { WidgetFrame } from "../WidgetFrame";

export const LOCAL_TIME_ZONE = "local";

/** Curated IANA zones offered in the clock's settings. */
export const CLOCK_TIME_ZONES = [
  { value: LOCAL_TIME_ZONE, label: "Local time" },
  { value: "Pacific/Honolulu", label: "Honolulu" },
  { value: "America/Los_Angeles", label: "Los Angeles" },
  { value: "America/Denver", label: "Denver" },
  { value: "America/Chicago", label: "Chicago" },
  { value: "America/New_York", label: "New York" },
  { value: "America/Sao_Paulo", label: "São Paulo" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Berlin", label: "Berlin" },
  { value: "Europe/Helsinki", label: "Helsinki" },
  { value: "Europe/Moscow", label: "Moscow" },
  { value: "Asia/Dubai", label: "Dubai" },
  { value: "Asia/Kolkata", label: "Mumbai" },
  { value: "Asia/Singapore", label: "Singapore" },
  { value: "Asia/Shanghai", label: "Shanghai" },
  { value: "Asia/Tokyo", label: "Tokyo" },
  { value: "Australia/Sydney", label: "Sydney" },
  { value: "Pacific/Auckland", label: "Auckland" },
] as const;

/** Minutes between a zone's wall clock and local time at `date`. */
export function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const zoneAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  const localAsUtc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes());
  return Math.round((zoneAsUtc - localAsUtc) / 60_000);
}

export function formatOffset(minutes: number): string {
  if (minutes === 0) return "Same as local time";
  const sign = minutes > 0 ? "+" : "−";
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  return `${sign}${hours}${rest ? `:${String(rest).padStart(2, "0")}` : ""} h from local`;
}

export function ClockWidget() {
  const { timeZone, showSeconds } = useWidgetConfig<{ timeZone: string; showSeconds: boolean }>();
  const use24Hour = useSettings((s) => s.use24HourClock);
  const now = useNow(showSeconds ? 1000 : 60_000);
  const locale = uiLocale();
  const zone = timeZone === LOCAL_TIME_ZONE ? undefined : timeZone;
  const label = CLOCK_TIME_ZONES.find((z) => z.value === timeZone)?.label ?? "Local time";

  const time = new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    hour: use24Hour ? "2-digit" : "numeric",
    minute: "2-digit",
    second: showSeconds ? "2-digit" : undefined,
    hourCycle: use24Hour ? "h23" : "h12",
  }).format(now);
  const date = new Intl.DateTimeFormat(locale, { timeZone: zone, weekday: "short", day: "numeric", month: "short" }).format(now);

  return (
    <WidgetFrame title={label} icon={Clock}>
      <div className="flex h-full flex-col justify-end">
        <p className="text-[38px] leading-none font-light tracking-tight text-fg tabular-nums">{time}</p>
        <p className="mt-2 flex justify-between gap-3 text-[12px] text-fg-subtle tabular-nums">
          <span>{date}</span>
          {zone && <span className="truncate">{formatOffset(zoneOffsetMinutes(now, zone))}</span>}
        </p>
      </div>
    </WidgetFrame>
  );
}
