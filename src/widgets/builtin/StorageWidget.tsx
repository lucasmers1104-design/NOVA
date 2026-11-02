import { HardDrive, Usb } from "lucide-react";
import { MeterBar } from "@/components/ui/Meter";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { type StorageVolume, useStorageVolumes } from "@/features/system/api";
import { formatBytes, ratioPercent } from "@/lib/format";
import { useWidgetConfig } from "../config";
import { WidgetFrame } from "../WidgetFrame";

/** "Windows (C:)" or "Local Disk (C:)" — matching Explorer's naming. */
export function volumeLabel(volume: Pick<StorageVolume, "name" | "mountPoint">): string {
  const drive = volume.mountPoint.replace(/[\\/]+$/, "");
  return `${volume.name || "Local Disk"} (${drive})`;
}

const KIND_LABEL: Record<StorageVolume["kind"], string | null> = { ssd: "SSD", hdd: "HDD", unknown: null };

export function StorageWidget() {
  const { showRemovable } = useWidgetConfig<{ showRemovable: boolean }>();
  const { data: allVolumes, error, isPending, refetch } = useStorageVolumes();
  const data = showRemovable ? allVolumes : allVolumes?.filter((volume) => !volume.removable);

  return (
    <WidgetFrame title="Storage" icon={HardDrive}>
      {error ? (
        <StatusMessage error={error} subject="storage data" onRetry={() => void refetch()} compact />
      ) : isPending || !data ? (
        <div className="space-y-4">
          <Skeleton className="h-11" />
          <Skeleton className="h-11" />
        </div>
      ) : data.length === 0 ? (
        <p className="flex h-full items-center justify-center text-[13px] text-fg-muted">No storage volumes found.</p>
      ) : (
        <ul className="-mr-2 h-full space-y-4 overflow-y-auto pr-2">
          {data.map((volume) => {
            const used = volume.totalBytes - volume.availableBytes;
            const percent = ratioPercent(used, volume.totalBytes);
            const Icon = volume.removable ? Usb : HardDrive;
            const details = [volume.fileSystem, KIND_LABEL[volume.kind], volume.removable ? "Removable" : null].filter(Boolean).join(" · ");
            return (
              <li key={volume.mountPoint} className="flex items-center gap-3.5">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-[11px] border border-line bg-white/[0.04] text-fg-muted">
                  <Icon size={18} strokeWidth={1.8} aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[13px]">
                    <span className="truncate font-medium text-fg">{volumeLabel(volume)}</span>
                    <span className="shrink-0 text-[12px] text-fg-muted tabular-nums">
                      {formatBytes(volume.availableBytes)} free of {formatBytes(volume.totalBytes)}
                    </span>
                  </div>
                  <MeterBar percent={percent} label={`${volumeLabel(volume)} usage`} />
                  <p className="mt-1.5 flex justify-between text-[11px] text-fg-subtle tabular-nums">
                    <span>{details}</span>
                    <span>{Math.round(percent)}% used</span>
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetFrame>
  );
}
