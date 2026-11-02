import { AudioLines } from "lucide-react";
import { sourceAppName, useMediaState } from "@/features/media/api";
import { Artwork, ProgressBar, TransportControls } from "@/features/media/NowPlaying";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { WidgetFrame } from "../WidgetFrame";

export function MusicWidget() {
  const { data: state, error, isPending, refetch } = useMediaState();
  return (
    <WidgetFrame title="Now playing" icon={AudioLines}>
      {error ? (
        <StatusMessage error={error} subject="media" onRetry={() => void refetch()} compact />
      ) : isPending ? (
        <Skeleton className="h-full" />
      ) : !state || !state.title ? (
        <p className="flex h-full items-center justify-center text-[13px] text-fg-muted">Nothing is playing.</p>
      ) : (
        <div className="flex h-full items-center gap-4">
          <Artwork state={state} size={88} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold text-fg">{state.title}</p>
            <p className="truncate text-[12px] text-fg-muted">{state.artist || sourceAppName(state.sourceAppId)}</p>
            <div className="mt-2.5">
              <ProgressBar state={state} />
            </div>
            <div className="mt-1.5 -ml-1">
              <TransportControls state={state} size="sm" />
            </div>
          </div>
        </div>
      )}
    </WidgetFrame>
  );
}
