import { Check, FolderPlus, Gamepad2, HardDrive, Music2, Power, Timer, X } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { describeWeather } from "@/features/live/api";
import { cn } from "@/lib/cn";
import { cancelPower, cancelTimer, finderAddAllDrives, finderPickFolder } from "../api";
import { elapsedLabel } from "../scan";
import type { ToolCard } from "../types";
import { formatSize } from "./NovaToolCard";

type CardOf<K extends ToolCard["kind"]> = Extract<ToolCard, { kind: K }>;

/** Re-renders once a second while `active`; returns the time now. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function reducedMotion(): boolean {
  return document.documentElement.dataset.motion === "reduced" || (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

/** Counts from 0 to `target` when it appears. */
function useCountTo(target: number, durationMs = 900): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (reducedMotion()) {
      setValue(target);
      return;
    }
    const started = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const progress = Math.min(1, (now - started) / durationMs);
      setValue(target * (1 - (1 - progress) ** 3));
      if (progress < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);
  return value;
}

const CARD = "mt-2 ml-9 rounded-[14px] border border-line bg-white/[0.035] p-3";

/** What Spotify plays now, with bars that move while the card is fresh. */
export function MusicCard({ card }: { card: CardOf<"music"> }) {
  return (
    <div className={cn(CARD, "flex items-center gap-3 border-success/25 bg-success/[0.06]")}>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-[11px] bg-success/15 text-success">
        <Music2 size={18} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-fg">{card.title}</span>
        <span className="block text-[11px] text-fg-muted">Spotify</span>
      </span>
      <span className="flex h-5 shrink-0 items-end gap-[3px]" aria-hidden>
        {[0, 1, 2, 3].map((bar) => (
          <span key={bar} className="w-[3px] origin-bottom animate-[nova-eq_1s_ease-in-out_infinite] rounded-full bg-success" style={{ height: "100%", animationDelay: `${bar * 0.17}s` }} />
        ))}
      </span>
    </div>
  );
}

/** A game on its way through its launcher. */
export function GameCard({ card }: { card: CardOf<"game"> }) {
  return (
    <div className={cn(CARD, "relative flex items-center gap-3 overflow-hidden border-accent/30 bg-accent/[0.07]")}>
      <motion.span className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-accent/20 to-transparent" initial={{ x: "-100%" }} animate={{ x: "400%" }} transition={{ duration: 1.8, repeat: 2, ease: "easeInOut" }} aria-hidden />
      <span className="relative flex size-10 shrink-0 items-center justify-center rounded-[11px] accent-soft text-accent-text">
        <Gamepad2 size={19} aria-hidden />
      </span>
      <span className="relative min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-semibold text-fg">{card.name}</span>
        <span className="block text-[11px] text-fg-muted">{card.ready ? `${card.launcher} starts it, one moment` : `${card.launcher} still has to download or update it`}</span>
      </span>
    </div>
  );
}

