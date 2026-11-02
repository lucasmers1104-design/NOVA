import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "bg-white/[0.06] text-fg-muted border-line",
  accent: "accent-soft text-accent-text border-accent/25",
  success: "bg-success/10 text-success border-success/25",
  warning: "bg-warning/10 text-warning border-warning/25",
  danger: "bg-danger/10 text-danger border-danger/25",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium whitespace-nowrap",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Dot indicating a live data feed. It pulses a few times, then rests: a
 * running animation makes the whole glass window recomposite every frame
 * (measured ~6 % CPU on a dual-core laptop for two dots).
 */
export function LiveDot({ className }: { className?: string }) {
  return <span aria-hidden className={cn("size-1.5 rounded-full bg-success animate-[nova-pulse_2s_ease-in-out_3]", className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[6px] border border-line-strong bg-white/[0.06] px-1.5 font-sans text-[11px] font-medium text-fg-muted">
      {children}
    </kbd>
  );
}
