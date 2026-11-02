import { Zap } from "lucide-react";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { useSystemSnapshot } from "@/features/system/api";
import { primaryGpuUsage, useMetricHistory } from "@/features/system/history";
import { MetricChart } from "@/features/system/MetricChart";
import { formatBytes } from "@/lib/format";
import { useWidgetConfig } from "../config";
import { WidgetFrame } from "../WidgetFrame";

export function GpuWidget() {
  const { showChart } = useWidgetConfig<{ showChart: boolean }>();
  const snapshot = useSystemSnapshot();
  const samples = useMetricHistory((s) => s.samples);

  return (
    <WidgetFrame title="Graphics" icon={Zap} live={snapshot.isSuccess}>
      {snapshot.error ? (
        <StatusMessage error={snapshot.error} subject="GPU data" onRetry={() => void snapshot.refetch()} />
      ) : snapshot.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-24" />
          <Skeleton className="h-24" />
        </div>
      ) : snapshot.data.gpus.length === 0 ? (
        <p className="flex h-full items-center justify-center text-center text-[13px] text-fg-muted">No graphics adapter was reported by Windows.</p>
      ) : (
        <div className="flex h-full flex-col">
          {(() => {
            const gpu = snapshot.data.gpus[0]!;
            const usage = primaryGpuUsage(snapshot.data);
            return (
              <>
                <p className="flex items-baseline gap-1 tabular-nums">
                  {usage === null ? (
                    <span className="text-[13px] text-fg-subtle">Measuring utilization…</span>
                  ) : (
                    <>
                      <span className="text-[40px] leading-none font-semibold tracking-tight text-fg">{Math.round(usage)}</span>
                      <span className="text-lg font-medium text-fg-muted">%</span>
                    </>
                  )}
                </p>
                <p className="mt-1.5 truncate text-[12px] text-fg-subtle" title={gpu.name}>
                  {gpu.name}
                </p>
                {showChart ? (
                  <div className="mt-3 min-h-0 flex-1" aria-label="GPU usage over this session">
                    <MetricChart samples={samples} series={[{ key: "gpu", label: "GPU" }]} />
                  </div>
                ) : (
                  <div className="flex-1" />
                )}
                <p className="mt-3 text-[12px] text-fg-muted tabular-nums">
                  {gpu.memoryTotal !== null
                    ? `${gpu.memoryUsed !== null ? `${formatBytes(gpu.memoryUsed)} / ` : ""}${formatBytes(gpu.memoryTotal)} VRAM`
                    : "Uses shared system memory"}
                </p>
              </>
            );
          })()}
        </div>
      )}
    </WidgetFrame>
  );
}
