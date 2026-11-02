import type { MetricSample } from "./history";
import { MetricChart } from "./MetricChart";

/** Compact single-metric chart used inside dashboard widgets. */
export function UsageChart({ samples, metric }: { samples: MetricSample[]; metric: "cpu" | "memory" | "gpu" }) {
  return <MetricChart samples={samples} series={[{ key: metric, label: metric }]} />;
}