/** A running timer: a ring that empties, and it can be cancelled right here. */
export function TimerCard({ card }: { card: CardOf<"timer"> }) {
  const [cancelled, setCancelled] = useState(false);
  const now = useNow(!cancelled);
  const left = Math.max(0, card.endsAt - now);
  const over = left === 0;
  const share = card.seconds > 0 ? left / (card.seconds * 1000) : 0;
  const radius = 17;
  const round = 2 * Math.PI * radius;
  return (
    <div className={cn(CARD, "flex items-center gap-3")}>
      <span className="relative flex size-11 shrink-0 items-center justify-center text-accent-text">
        <svg viewBox="0 0 44 44" className="absolute inset-0 -rotate-90" aria-hidden>
          <circle cx="22" cy="22" r={radius} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth="3" />
          <circle cx="22" cy="22" r={radius} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray={round} strokeDashoffset={round * (1 - share)} className="transition-[stroke-dashoffset] duration-1000 ease-linear" />
        </svg>
        {over ? <Check size={15} className="text-success" aria-hidden /> : <Timer size={15} aria-hidden />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[20px] leading-tight font-semibold text-fg tabular-nums">{cancelled ? "–" : over ? "Time's up" : elapsedLabel(left + 999)}</span>
        <span className="block truncate text-[11px] text-fg-muted">{cancelled ? "Cancelled" : card.label || "Timer"}</span>
      </span>
      {!over && !cancelled && (
        <button
          type="button"
          aria-label="Cancel the timer"
          title="Cancel the timer"
          onClick={() => void cancelTimer(card.id).then(() => setCancelled(true), () => {})}
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-white/[0.08] hover:text-fg"
        >
          <X size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}

function shortDay(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year!, month! - 1, day!).toLocaleDateString(undefined, { weekday: "short" });
}

/** Now and the next days. */
export function WeatherCard({ card }: { card: CardOf<"weather"> }) {
  const { current, daily, temperatureUnit } = card.forecast;
  const now = describeWeather(current.weatherCode, current.isDay);
  const Icon = now.icon;
  return (
    <div className={CARD}>
      <div className="flex items-center gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-[12px] accent-soft text-accent-text">
          <Icon size={22} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[22px] leading-tight font-semibold text-fg tabular-nums">
            {Math.round(current.temperature)}
            {temperatureUnit}
          </span>
          <span className="block truncate text-[11px] text-fg-muted">
            {card.place} · {now.label}
          </span>
        </span>
      </div>
      <ul className="mt-2.5 grid grid-cols-4 gap-1 border-t border-line pt-2.5">
        {daily.slice(0, 4).map((day) => {
          const DayIcon = describeWeather(day.weatherCode).icon;
          return (
            <li key={day.date} className="flex flex-col items-center gap-1 text-[11px]">
              <span className="text-fg-subtle">{shortDay(day.date)}</span>
              <DayIcon size={15} className="text-fg-muted" aria-hidden />
              <span className="text-fg tabular-nums">
                {Math.round(day.max)}° <span className="text-fg-subtle">{Math.round(day.min)}°</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A gauge up to a gigabit, on a log scale so a normal line still fills it nicely. */
export function SpeedCard({ card }: { card: CardOf<"speed"> }) {
  const shown = useCountTo(card.megabits, 1100);
  const share = Math.min(1, Math.log10(1 + shown) / 3);
  const radius = 38;
  const arc = Math.PI * radius;
  const ping = card.pingMs <= 40 ? "text-success" : card.pingMs <= 100 ? "text-warning" : "text-danger";
  return (
    <div className={cn(CARD, "flex items-center gap-4")}>
      <span className="relative h-[52px] w-[92px] shrink-0 text-accent-text">
        <svg viewBox="0 0 92 52" className="absolute inset-0" aria-hidden>
          <path d="M8 48 A38 38 0 0 1 84 48" fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth="6" strokeLinecap="round" />
          <path d="M8 48 A38 38 0 0 1 84 48" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeDasharray={arc} strokeDashoffset={arc * (1 - share)} />
        </svg>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[22px] leading-tight font-semibold text-fg tabular-nums" aria-label={`${card.megabits} megabits per second`}>
          {shown >= 100 ? Math.round(shown) : shown.toFixed(1)} <span className="text-[12px] font-medium text-fg-muted">Mbit/s</span>
        </span>
        <span className="block text-[11px] text-fg-muted">
          Ping <span className={cn("font-medium tabular-nums", ping)}>{card.pingMs} ms</span>
        </span>
      </span>
    </div>
  );
}

function Load({ label, percent, detail }: { label: string; percent: number; detail?: string }) {
  const tone = percent >= 90 ? "bg-danger" : percent >= 70 ? "bg-warning" : "bg-accent";
  return (
    <li className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-2 text-[11px]">
      <span className="text-fg-muted">{label}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
        <motion.span className={cn("block h-full rounded-full", tone)} initial={{ width: 0 }} animate={{ width: `${Math.min(100, percent)}%` }} transition={{ duration: 0.7, ease: "easeOut" }} />
      </span>
      <span className="text-fg tabular-nums">{detail ?? `${Math.round(percent)} %`}</span>
    </li>
  );
}

/** The PC's load, and the programs behind it. */
export function SystemCard({ card }: { card: CardOf<"system"> }) {
  const memory = card.memoryTotal > 0 ? (card.memoryUsed / card.memoryTotal) * 100 : 0;
  return (
    <div className={CARD}>
      <ul className="space-y-1.5">
        <Load label="CPU" percent={card.cpu ?? 0} />
        <Load label="RAM" percent={memory} detail={`${(card.memoryUsed / 1024 ** 3).toFixed(1)} / ${(card.memoryTotal / 1024 ** 3).toFixed(0)} GB`} />
        {card.gpu != null && <Load label="GPU" percent={card.gpu} />}
      </ul>
      {card.top.length > 0 && (
        <ul className="mt-2.5 space-y-0.5 border-t border-line pt-2">
          {card.top.map((app) => (
            <li key={app.name} className="flex justify-between gap-3 text-[11.5px] text-fg-muted">
              <span className="min-w-0 truncate">{app.name}</span>
              <span className="shrink-0 tabular-nums">
                {app.cpu.toFixed(0)} % · {formatSize(app.memory)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A planned shutdown, counting down, with the way out right there. */
export function PowerCard({ card }: { card: CardOf<"power"> }) {
  const [calledOff, setCalledOff] = useState(false);
  const now = useNow(!calledOff);
  const left = Math.max(0, card.at - now);
  return (
    <div className={cn(CARD, "flex items-center gap-3", !calledOff && "border-warning/35 bg-warning/[0.06]")}>
      <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-[11px]", calledOff ? "bg-white/[0.06] text-fg-muted" : "bg-warning/15 text-warning")}>
        <Power size={18} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[18px] leading-tight font-semibold text-fg tabular-nums">{calledOff ? "Called off" : elapsedLabel(left + 999)}</span>
        <span className="block text-[11px] text-fg-muted">{card.action === "restart" ? "until the PC restarts" : "until the PC shuts down"}</span>
      </span>
      {!calledOff && (
        <Button size="sm" variant="secondary" onClick={() => void cancelPower().then(() => setCalledOff(true), () => {})}>
          Call off
        </Button>
      )}
    </div>
  );
}

/** NOVA found nothing, or isn't allowed there: this is how to change that. */
export function FinderHintCard() {
  const [state, setState] = useState<"ask" | "whole" | "busy" | "added">("ask");
  const [problem, setProblem] = useState<string | null>(null);
  const add = (action: () => Promise<unknown>) => {
    setState("busy");
    setProblem(null);
    void action().then(
      () => setState("added"),
      (error: unknown) => {
        setProblem(error instanceof Error ? error.message : String(error));
        setState("ask");
      },
    );
  };
  if (state === "added") {
    return (
      <p className={cn(CARD, "flex items-center gap-2 text-[12px] text-fg-muted")}>
        <Check size={14} className="shrink-0 text-success" aria-hidden /> Added. NOVA Finder is indexing in the background; just ask again.
      </p>
    );
  }
  return (
    <div className={CARD}>
      <p className="flex items-start gap-2 text-[12px] leading-snug text-fg-muted">
        <HardDrive size={14} className="mt-[1px] shrink-0 text-accent-text" aria-hidden />
        {state === "whole" ? "NOVA can then look through all your drives and work with the files there, and still asks before changing anything. Windows, installed programs and app data stay off limits." : "NOVA may only look in the folders you gave it. Maybe it's somewhere else?"}
      </p>
      {problem && <p className="mt-1.5 text-[11.5px] text-danger">{problem}</p>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {state === "whole" ? (
          <>
            <Button size="sm" variant="primary" onClick={() => add(finderAddAllDrives)}>
              Yes, the whole PC
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setState("ask")}>
              Back
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="secondary" disabled={state === "busy"} icon={<FolderPlus size={13} aria-hidden />} onClick={() => add(finderPickFolder)}>
              Add a folder…
            </Button>
            <Button size="sm" variant="ghost" disabled={state === "busy"} onClick={() => setState("whole")}>
              Add the whole PC
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
