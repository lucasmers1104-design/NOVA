import { ChevronRight, Search } from "lucide-react";
import { getNavItem } from "@/app/navigation";
import { Kbd } from "@/components/ui/Badge";
import { uiLocale, useNow } from "@/lib/time";
import { type TitleBarClock as TitleBarClockMode, useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { NotificationButton } from "@/features/notifications/NotificationUI";
import { clockParts } from "@/widgets/builtin/clocks/time";
import { WindowControls } from "./WindowControls";

export function TitleBar() {
  const route = useUi((s) => s.route);
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  const titleBarClock = useSettings((s) => s.titleBarClock);
  const current = getNavItem(route);

  return (
    <header data-tauri-drag-region className="relative z-10 grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center">
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-1.5 pl-7 text-[13px]">
        <span data-tauri-drag-region className="text-fg-muted/80">
          NOVA
        </span>
        <ChevronRight size={14} className="text-fg-muted/60" aria-hidden />
        <span data-tauri-drag-region className="truncate font-medium text-fg-muted">
          {current.label}
        </span>
      </div>

      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        className="glass flex h-9 w-[clamp(240px,34vw,460px)] items-center gap-2.5 rounded-full px-4 text-left text-[13px] text-fg-subtle transition-colors duration-200 hover:text-fg-muted"
      >
        <Search size={15} aria-hidden />
        <span className="flex-1 truncate">Search NOVA or run a command…</span>
        <span className="flex items-center gap-1" aria-hidden>
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      <div data-tauri-drag-region className="flex h-full items-center justify-end gap-2">
        {titleBarClock !== "off" && <TitleBarClock mode={titleBarClock} />}
        <NotificationButton />
        <WindowControls />
      </div>
    </header>
  );
}

/** Its own component, so no minute timer runs and the bar stays still while the clock is off. */
function TitleBarClock({ mode }: { mode: Exclude<TitleBarClockMode, "off"> }) {
  const now = useNow(60_000);
  const use24Hour = useSettings((s) => s.use24HourClock);
  const locale = uiLocale();
  const clock = clockParts(now, use24Hour, locale);
  const date = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short" }).format(now);

  return (
    <span data-tauri-drag-region className="mr-1 text-[12px] whitespace-nowrap text-fg-muted tabular-nums">
      {mode === "time-date" ? `${date} · ` : ""}
      {clock.time}
      {clock.period ? ` ${clock.period}` : ""}
    </span>
  );
}
