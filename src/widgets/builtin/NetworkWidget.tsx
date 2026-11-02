import { ArrowDown, ArrowUp, Network } from "lucide-react";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { useSystemSnapshot } from "@/features/system/api";
import { useMetricHistory } from "@/features/system/history";
import { MetricChart } from "@/features/system/MetricChart";
import { formatBitRate, formatBytes } from "@/lib/format";
import { useWidgetConfig } from "../config";
import { WidgetFrame } from "../WidgetFrame";

export function NetworkWidget() {
  const { showChart } = useWidgetConfig<{ showChart: boolean }>();
  const snapshot = useSystemSnapshot();
  const samples = useMetricHistory((s) => s.samples);
  const network = snapshot.data?.network;

  return (
    <WidgetFrame title="Network" icon={Network} live={snapshot.isSuccess}>
      {snapshot.error ? (
        <StatusMessage error={snapshot.error} subject="network data" onRetry={() => void snapshot.refetch()} />
      ) : snapshot.isPending ? (
        <Skeleton className="h-full" />
      ) : !network ? (
        <p className="flex h-full items-center justify-center text-[13px] text-fg-muted">Network statistics aren't available.</p>
      ) : (
        <div className="flex h-full flex-col">
          <div className="grid grid-cols-2 gap-3">
            <Rate icon={ArrowDown} label="Download" value={formatBitRate(network.rxPerSec)} />
            <Rate icon={ArrowUp} label="Upload" value={formatBitRate(network.txPerSec)} />
          </div>
          {showChart ? (
            <div className="mt-3 min-h-0 flex-1" aria-label="Network throughput over this session">
              <MetricChart
                samples={samples}
                series={[
                  { key: "rx", label: "Download" },
                  { key: "tx", label: "Upload", tone: "secondary" },
                ]}
                percent={false}
                format={formatBitRate}
              />
            </div>
          ) : (
            <div className="flex-1" />
          )}
          <p className="mt-2 text-[11px] text-fg-subtle tabular-nums">
            Since boot: ↓ {formatBytes(network.totalRx)} · ↑ {formatBytes(network.totalTx)}
          </p>
        </div>
      )}
    </WidgetFrame>
  );
}

function Rate({ icon: Icon, label, value }: { icon: typeof ArrowDown; label: string; value: string }) {
  return (
    <div>
      <p className="flex items-center gap-1 text-[11px] text-fg-subtle">
        <Icon size={12} aria-hidden /> {label}
      </p>
      <p className="mt-0.5 text-[18px] font-semibold text-fg tabular-nums">{value}</p>
    </div>
  );
}
