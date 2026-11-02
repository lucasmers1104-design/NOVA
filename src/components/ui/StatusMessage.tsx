import { CircleAlert, MonitorOff, RotateCcw } from "lucide-react";
import { NativeUnavailableError } from "@/lib/native";
import { cn } from "@/lib/cn";
import { Button } from "./Button";

interface StatusMessageProps {
  error: unknown;
  /** What failed to load, e.g. "memory data". */
  subject: string;
  onRetry?: () => void;
  compact?: boolean;
}

/**
 * Honest unavailable / error state. Distinguishes "needs the desktop runtime"
 * from genuine failures, and offers a retry only where retrying can help.
 */
export function StatusMessage({ error, subject, onRetry, compact }: StatusMessageProps) {
  const unavailable = error instanceof NativeUnavailableError;
  const Icon = unavailable ? MonitorOff : CircleAlert;
  const title = unavailable ? "Desktop runtime required" : `Couldn't load ${subject}`;
  const detail = unavailable
    ? `Live ${subject} is available when NOVA runs as a desktop app.`
    : error instanceof Error
      ? error.message
      : String(error);

  return (
    <div role="status" className={cn("flex h-full flex-col items-center justify-center text-center", compact ? "gap-1.5 py-2" : "gap-2.5 py-6")}>
      <span className={cn("flex size-9 items-center justify-center rounded-full", unavailable ? "bg-white/[0.06] text-fg-muted" : "bg-danger/10 text-danger")}>
        <Icon size={18} strokeWidth={1.8} />
      </span>
      <div className="max-w-64">
        <p className="text-[13px] font-medium text-fg">{title}</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-fg-muted">{detail}</p>
      </div>
      {!unavailable && onRetry && (
        <Button size="sm" variant="secondary" icon={<RotateCcw size={14} />} onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
