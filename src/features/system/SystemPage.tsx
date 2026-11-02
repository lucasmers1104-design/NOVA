import { Activity, ArrowDown, ArrowUp, Cpu, Gauge, ListTree, MemoryStick, Network, Thermometer, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { LiveDot } from "@/components/ui/Badge";
import { MeterBar } from "@/components/ui/Meter";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { cn } from "@/lib/cn";
import { formatBitRate, formatBytes, formatFrequency, formatPercent, prettifyCpuBrand, ratioPercent } from "@/lib/format";
import { REFRESH_INTERVALS_MS, useSettings } from "@/stores/settings";
import { RegisteredWidget } from "@/widgets/RegisteredWidget";
import { WidgetFrame } from "@/widgets/WidgetFrame";
import { type SystemSnapshot, useNetworkInterfaces, useSystemInfo, useSystemSnapshot, useTemperatures } from "./api";
import { primaryGpuUsage, useMetricHistory } from "./history";
import { MetricChart } from "./MetricChart";
import { ProcessTable } from "./ProcessTable";

const REFRESH_OPTIONS = REFRESH_INTERVALS_MS.map((ms) => ({ value: ms, label: `${ms / 1000}s` }));

export default function SystemPage() {
  const snapshot = useSystemSnapshot();
  const refreshIntervalMs = useSettings((s) => s.refreshIntervalMs);
  const setRefreshInterval = useSettings((s) => s.setRefreshInterval);

  return (
    <Page>
      <PageHeader
        title="System"
        description="Live readings from this PC. Values your hardware doesn't expose are shown as not reported — never estimated."
        actions={
          <>
            {snapshot.isSuccess && (
              <span className="flex items-center gap-1.5 text-[12px] font-medium text-fg-muted">
                <LiveDot /> Live
              </span>
            )}
            <SegmentedControl label="Refresh interval" value={refreshIntervalMs} options={REFRESH_OPTIONS} onChange={setRefreshInterval} />
          </>
        }
      />
      {snapshot.error ? (
        <div className="glass rounded-widget p-10">
          <StatusMessage error={snapshot.error} subject="system data" onRetry={() => void snapshot.refetch()} />
        </div>
      ) : snapshot.isPending ? (
        <div className="grid grid-cols-4 gap-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28 rounded-widget" />
          ))}
        </div>
      ) : (
        <SystemDashboard snapshot={snapshot.data} />
      )}
    </Page>
  );
}

