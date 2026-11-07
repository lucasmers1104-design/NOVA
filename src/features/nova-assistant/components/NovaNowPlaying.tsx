import { Disc3, Pause, Play, SkipForward } from "lucide-react";
import { useEffect, useState } from "react";
import { callNative } from "@/lib/native";
import { openNova } from "../api";

/** What the bar needs of `MediaState` in src-tauri/src/media.rs. */
interface Playing {
  title: string;
  artist: string;
  status: string;
  canPlayPause: boolean;
  canNext: boolean;
  artworkKey: string | null;
}

/** Often enough to follow a song change, rarely enough to stay out of the way. */
const POLL_MS = 3000;

/** The small player in NOVA's window: what plays, pause and next, while the window is open. */
export function NovaNowPlaying() {
  const [playing, setPlaying] = useState<Playing | null>(null);
  const [cover, setCover] = useState<string | null>(null);
  const artworkKey = playing?.artworkKey ?? null;

  useEffect(() => {
    let alive = true;
    const look = () => callNative<Playing | null>("media_state").then((state) => alive && setPlaying(state?.title ? state : null), () => alive && setPlaying(null));
    void look();
    const timer = setInterval(() => void look(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    if (!artworkKey) {
      setCover(null);
      return;
    }
    void callNative<string | null>("media_artwork").then((art) => alive && setCover(art), () => alive && setCover(null));
    return () => {
      alive = false;
    };
  }, [artworkKey]);

  if (!playing || (playing.status !== "playing" && playing.status !== "paused")) return null;
  const press = (action: "toggle" | "next") => void callNative("media_control", { action }).then(() => setTimeout(() => void callNative<Playing | null>("media_state").then((state) => setPlaying(state?.title ? state : null), () => {}), 300), () => {});
  const isPlaying = playing.status === "playing";
  return (
    <div className="mx-3 mb-1.5 flex shrink-0 items-center gap-2.5 rounded-[12px] bg-white/[0.045] p-1.5 pr-2">
      <button type="button" title="Open the player" aria-label="Open the player" onClick={() => void openNova("media")} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
        {cover ? (
          <img src={cover} alt="" draggable={false} className="size-8 shrink-0 rounded-[7px] object-cover" />
        ) : (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[7px] accent-soft text-accent-text">
            <Disc3 size={16} aria-hidden />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium text-fg">{playing.title}</span>
          {playing.artist && <span className="block truncate text-[11px] text-fg-muted">{playing.artist}</span>}
        </span>
      </button>
      <button type="button" disabled={!playing.canPlayPause} aria-label={isPlaying ? "Pause" : "Play"} title={isPlaying ? "Pause" : "Play"} onClick={() => press("toggle")} className="flex size-7 shrink-0 items-center justify-center rounded-full text-fg transition-colors hover:bg-white/[0.1] disabled:opacity-30">
        {isPlaying ? <Pause size={14} fill="currentColor" aria-hidden /> : <Play size={14} fill="currentColor" className="ml-0.5" aria-hidden />}
      </button>
      <button type="button" disabled={!playing.canNext} aria-label="Next" title="Next" onClick={() => press("next")} className="flex size-7 shrink-0 items-center justify-center rounded-full text-fg transition-colors hover:bg-white/[0.1] disabled:opacity-30">
        <SkipForward size={14} fill="currentColor" aria-hidden />
      </button>
    </div>
  );
}
