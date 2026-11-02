import { Skeleton } from "@/components/ui/Skeleton";
import { useProfile } from "@/features/profile/useProfile";
import { useSystemSnapshot } from "@/features/system/api";
import { formatPercent, formatUptime, ratioPercent } from "@/lib/format";
import { NativeUnavailableError } from "@/lib/native";
import { greetingFor, isoWeek, uiLocale, useNow } from "@/lib/time";
import { useSettings } from "@/stores/settings";
import { useWidgetConfig } from "../config";

export function clockParts(date: Date, use24Hour: boolean, locale: string) {
  const parts = new Intl.DateTimeFormat(locale, {
    hour: use24Hour ? "2-digit" : "numeric",
    minute: "2-digit",
    hourCycle: use24Hour ? "h23" : "h12",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    time: `${get("hour")}:${get("minute")}`,
    seconds: String(date.getSeconds()).padStart(2, "0"),
    period: use24Hour ? null : get("dayPeriod").toUpperCase() || null,
  };
}

export function WelcomeWidget() {
  const { showSeconds, showPulse } = useWidgetConfig<{ showSeconds: boolean; showPulse: boolean }>();
  const now = useNow(showSeconds ? 1000 : 60_000);
  const profile = useProfile();
  const use24Hour = useSettings((s) => s.use24HourClock);
  const locale = uiLocale();
  const clock = clockParts(now, use24Hour, locale);
  const dateLabel = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now);
  const timeZone = new Intl.DateTimeFormat(locale, { timeZoneName: "short" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value;

  return (
    <section aria-label="Welcome" className="glass relative flex h-full gap-6 overflow-hidden rounded-widget p-7">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-28 -right-10 size-80 rounded-full"
        style={{ background: "radial-gradient(closest-side, var(--nova-accent-glow), transparent)" }}
      />

      <div className="relative flex min-w-0 flex-1 flex-col">
        <p className="text-[13px] font-medium text-accent-text">{dateLabel}</p>
        <h1 className="mt-2 truncate text-[30px] leading-tight font-semibold tracking-tight text-fg">
          {greetingFor(now)}
          {profile.firstName ? `, ${profile.firstName}` : ""}
        </h1>
        <p className="mt-1 text-sm text-fg-muted">Everything important, in one place.</p>
        {showPulse && (
          <div className="mt-auto pt-4">
            <SystemPulse />
          </div>
        )}
      </div>

      <div className="relative flex shrink-0 flex-col items-end justify-between text-right">
        <p className="flex items-baseline tabular-nums" aria-label={`Current time ${clock.time}`}>
          <span className="text-[60px] leading-none font-extralight tracking-tight text-fg">{clock.time}</span>
          {showSeconds && <span className="ml-1.5 text-xl font-light text-fg-subtle">{clock.seconds}</span>}
          {clock.period && <span className="ml-1.5 text-sm font-medium text-fg-muted">{clock.period}</span>}
        </p>
        <p className="text-[12px] text-fg-subtle tabular-nums">
          {timeZone ? `${timeZone} · ` : ""}Week {isoWeek(now)}
        </p>
      </div>
    </section>
  );
}

function SystemPulse() {
  const { data, error, isPending } = useSystemSnapshot();

  if (error) {
    return (
      <p className="text-[12px] text-fg-subtle">
        {error instanceof NativeUnavailableError ? "Live system status appears in the desktop app." : "System status is unavailable right now."}
      </p>
    );
  }
  if (isPending) {
    return (
      <div className="flex gap-2">
        <Skeleton className="h-7 w-24 rounded-full" />
        <Skeleton className="h-7 w-28 rounded-full" />
        <Skeleton className="h-7 w-24 rounded-full" />
      </div>
    );
  }

  return (
    <ul className="flex flex-wrap gap-2" aria-label="System status">
      <PulseChip label="CPU" value={formatPercent(data.cpuUsage)} />
      <PulseChip label="Memory" value={formatPercent(ratioPercent(data.memoryUsed, data.memoryTotal))} />
      {data.uptimeSeconds !== null && <PulseChip label="Uptime" value={formatUptime(data.uptimeSeconds)} />}
    </ul>
  );
}

function PulseChip({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex h-7 items-center gap-2 rounded-full border border-line bg-white/[0.04] px-3 text-[12px]">
      <span className="text-fg-subtle">{label}</span>
      <span className="font-semibold text-fg tabular-nums">{value}</span>
    </li>
  );
}