function SystemDashboard({ snapshot }: { snapshot: SystemSnapshot }) {
  const samples = useMetricHistory((s) => s.samples);
  const { data: info } = useSystemInfo();
  const gpuUsage = primaryGpuUsage(snapshot);
  const memoryPercent = ratioPercent(snapshot.memoryUsed, snapshot.memoryTotal);

  return (
    <div className="grid grid-cols-12 gap-4">
      <StatTile className="col-span-3" icon={Cpu} label="Processor" value={formatPercent(snapshot.cpuUsage)} detail={info?.cpuBrand ? prettifyCpuBrand(info.cpuBrand) : undefined} percent={snapshot.cpuUsage} />
      <StatTile
        className="col-span-3"
        icon={MemoryStick}
        label="Memory"
        value={formatPercent(memoryPercent)}
        detail={`${formatBytes(snapshot.memoryUsed)} of ${formatBytes(snapshot.memoryTotal)}`}
        percent={memoryPercent}
      />
      <StatTile
        className="col-span-3"
        icon={Zap}
        label="Graphics"
        value={gpuUsage === null ? "—" : formatPercent(gpuUsage)}
        detail={snapshot.gpus[0]?.name ?? "No graphics adapter detected"}
        percent={gpuUsage ?? undefined}
      />
      <StatTile
        className="col-span-3"
        icon={Network}
        label="Network"
        value={snapshot.network ? formatBitRate(snapshot.network.rxPerSec) : "—"}
        detail={snapshot.network ? `↑ ${formatBitRate(snapshot.network.txPerSec)}` : "Not reported"}
      />

      <Panel className="col-span-8 h-80" title="Processor history" icon={Activity}>
        <MetricChart samples={samples} series={[{ key: "cpu", label: "CPU" }]} axes />
      </Panel>
      <Panel className="col-span-4 h-80" title="Per core" icon={Gauge}>
        <CoreGrid cores={snapshot.cpuPerCore} frequency={snapshot.cpuFrequencyMhz} />
      </Panel>

      <Panel className="col-span-6 h-72" title="Memory history" icon={MemoryStick}>
        <MetricChart samples={samples} series={[{ key: "memory", label: "Memory" }]} axes />
      </Panel>
      <Panel className="col-span-6 h-72" title="Graphics" icon={Zap}>
        <GpuPanel snapshot={snapshot} />
      </Panel>

      <Panel className="col-span-8 h-72" title="Network throughput" icon={Network}>
        <MetricChart
          samples={samples}
          series={[
            { key: "rx", label: "Download" },
            { key: "tx", label: "Upload", tone: "secondary" },
          ]}
          percent={false}
          format={formatBitRate}
          axes
        />
      </Panel>
      <Panel className="col-span-4 h-72" title="Adapters" icon={Network}>
        <InterfaceList />
      </Panel>

      <div className="col-span-6 h-64">
        <RegisteredWidget id="storage" />
      </div>
      <Panel className="col-span-6 h-64" title="Temperatures" icon={Thermometer}>
        <SensorList />
      </Panel>

      <Panel className="col-span-12 h-[520px]" title="Processes" icon={ListTree}>
        <ProcessTable />
      </Panel>
    </div>
  );
}

function Panel({ title, icon, className, children }: { title: string; icon: LucideIcon; className?: string; children: ReactNode }) {
  return (
    <div className={className}>
      <WidgetFrame title={title} icon={icon}>
        {children}
      </WidgetFrame>
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  detail,
  percent,
  className,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail?: string;
  percent?: number;
  className?: string;
}) {
  return (
    <section aria-label={label} className={cn("glass flex flex-col rounded-widget p-5", className)}>
      <p className="flex items-center gap-2 text-[12px] font-semibold text-fg-muted">
        <Icon size={14} className="text-accent-text" aria-hidden />
        {label}
      </p>
      <p className="mt-2 text-[28px] leading-none font-semibold tracking-tight text-fg tabular-nums">{value}</p>
      <p className="mt-1.5 truncate text-[12px] text-fg-subtle" title={detail}>
        {detail ?? " "}
      </p>
      {percent !== undefined && (
        <div className="mt-3">
          <MeterBar percent={percent} label={`${label} usage`} />
        </div>
      )}
    </section>
  );
}

function CoreGrid({ cores, frequency }: { cores: number[]; frequency: number | null }) {
  return (
    <div className="flex h-full flex-col">
      <div className={cn("grid flex-1 content-start gap-2", cores.length > 8 ? "grid-cols-4" : "grid-cols-2")}>
        {cores.map((usage, index) => (
          <div key={index} className="rounded-[10px] bg-white/[0.035] px-3 py-2">
            <div className="flex items-baseline justify-between text-[11px] text-fg-subtle">
              <span>Core {index + 1}</span>
              <span className="text-[13px] font-semibold text-fg tabular-nums">{Math.round(usage)}%</span>
            </div>
            <div className="mt-1.5">
              <MeterBar percent={usage} label={`Core ${index + 1} usage`} />
            </div>
          </div>
        ))}
      </div>
      {frequency !== null && <p className="mt-2 text-[12px] text-fg-subtle tabular-nums">Reported clock {formatFrequency(frequency)}</p>}
    </div>
  );
}

