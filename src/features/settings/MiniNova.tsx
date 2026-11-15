import { ChevronRight, Search } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useMemo } from "react";
import { type NavItem, resolveSidebar, type RouteId } from "@/app/navigation";
import { NovaMark } from "@/components/brand/NovaMark";
import { Backdrop } from "@/components/layout/Backdrop";
import { cn } from "@/lib/cn";
import { greetingFor } from "@/lib/time";
import { useSettings } from "@/stores/settings";

/** As many sidebar entries as fit the small window. */
const SHOWN = 5;

/** A widget's corners follow the "Ecken" setting, at the window's scale. */
const WIDGET = "glass min-w-0 rounded-[calc(var(--radius-widget)*0.5)] p-2";

/** The same page change as in the real window (see AppShell). */
const PAGE_MOTION = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.26, ease: [0.22, 1, 0.36, 1] as const } },
  exit: { opacity: 0, y: -4, transition: { duration: 0.12 } },
};

function ChartWidget({ label, value }: { label: string; value: string }) {
  const fill = useId();
  return (
    <div className={cn(WIDGET, "flex flex-col")}>
      <p className="text-[8px] font-medium text-fg-muted">{label}</p>
      <p className="text-[13px] leading-tight font-semibold text-fg tabular-nums">{value}</p>
      <svg viewBox="0 0 120 34" preserveAspectRatio="none" className="mt-1 min-h-0 w-full flex-1">
        <defs>
          <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
            {/* CSS variables only resolve via style, not SVG presentation attributes. */}
            <stop offset="0" style={{ stopColor: "var(--nova-accent)", stopOpacity: 0.35 }} />
            <stop offset="1" style={{ stopColor: "var(--nova-accent)", stopOpacity: 0 }} />
          </linearGradient>
        </defs>
        <path d="M0 26 C14 24 20 10 34 13 S56 28 72 18 S100 4 120 9 V34 H0 Z" fill={`url(#${fill})`} />
        <path d="M0 26 C14 24 20 10 34 13 S56 28 72 18 S100 4 120 9" fill="none" strokeWidth="1.5" strokeLinecap="round" style={{ stroke: "var(--nova-accent)" }} />
      </svg>
    </div>
  );
}

function ControlsWidget() {
  return (
    <div className={cn(WIDGET, "flex flex-col justify-between gap-1.5")}>
      <span className="inline-flex h-5 items-center justify-center rounded-full bg-accent bg-[linear-gradient(180deg,rgb(255_255_255/0.2),rgb(255_255_255/0))] px-2 text-[8px] font-medium text-on-accent shadow-[0_6px_14px_-8px_var(--nova-accent-glow)]">Los geht's</span>
      <span className="flex items-center justify-between gap-2">
        <span className="text-[8px] font-medium text-accent-text">Mehr erfahren</span>
        <span className="inline-flex h-3.5 w-6 items-center rounded-full bg-accent">
          <span className="ml-[11px] size-2.5 rounded-full bg-on-accent" />
        </span>
      </span>
      <span className="flex h-4 items-center rounded-[calc(var(--radius-control)*0.5)] border border-line bg-black/25 px-1.5 text-[7.5px] text-fg-subtle">Notiz …</span>
    </div>
  );
}

function ProgressWidget({ label }: { label: string }) {
  return (
    <div className={cn(WIDGET, "flex flex-col gap-1.5")}>
      <p className="text-[8px] font-medium text-fg-muted">{label}</p>
      <span className="h-1 w-full overflow-hidden rounded-full bg-white/[0.08]">
        <span className="block h-full w-[64%] rounded-full bg-accent" />
      </span>
      <span className="h-1 w-full overflow-hidden rounded-full bg-white/[0.08]">
        <span className="block h-full w-[38%] rounded-full bg-accent-secondary" />
      </span>
      <span className="accent-soft mt-auto inline-flex h-4 w-fit items-center rounded-full border border-accent/25 px-1.5 text-[7.5px] font-medium text-accent-text">3 offen</span>
    </div>
  );
}

