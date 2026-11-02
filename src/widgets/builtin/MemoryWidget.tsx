import { MemoryStick } from "lucide-react";
import { RingGauge } from "@/components/ui/Meter";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { useSystemSnapshot } from "@/features/system/api";
import { formatBytes, ratioPercent } from "@/lib/format";
import { useWidgetConfig } from "../config";
import { WidgetFrame } from "../WidgetFrame";

export function MemoryWidget() {
  const { showPageFile } = useWidgetConfig<{ showPageFile: boolean }>();
  const snapshot = useSystemSnapshot();

  return (
    <WidgetFrame title="Memory" icon={MemoryStick} live={snapshot.isSuccess}>
      {snapshot.error ? (
        <StatusMessage error={snapshot.error} subject="memory data" onRetry={() => void snapshot.refetch()} />
      ) : snapshot.isPending ? (
        <div className="flex h-full items-center gap-5">
          <Skeleton className="size-[120px] rounded-full" />
          <div className="flex-1 space-y-3">
            <Skeleton className="h-4" />
            <Skeleton className="h-4" />
            <Skeleton className="h-4" />
          </div>
        </div>
      ) : (
        <MemoryDetails
          used={snapshot.data.memoryUsed}
          total={snapshot.data.memoryTotal}
          swapUsed={snapshot.data.swapUsed}
          swapTotal={showPageFile ? snapshot.data.swapTotal : 0}
        />
      )}
    </WidgetFrame>
  );
}

function MemoryDetails({ used, total, swapUsed, swapTotal }: { used: number; total: number; swapUsed: number; swapTotal: number }) {
  const percent = ratioPercent(used, total);
  return (
    <div className="flex h-full flex-col justify-center gap-5">
      <div className="flex justify-center">
        <RingGauge percent={percent} label="Memory in use" size={124} thickness={10}>
          <span className="text-[26px] leading-none font-semibold text-fg tabular-nums">{Math.round(percent)}%</span>
          <span className="mt-1 text-[11px] text-fg-subtle">in use</span>
        </RingGauge>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-center">
        <Stat label="Used" value={formatBytes(used)} />
        <Stat label="Free" value={formatBytes(Math.max(0, total - used))} />
        <Stat label="Total" value={formatBytes(total)} />
      </dl>
      {swapTotal > 0 && (
        <p className="text-center text-[11px] text-fg-subtle tabular-nums">
          Page file {formatBytes(swapUsed)} of {formatBytes(swapTotal)}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[10px] bg-white/[0.035] px-2 py-2">
      <dt className="text-[11px] text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 text-[13px] font-semibold text-fg tabular-nums">{value}</dd>
    </div>
  );
}
