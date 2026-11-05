import { uiLocale, useNow } from "@/lib/time";
import { useSettings } from "@/stores/settings";
import { useWidgetConfig } from "../config";
import { CLOCK_TIME_ZONES, LOCAL_TIME_ZONE } from "./ClockWidget";
import { AnalogFace } from "./clocks/faces";
import { clockParts, wallClock } from "./clocks/time";

export function AnalogClockWidget() {
  const { showSeconds, timeZone, showNumbers } = useWidgetConfig<{ showSeconds: boolean; timeZone: string; showNumbers: boolean }>();
  const use24Hour = useSettings((s) => s.use24HourClock);
  const now = useNow(showSeconds ? 1000 : 60_000);
  const zone = timeZone === LOCAL_TIME_ZONE ? undefined : timeZone;
  const label = CLOCK_TIME_ZONES.find((z) => z.value === timeZone)?.label ?? "Local time";

  return (
    <section aria-label={label} className="glass flex h-full flex-col items-center justify-center gap-2 overflow-hidden rounded-widget p-4">
      <div className="flex min-h-0 w-full flex-1 justify-center">
        <AnalogFace
          wall={wallClock(now, zone)}
          label={clockParts(now, use24Hour, uiLocale(), zone).time}
          showSeconds={showSeconds}
          showNumbers={showNumbers}
          className="h-full max-w-full"
        />
      </div>
      {zone && <p className="shrink-0 text-[12px] font-medium text-fg-muted">{label}</p>}
    </section>
  );
}