function PageBody({ item, name }: { item: NavItem; name: string }) {
  const home = item.id === "home";
  return (
    <div className="flex h-full flex-col gap-2 px-2.5 pb-2.5">
      <div className="min-w-0">
        <p className="truncate text-[12px] leading-tight font-semibold tracking-[-0.01em] text-fg">{home ? `${greetingFor(new Date())}${name ? `, ${name}` : ""}` : item.label}</p>
        <p className="truncate text-[8px] text-fg-muted">{item.description}</p>
      </div>
      {/* Illustrative only: these mimic NOVA's widgets and controls but are not interactive. */}
      <div aria-hidden className={cn("pointer-events-none grid min-h-0 flex-1 gap-1.5", home ? "grid-cols-[1.25fr_1fr_1fr]" : "grid-cols-[1fr_1.5fr]")}>
        {home ? (
          <>
            <ChartWidget label="CPU" value="23 %" />
            <ControlsWidget />
            <ProgressWidget label="Heute" />
          </>
        ) : (
          <>
            <ProgressWidget label={item.label} />
            <ChartWidget label="Verlauf" value="7 Tage" />
          </>
        )}
      </div>
    </div>
  );
}

interface MiniNovaProps {
  /** The page the small window shows. */
  page: RouteId;
  onPage: (page: RouteId) => void;
}

/**
 * NOVA's window at a small scale, made of the real tokens and the real backdrop:
 * glass, corners, font and motion come from the settings as they are, the accent
 * from whatever surrounds it (the stage scopes a draft accent to it).
 */
export function MiniNova({ page, onPage }: MiniNovaProps) {
  const pill = useId();
  const navOrder = useSettings((s) => s.navOrder);
  const navHidden = useSettings((s) => s.navHidden);
  const name = useSettings((s) => s.displayName.trim());
  const items = useMemo(() => resolveSidebar(navOrder, navHidden).workspace.slice(0, SHOWN), [navOrder, navHidden]);
  const current = items.find((item) => item.id === page) ?? items[0];
  if (!current) return null;

  return (
    <div className="relative flex h-[208px] w-[500px] max-w-full overflow-hidden rounded-[14px] border border-white/15 bg-canvas shadow-[0_30px_70px_-25px_rgb(0_0_0/0.9)]">
      <Backdrop />
      <nav aria-label="Seiten der Vorschau" className="glass relative z-10 my-1.5 ml-1.5 flex w-10 shrink-0 flex-col items-center gap-0.5 rounded-[calc(var(--radius-widget)*0.5)] py-2">
        <NovaMark size={18} className="mb-1.5" />
        {items.map((item) => {
          const Icon = item.icon;
          const active = item.id === current.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-label={`${item.label} in der Vorschau zeigen`}
              aria-current={active ? "page" : undefined}
              title={item.label}
              onClick={() => onPage(item.id)}
              className={cn("relative flex size-6 items-center justify-center rounded-[calc(var(--radius-control)*0.6)] transition-colors", active ? "text-fg" : "text-fg-muted hover:text-fg")}
            >
              {active && <motion.span layoutId={pill} className="glass-pill absolute inset-0 rounded-[calc(var(--radius-control)*0.6)]" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
              <Icon size={12} className={cn("relative", active && "text-accent-text")} aria-hidden />
            </button>
          );
        })}
      </nav>
      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <div aria-hidden className="grid h-8 shrink-0 grid-cols-[1fr_auto_1fr] items-center px-2.5">
          <span className="flex min-w-0 items-center gap-0.5 text-[8px] text-fg-muted">
            NOVA <ChevronRight size={8} /> <span className="truncate font-medium">{current.label}</span>
          </span>
          <span className="glass flex h-[18px] w-36 items-center gap-1 rounded-full px-2 text-[7.5px] text-fg-subtle">
            <Search size={8} /> Search NOVA …
          </span>
          <span className="flex items-center justify-end gap-2.5 text-fg-muted">
            {["M0 3h6", "M0.5 0.5h5v5h-5z", "M0.5 0.5l5 5M5.5 0.5l-5 5"].map((path) => (
              <svg key={path} width="6" height="6" viewBox="0 0 6 6" fill="none" stroke="currentColor" strokeWidth="0.8">
                <path d={path} />
              </svg>
            ))}
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={current.id} className="h-full" {...PAGE_MOTION}>
              <PageBody item={current} name={name} />
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
