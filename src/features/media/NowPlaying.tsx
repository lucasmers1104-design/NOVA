import { Disc3, Pause, Play, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { formatTrackTime, type MediaState, sourceAppName, useArtwork, useLivePosition, useMediaControl, useSeek, useSetVolume, useVolume } from "./api";

export function Artwork({ state, size, className }: { state: MediaState; size: number; className?: string }) {
  const { data: artwork } = useArtwork(state.artworkKey);
  return artwork ? (
    <img src={artwork} alt="" draggable={false} style={{ width: size, height: size }} className={cn("shrink-0 rounded-[18%] object-cover shadow-[0_18px_40px_-12px_rgb(0_0_0/0.7)]", className)} />
  ) : (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cn("accent-gradient flex shrink-0 items-center justify-center rounded-[18%] text-on-accent shadow-[0_18px_40px_-12px_var(--nova-accent-glow)]", className)}
    >
      <Disc3 size={size * 0.42} strokeWidth={1.5} />
    </span>
  );
}

export function TransportControls({ state, size = "md" }: { state: MediaState; size?: "sm" | "md" }) {
  const control = useMediaControl();
  const app = sourceAppName(state.sourceAppId);
  const playing = state.status === "playing";
  const small = size === "sm";
  const button = (action: "previous" | "toggle" | "next", enabled: boolean, label: string, icon: React.ReactNode, primary = false) => (
    <button
      type="button"
      onClick={() => control.mutate(action)}
      disabled={!enabled || control.isPending}
      aria-label={enabled ? label : `${label} (not supported by ${app})`}
      title={enabled ? label : `${app} doesn't support this control`}
      className={cn(
        "flex items-center justify-center rounded-full transition-[transform,background-color,opacity] duration-150 active:scale-90 disabled:opacity-30",
        primary
          ? cn("bg-fg text-canvas hover:bg-white", small ? "size-9" : "size-12")
          : cn("text-fg hover:bg-white/[0.1]", small ? "size-8" : "size-10"),
      )}
    >
      {icon}
    </button>
  );
  const iconSize = small ? 16 : 20;
  return (
    <div className="flex items-center gap-2">
      {button("previous", state.canPrevious, "Previous track", <SkipBack size={iconSize} fill="currentColor" />)}
      {button(
        "toggle",
        state.canPlayPause,
        playing ? "Pause" : "Play",
        playing ? <Pause size={iconSize + 2} fill="currentColor" /> : <Play size={iconSize + 2} fill="currentColor" className="ml-0.5" />,
        true,
      )}
      {button("next", state.canNext, "Next track", <SkipForward size={iconSize} fill="currentColor" />)}
    </div>
  );
}

export function ProgressBar({ state }: { state: MediaState }) {
  const position = useLivePosition(state);
  const seek = useSeek();
  // While dragging, the handle follows the mouse rather than the song.
  const [dragging, setDragging] = useState<number | null>(null);
  if (position === null || state.durationMs === null) {
    return <p className="text-[11px] text-fg-subtle">{sourceAppName(state.sourceAppId)} doesn't report playback position.</p>;
  }
  const shown = dragging ?? position;
  const percent = state.durationMs > 0 ? (shown / state.durationMs) * 100 : 0;
  return (
    <div>
      {state.canSeek ? (
        <input
          type="range"
          min={0}
          max={state.durationMs}
          step={1000}
          value={shown}
          aria-label="Playback position"
          onChange={(e) => setDragging(Number(e.target.value))}
          onPointerUp={() => {
            if (dragging !== null) seek.mutate(dragging);
            setDragging(null);
          }}
          onKeyUp={() => {
            if (dragging !== null) seek.mutate(dragging);
            setDragging(null);
          }}
          className="nova-range w-full"
          style={{ "--range-fill": `${percent}%` } as React.CSSProperties}
        />
      ) : (
        <div role="progressbar" aria-label="Playback position" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} className="h-1.5 overflow-hidden rounded-full bg-white/[0.1]">
          <div className="h-full rounded-full bg-fg/90 transition-[width] duration-500 ease-linear" style={{ width: `${percent}%` }} />
        </div>
      )}
      <div className="mt-1.5 flex justify-between text-[11px] text-fg-subtle tabular-nums">
        <span>{formatTrackTime(shown)}</span>
        <span>−{formatTrackTime(state.durationMs - shown)}</span>
      </div>
    </div>
  );
}

export function VolumeControl() {
  const { data: volume, error } = useVolume();
  const setVolume = useSetVolume();
  if (error || !volume) return null;
  const Icon = volume.muted || volume.level === 0 ? VolumeX : volume.level < 0.5 ? Volume1 : Volume2;
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => setVolume.mutate({ muted: !volume.muted })}
        aria-label={volume.muted ? "Unmute" : "Mute"}
        aria-pressed={volume.muted}
        className="flex size-9 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-white/[0.08] hover:text-fg"
      >
        <Icon size={18} />
      </button>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(volume.level * 100)}
        onChange={(e) => setVolume.mutate({ level: Number(e.target.value) / 100 })}
        aria-label="System volume"
        className="nova-range w-full"
        style={{ "--range-fill": `${Math.round(volume.level * 100)}%` } as React.CSSProperties}
      />
      <span className="w-9 text-right text-[12px] text-fg-muted tabular-nums">{Math.round(volume.level * 100)}%</span>
    </div>
  );
}