function GpuPanel({ snapshot }: { snapshot: SystemSnapshot }) {
  const samples = useMetricHistory((s) => s.samples);
  if (snapshot.gpus.length === 0) {
    return <p className="flex h-full items-center justify-center text-[13px] text-fg-muted">No graphics adapter was reported by Windows.</p>;
  }
  const hasUsage = samples.some((s) => s.gpu !== null);
  return (
    <div className="flex h-full flex-col gap-3">
      <ul className="space-y-2">
        {snapshot.gpus.map((gpu, index) => (
          <li key={`${gpu.name}-${index}`} className="flex items-center justify-between gap-4 text-[13px]">
            <span className="min-w-0">
              <span className="block truncate font-medium text-fg">{gpu.name}</span>
              <span className="block text-[12px] text-fg-subtle">
                {gpu.memoryTotal !== null
                  ? `${gpu.memoryUsed !== null ? `${formatBytes(gpu.memoryUsed)} of ` : ""}${formatBytes(gpu.memoryTotal)} dedicated memory`
                  : "Shares system memory"}
              </span>
            </span>
            <span className="shrink-0 text-[15px] font-semibold text-fg tabular-nums">
              {gpu.usage === null ? <span className="text-[12px] font-normal text-fg-subtle">Measuring…</span> : formatPercent(gpu.usage)}
            </span>
          </li>
        ))}
      </ul>
      <div className="min-h-0 flex-1">
        {hasUsage ? (
          <MetricChart samples={samples} series={[{ key: "gpu", label: "GPU" }]} />
        ) : (
          <p className="flex h-full items-center justify-center text-[12px] text-fg-subtle">Waiting for a second sample to compute utilization…</p>
        )}
      </div>
    </div>
  );
}

function InterfaceList() {
  const { data, error, isPending } = useNetworkInterfaces();
  if (error) return <StatusMessage error={error} subject="network adapters" compact />;
  if (isPending) return <Skeleton className="h-16" />;
  if (data.length === 0) return <p className="text-[13px] text-fg-muted">No network adapters found.</p>;
  return (
    <ul className="h-full space-y-3 overflow-y-auto">
      {data.map((nic) => (
        <li key={nic.mac} className="text-[13px]">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium text-fg" title={nic.name}>
              {nic.name}
            </span>
            <span className={cn("shrink-0 text-[11px] font-medium", nic.up ? "text-success" : "text-fg-subtle")}>{nic.up ? "Connected" : "Down"}</span>
          </div>
          <p className="mt-0.5 flex gap-3 text-[11px] text-fg-subtle tabular-nums">
            <span className="flex items-center gap-1">
              <ArrowDown size={11} aria-hidden /> {formatBytes(nic.totalRx)}
            </span>
            <span className="flex items-center gap-1">
              <ArrowUp size={11} aria-hidden /> {formatBytes(nic.totalTx)}
            </span>
            {nic.linkSpeedBps !== null && <span>{formatBitRate(nic.linkSpeedBps / 8)} link</span>}
          </p>
        </li>
      ))}
    </ul>
  );
}

function SensorList() {
  const { data, error, isPending } = useTemperatures();
  if (error) return <StatusMessage error={error} subject="temperature sensors" compact />;
  if (isPending) return <Skeleton className="h-16" />;
  if (data.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
        <Thermometer size={20} className="text-fg-subtle" aria-hidden />
        <p className="text-[13px] font-medium text-fg">No temperature sensors exposed</p>
        <p className="max-w-80 text-[12px] leading-relaxed text-fg-muted">
          This PC's firmware doesn't publish CPU or GPU temperatures to regular apps. NOVA shows nothing rather than a guess.
        </p>
      </div>
    );
  }
  return (
    <ul className="h-full space-y-2.5 overflow-y-auto">
      {data.map((sensor, index) => (
        <li key={`${sensor.label}-${index}`} className="flex items-center justify-between text-[13px]">
          <span className="truncate text-fg-muted">{sensor.label || `Sensor ${index + 1}`}</span>
          <span className={cn("font-semibold tabular-nums", sensor.criticalCelsius !== null && sensor.celsius >= sensor.criticalCelsius - 10 ? "text-warning" : "text-fg")}>
            {sensor.celsius.toFixed(0)} °C
          </span>
        </li>
      ))}
    </ul>
  );
}
