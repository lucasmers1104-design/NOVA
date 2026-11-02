import { motion } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Fill color for a usage percentage: accent normally, amber/red when nearly full. */
export function usageTone(percent: number): string {
  if (percent >= 95) return "bg-danger";
  if (percent >= 85) return "bg-warning";
  return "bg-accent";
}

export function MeterBar({ percent, label }: { percent: number; label: string }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped)} className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]">
      <motion.div
        className={cn("h-full rounded-full", usageTone(clamped))}
        initial={{ width: 0 }}
        animate={{ width: `${clamped}%` }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      />
    </div>
  );
}

interface RingGaugeProps {
  percent: number;
  label: string;
  size?: number;
  thickness?: number;
  children?: ReactNode;
}

export function RingGauge({ percent, label, size = 128, thickness = 10, children }: RingGaugeProps) {
  const clamped = Math.min(100, Math.max(0, percent));
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeClass = clamped >= 95 ? "stroke-danger" : clamped >= 85 ? "stroke-warning" : "stroke-accent";

  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className="relative shrink-0"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={thickness} className="stroke-white/[0.07]" />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={circumference}
          className={cn(strokeClass, "drop-shadow-[0_0_8px_var(--nova-accent-glow)]")}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: circumference * (1 - clamped / 100) }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  );
}
