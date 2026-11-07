import { AudioLines, History, Mic2, MonitorPlay, Moon, Music2, Play, Search, SlidersHorizontal, Volume2, VolumeX } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { cn } from "@/lib/cn";
import { useSettings } from "@/stores/settings";
import { WidgetFrame } from "@/widgets/WidgetFrame";
import {
  currentLine,
  type MediaState,
  sourceAppName,
  useClearPlayed,
  useLivePosition,
  useLyrics,
  useMediaState,
  useMixer,
  useOutputs,
  usePlayed,
  usePlaySomething,
  useSetMixer,
  useSetOutput,
  useSetSleepTimer,
  useSleepTimer,
} from "./api";
import { Artwork, ProgressBar, TransportControls, VolumeControl } from "./NowPlaying";

const SLEEP_CHOICES = [15, 30, 60, 90];

/** "discord" → "Discord", "fortniteclient-win64-shipping" → "Fortniteclient". */
export function programLabel(name: string): string {
  const first = name.split(/[-_.]/)[0] ?? name;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

export default function MediaPage() {
  const { data: state, error, isPending, refetch } = useMediaState();
  const [lyricsOpen, setLyricsOpen] = useState(false);

  return (
    <Page>
      <PageHeader title="Media" description="Controls whatever Windows reports as playing — Spotify, browsers, Media Player and more." />
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-8 flex flex-col gap-4">
          <section aria-label="Now playing" className="glass relative overflow-hidden rounded-widget p-7">
            {error ? (
              <StatusMessage error={error} subject="media sessions" onRetry={() => void refetch()} />
            ) : isPending ? (
              <div className="flex gap-7">
                <Skeleton className="size-[220px] rounded-[18%]" />
                <div className="flex-1 space-y-3 pt-6">
                  <Skeleton className="h-8 w-2/3" />
                  <Skeleton className="h-5 w-1/3" />
                </div>
              </div>
            ) : !state || !state.title ? (
              <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center">
                <span className="flex size-16 items-center justify-center rounded-[20px] border border-line bg-white/[0.04] text-fg-subtle">
                  <AudioLines size={28} aria-hidden />
                </span>
                <p className="text-[15px] font-medium text-fg">Nothing is playing</p>
                <p className="max-w-sm text-[13px] text-fg-muted">Start something below, ask NOVA, or play music or a video in any app that supports Windows media controls.</p>
              </div>
            ) : (
              <>
                <BlurredBackdrop state={state} />
                <div className="relative flex items-center gap-7">
                  <Artwork state={state} size={220} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">
                      {state.status === "playing" ? "Now playing" : state.status === "paused" ? "Paused" : "Ready"} · {sourceAppName(state.sourceAppId)}
                    </p>
                    <h2 className="mt-2 line-clamp-2 text-[26px] leading-tight font-semibold tracking-tight text-fg select-text">{state.title}</h2>
                    <p className="mt-1 truncate text-[15px] text-fg-muted select-text">{[state.artist, state.album].filter(Boolean).join(" — ")}</p>
                    <div className="mt-6 max-w-md">
                      <ProgressBar state={state} />
                    </div>
                    <div className="mt-4 flex items-center gap-3">
                      <TransportControls state={state} />
                      <Button size="sm" variant={lyricsOpen ? "secondary" : "ghost"} icon={<Mic2 size={14} aria-hidden />} aria-pressed={lyricsOpen} onClick={() => setLyricsOpen((open) => !open)}>
                        Lyrics
                      </Button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </section>
          {lyricsOpen && state?.title && <Lyrics state={state} />}
          <QuickPlay />
        </div>

        <div className="col-span-4 flex flex-col gap-4">
          <section aria-label="Volume" className="glass rounded-widget p-5">
            <p className="mb-2.5 text-[13px] font-medium text-fg-muted">System volume</p>
            <VolumeControl />
            <OutputPicker />
          </section>
          <Mixer />
          <SleepTimer />
          <div className="min-h-72 flex-1">
            <RecentlyPlayed />
          </div>
        </div>
      </div>
    </Page>
  );
}

/** Type something and it plays, without going through the AI. */
function QuickPlay() {
  const [query, setQuery] = useState("");
  const play = usePlaySomething();
  const [started, setStarted] = useState<string | null>(null);
  const start = (service: "youtube" | "spotify") => {
    setStarted(null);
    play.mutate({ service, query }, { onSuccess: (title) => setStarted(title) });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim()) start("youtube");
  };
  return (
    <section aria-label="Play something" className="glass rounded-widget p-5">
      <form onSubmit={submit} className="flex items-center gap-2">
        <span className="relative min-w-0 flex-1">
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={200} placeholder="Play something…" aria-label="What to play" className="h-9 w-full rounded-[10px] border border-line bg-white/[0.04] pr-3 pl-9 text-[13px] text-fg outline-none placeholder:text-fg-subtle focus:border-accent/60" />
        </span>
        <Button size="sm" variant="secondary" type="submit" icon={<MonitorPlay size={14} aria-hidden />} disabled={!query.trim() || play.isPending}>
          YouTube
        </Button>
        <Button size="sm" variant="secondary" icon={<Music2 size={14} aria-hidden />} disabled={!query.trim() || play.isPending} onClick={() => start("spotify")}>
          Spotify
        </Button>
      </form>
      {play.isPending && <p className="mt-2 text-[12px] text-fg-muted">Starting…</p>}
      {started && !play.isPending && (
        <p className="mt-2 flex items-center gap-1.5 truncate text-[12px] text-fg-muted">
          <Play size={11} aria-hidden /> {started}
        </p>
      )}
    </section>
  );
}

/** The song's text, following along when it's synced. */
function Lyrics({ state }: { state: MediaState }) {
  const { data: lines, isPending, error } = useLyrics(state, true);
  const position = useLivePosition(state) ?? 0;
  const list = useRef<HTMLOListElement>(null);
  const current = lines ? currentLine(lines, position) : -1;
  useEffect(() => {
    const box = list.current;
    const line = box?.children[current];
    // Only inside the list: the page itself stays where it is.
    if (box && line instanceof HTMLElement) box.scrollTo({ top: line.offsetTop - box.clientHeight / 2 + line.clientHeight / 2, behavior: "smooth" });
  }, [current]);
  const synced = lines?.some((line) => line.atMs !== null) ?? false;
  return (
    <section aria-label="Lyrics" className="glass rounded-widget p-5">
      {isPending ? (
        <Skeleton className="h-40" />
      ) : error ? (
        <p className="text-[13px] text-fg-muted">The lyrics couldn't be loaded right now.</p>
      ) : !lines || lines.length === 0 ? (
        <p className="text-[13px] text-fg-muted">No lyrics found for this one. Videos and less known songs often aren't in the database.</p>
      ) : (
        <ol ref={list} className="relative max-h-72 space-y-1 overflow-y-auto pr-2">
          {lines.map((line, index) => (
            <li key={index} className={cn("text-[15px] leading-relaxed transition-colors select-text", !synced && "text-fg-muted", synced && (index === current ? "font-semibold text-fg" : "text-fg-subtle"))}>
              {line.text || " "}
            </li>
          ))}
        </ol>
      )}
      <p className="mt-2 text-[11px] text-fg-subtle">Lyrics from LRCLIB. Opening them sends the song's name there.</p>
    </section>
  );
}

function OutputPicker() {
  const { data: outputs } = useOutputs();
  const setOutput = useSetOutput();
  if (!outputs || outputs.length < 2) return null;
  const current = outputs.find((device) => device.default);
  return (
    <label className="mt-3 block text-[12px] text-fg-muted">
      Sound comes out of
      <select value={current?.id ?? ""} disabled={setOutput.isPending} onChange={(event) => setOutput.mutate(event.target.value)} className="mt-1 h-9 w-full rounded-[10px] border border-line bg-white/[0.04] px-2 text-[13px] text-fg outline-none focus:border-accent/60">
        {outputs.map((device) => (
          <option key={device.id} value={device.id} className="bg-canvas">
            {device.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Mixer() {
  const { data: apps } = useMixer();
  const setMixer = useSetMixer();
  return (
    <section aria-label="Volume per program" className="glass rounded-widget p-5">
      <p className="mb-2.5 flex items-center gap-2 text-[13px] font-medium text-fg-muted">
        <SlidersHorizontal size={14} aria-hidden /> Volume per program
      </p>
      {!apps || apps.length === 0 ? (
        <p className="text-[12.5px] text-fg-subtle">Programs show up here once they make sound.</p>
      ) : (
        <ul className="space-y-2">
          {apps.map((app) => (
            <li key={app.name} className="flex items-center gap-2">
              <button
                type="button"
                aria-label={app.muted ? `Unmute ${programLabel(app.name)}` : `Mute ${programLabel(app.name)}`}
                aria-pressed={app.muted}
                onClick={() => setMixer.mutate({ name: app.name, muted: !app.muted })}
                className="flex size-7 shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-white/[0.08] hover:text-fg"
              >
                {app.muted ? <VolumeX size={14} aria-hidden /> : <Volume2 size={14} aria-hidden />}
              </button>
              <span className="w-20 shrink-0 truncate text-[12px] text-fg-muted" title={app.name}>
                {programLabel(app.name)}
              </span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(app.level * 100)}
                aria-label={`Volume of ${programLabel(app.name)}`}
                onChange={(event) => setMixer.mutate({ name: app.name, level: Number(event.target.value) / 100 })}
                className="nova-range min-w-0 flex-1"
                style={{ "--range-fill": `${Math.round(app.level * 100)}%` } as React.CSSProperties}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SleepTimer() {
  const { data: timer } = useSleepTimer();
  const setTimer = useSetSleepTimer();
  const use24Hour = useSettings((s) => s.use24HourClock);
  return (
    <section aria-label="Sleep timer" className="glass rounded-widget p-5">
      <p className="mb-2.5 flex items-center gap-2 text-[13px] font-medium text-fg-muted">
        <Moon size={14} aria-hidden /> Sleep timer
      </p>
      {timer ? (
        <div className="flex items-center justify-between gap-2 text-[13px] text-fg">
          <span>Music stops at {new Date(timer.endsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: use24Hour ? "h23" : "h12" })}</span>
          <Button size="sm" variant="ghost" onClick={() => setTimer.mutate(0)}>
            Turn off
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {SLEEP_CHOICES.map((minutes) => (
            <Button key={minutes} size="sm" variant="secondary" onClick={() => setTimer.mutate(minutes)}>
              {minutes} min
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}

function RecentlyPlayed() {
  const { data: history = [] } = usePlayed();
  const clear = useClearPlayed();
  const use24Hour = useSettings((s) => s.use24HourClock);
  return (
    <WidgetFrame
      title="Recently played"
      icon={History}
      actions={
        history.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={() => clear.mutate()} className="h-7">
            Clear
          </Button>
        ) : undefined
      }
    >
      {history.length === 0 ? (
        <p className="text-[13px] text-fg-muted">What plays while NOVA runs is listed here.</p>
      ) : (
        <ul className="h-full space-y-2.5 overflow-y-auto">
          {history.map((entry) => (
            <li key={`${entry.at}-${entry.title}`} className="text-[13px]">
              <p className="truncate font-medium text-fg">{entry.title}</p>
              <p className="truncate text-[12px] text-fg-subtle">
                {[entry.artist, sourceAppName(entry.source)].filter(Boolean).join(" · ")} · {new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: use24Hour ? "h23" : "h12" })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </WidgetFrame>
  );
}

/** Soft, heavily blurred artwork behind the player — rendered once, no animation. */
function BlurredBackdrop({ state }: { state: NonNullable<ReturnType<typeof useMediaState>["data"]> }) {
  return (
    <div aria-hidden className="pointer-events-none absolute -inset-10 opacity-35 blur-[60px] saturate-150">
      <Artwork state={state} size={600} className="h-full w-full rounded-none" />
    </div>
  );
}
