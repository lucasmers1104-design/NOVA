import { Monitor } from "lucide-react";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { useSystemInfo, useSystemSnapshot } from "@/features/system/api";
import { formatBytes, formatUptime, prettifyCpuBrand } from "@/lib/format";
import { useWidgetConfig } from "../config";
import { WidgetFrame } from "../WidgetFrame";

export function DeviceWidget() {
  const { showDeviceName } = useWidgetConfig<{ showDeviceName: boolean }>();
  const { data: info, error, isPending, refetch } = useSystemInfo();
  const { data: snapshot } = useSystemSnapshot();

  return (
    <WidgetFrame title="This device" icon={Monitor}>
      {error ? (
        <StatusMessage error={error} subject="device details" onRetry={() => void refetch()} />
      ) : isPending ? (
        <div className="space-y-3.5">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-4" />
          ))}
        </div>
      ) : (
        <dl className="divide-y divide-line text-[13px]">
          {showDeviceName && <Row label="Name" value={info.hostName} />}
          <Row label="System" value={info.osName} />
          <Row label="Version" value={info.osVersion} />
          <Row label="Processor" value={info.cpuBrand ? prettifyCpuBrand(info.cpuBrand) : null} />
          <Row label="Memory" value={formatBytes(info.totalMemory)} />
          <Row label="Architecture" value={info.arch} />
          <Row label="Uptime" value={snapshot?.uptimeSeconds != null ? formatUptime(snapshot.uptimeSeconds) : null} />
        </dl>
      )}
    </WidgetFrame>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-center justify-between gap-4 py-[7px] first:pt-0">
      <dt className="shrink-0 text-fg-subtle">{label}</dt>
      <dd className="truncate text-right font-medium text-fg tabular-nums" title={value ?? undefined}>
        {value ?? <span className="font-normal text-fg-subtle">Not reported</span>}
      </dd>
    </div>
  );
}
