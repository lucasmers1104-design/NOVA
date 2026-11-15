import { lazy, Suspense } from "react";
import type { MetricSample } from "./history";

type MetricKey = "cpu" | "memory" | "gpu" | "rx" | "tx";

export interface ChartSeries {
  key: MetricKey;
  label: string;
  /** Defaults to the accent; "secondary" uses the accent's companion hue. */
  tone?: "accent" | "secondary";
}

export interface MetricChartProps {
  samples: MetricSample[];
  series: readonly ChartSeries[];
  /** Fixed 0–100 for percentages, or auto-scaled. */
  percent?: boolean;
  format?: (value: number) => string;
  axes?: boolean;
}

// recharts is the largest library NOVA ships, and the widgets that draw charts are
// part of the main window's first bundle. Loaded here, it comes with the first chart
// that has something to draw: a dashboard without charts never pays for it.
const MetricChartCanvas = lazy(() => import("./MetricChartCanvas"));

/** Sliding session-history area chart. */
export function MetricChart(props: MetricChartProps) {
  if (props.samples.length < 2) {
    return <div className="flex h-full items-center justify-center text-[12px] text-fg-subtle">Collecting samples…</div>;
  }
  return (
    <Suspense fallback={<div className="h-full" aria-hidden />}>
      <MetricChartCanvas {...props} />
    </Suspense>
  );
}
