import { Skeleton } from "@/components/ui/Skeleton";
import { useProfile } from "@/features/profile/useProfile";
import { useSystemSnapshot } from "@/features/system/api";
import { cn } from "@/lib/cn";
import { formatPercent, formatUptime, ratioPercent } from "@/lib/format";
import { NativeUnavailableError } from "@/lib/native";
import { greetingFor, isoWeek, uiLocale, useNow } from "@/lib/time";
import { useSettings } from "@/stores/settings";
import { useWidgetConfig } from "../config";
import { AnalogFace, FlipFace, MinimalFace, WordsFace } from "./clocks/faces";
import { type ClockParts, type ClockStyle, clockParts, wallClock } from "./clocks/time";

export function WelcomeWidget() {
  const { style, showSeconds, showPulse } = useWidgetConfig<{ style: ClockStyle; showSeconds: boolean; showPulse: boolean }>();
  // The word clock only changes per minute, so it never needs second ticks.
  const now = useNow(showSeconds && style !== "words" ? 1000 : 60_000);
  const profile = useProfile();
  const use24Hour = useSettings((s) => s.use24HourClock);
  const locale = uiLocale();
  const clock = clockParts(now, use24Hour, locale);
  const dateLabel = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now);
  const timeZone = new Intl.DateTimeFormat(locale, { timeZoneName: "short" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value;

  return (
    <section aria-label="Welcome" className="@container glass relative flex h-full gap-6 overflow-hidden rounded-widget p-7">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-28 -right-10 size-80 rounded-full"
        style={{ background: "radial-gradient(closest-side, var(--nova-accent-glow), transparent)" }}
      />

      <div className="relative flex min-w-0 flex-1 flex-col">
        <p className="text-[13px] font-medium text-accent-text">{dateLabel}</p>
        <h1 className="mt-2 shrink-0 truncate text-[30px] leading-tight font-semibold tracking-tight text-fg">
          {greetingFor(now)}
          {profile.firstName ? `, ${profile.firstName}` : ""}
        </h1>
        {/* On the narrowest cards the clock comes first: what doesn't fit steps aside instead of being cut off. */}
        <p className="mt-1 text-sm text-fg-muted @max-[620px]:hidden">Everything important, in one place.</p>
        {showPulse && (
          <div className={cn("mt-auto pt-4", style === "flip" && "@max-[620px]:hidden")}>
            <SystemPulse />
          </div>
        )}
      </div>

      <div className={cn("relative flex shrink-0 flex-col items-end text-right", style === "minimal" ? "justify-center" : "justify-between")}>
        <WelcomeClock style={style} now={now} clock={clock} showSeconds={showSeconds} />
        {style !== "minimal" && (
          <p className="text-[12px] text-fg-subtle tabular-nums">
            {/* Words round to five minutes, so the exact time stays readable beside them. */}
            {style === "words" ? `${clock.time}${clock.period ? ` ${clock.period}` : ""} · ` : ""}
            {timeZone ? `${timeZone} · ` : ""}Week {isoWeek(now)}
          </p>
        )}
      </div>
    </section>
  );
}

function WelcomeClock({ style, now, clock, showSeconds }: { style: ClockStyle; now: Date; clock: ClockParts; showSeconds: boolean }) {
  switch (style) {
    case "minimal":
      return <MinimalFace clock={clock} showSeconds={showSeconds} className="text-[76px]" />;
    case "analog":
      return <AnalogFace wall={wallClock(now)} label={clock.time} showSeconds={showSeconds} className="size-[124px]" />;
    case "flip":
      return <FlipFace clock={clock} showSeconds={showSeconds} size="lg" />;
    case "words":
      return <WordsFace wall={wallClock(now)} className="max-w-[260px] text-[28px] @max-[620px]:max-w-[170px] @max-[620px]:text-[22px]" />;
    default:
      return (
        <p className="flex items-baseline tabular-nums" aria-label={`Current time ${clock.time}`}>
          <span className="text-[60px] leading-none font-extralight tracking-tight text-fg">{clock.time}</span>
          {showSeconds && <span className="ml-1.5 text-xl font-light text-fg-subtle">{clock.seconds}</span>}
          {clock.period && <span className="ml-1.5 text-sm font-medium text-fg-muted">{clock.period}</span>}
        </p>
      );
  }
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
      {data.uptimeSeconds !== null && <PulseChip label="Uptime" value={formatUptime(data.uptimeSeconds)} className="@max-[620px]:hidden" />}
    </ul>
  );
}

function PulseChip({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <li className={cn("flex h-7 items-center gap-2 rounded-full border border-line bg-white/[0.04] px-3 text-[12px]", className)}>
      <span className="text-fg-subtle">{label}</span>
      <span className="font-semibold text-fg tabular-nums">{value}</span>
    </li>
  );
}
