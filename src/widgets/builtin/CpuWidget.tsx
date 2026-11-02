import { Cpu } from "lucide-react";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { useSystemInfo, useSystemSnapshot } from "@/features/system/api";
import { useMetricHistory } from "@/features/system/history";
import { UsageChart } from "@/features/system/UsageChart";
import { formatFrequency, prettifyCpuBrand } from "@/lib/format";
import { useWidgetConfig } from "../config";
import { WidgetFrame } from "../WidgetFrame";

export function CpuWidget() {
  const { showChart } = useWidgetConfig<{ showChart: boolean }>();
  const snapshot = useSystemSnapshot();
  const { data: info } = useSystemInfo();
  const samples = useMetricHistory((s) => s.samples);

  return (
    <WidgetFrame title="Processor" icon={Cpu} live={snapshot.isSuccess}>
      {snapshot.error ? (
        <StatusMessage error={snapshot.error} subject="CPU data" onRetry={() => void snapshot.refetch()} />
      ) : snapshot.isPending ? (
        <div className="flex h-full flex-col gap-3">
          <Skeleton className="h-10 w-24" />
          <Skeleton className="h-3 w-40" />
          <Skeleton className="flex-1" />
        </div>
      ) : (
        <div className="flex h-full flex-col">
          <p className="flex items-baseline gap-1 tabular-nums">
            <span className="text-[40px] leading-none font-semibold tracking-tight text-fg">{Math.round(snapshot.data.cpuUsage)}</span>
            <span className="text-lg font-medium text-fg-muted">%</span>
          </p>
          <p className="mt-1.5 truncate text-[12px] text-fg-subtle" title={info?.cpuBrand ?? undefined}>
            {info?.cpuBrand ? prettifyCpuBrand(info.cpuBrand) : "Processor"}
          </p>
          {showChart ? (
            <div className="mt-3 min-h-0 flex-1" aria-label="CPU usage over this session">
              <UsageChart samples={samples} metric="cpu" />
            </div>
          ) : (
            <div className="flex-1" />
          )}
          <div className="mt-3 flex items-center justify-between text-[12px] text-fg-muted tabular-nums">
            <span>
              {info?.physicalCores ? `${info.physicalCores} cores · ` : ""}
              {info ? `${info.logicalCores} threads` : ""}
            </span>
            {snapshot.data.cpuFrequencyMhz !== null && <span>{formatFrequency(snapshot.data.cpuFrequencyMhz)}</span>}
          </div>
        </div>
      )}
    </WidgetFrame>
  );
}
