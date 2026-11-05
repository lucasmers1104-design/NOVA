import { AudioLines, History } from "lucide-react";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { WidgetFrame } from "@/widgets/WidgetFrame";
import { sourceAppName, useMediaHistory, useMediaState } from "./api";
import { Artwork, ProgressBar, TransportControls, VolumeControl } from "./NowPlaying";

export default function MediaPage() {
  const { data: state, error, isPending, refetch } = useMediaState();
  const history = useMediaHistory((s) => s.entries);
  const clearHistory = useMediaHistory((s) => s.clear);

  return (
    <Page>
      <PageHeader title="Media" description="Controls whatever Windows reports as playing — Spotify, browsers, Media Player and more." />
      <div className="grid grid-cols-12 gap-4">
        <section aria-label="Now playing" className="glass relative col-span-8 overflow-hidden rounded-widget p-7">
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
              <p className="max-w-sm text-[13px] text-fg-muted">Start music or a video in any app that supports Windows media controls and it will appear here.</p>
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
                  <div className="mt-4">
                    <TransportControls state={state} />
                  </div>
                </div>
              </div>
            </>
          )}
        </section>

        <div className="col-span-4 flex flex-col gap-4">
          <section aria-label="Volume" className="glass rounded-widget p-5">
            <p className="mb-2.5 text-[13px] font-medium text-fg-muted">System volume</p>
            <VolumeControl />
          </section>
          <div className="min-h-72 flex-1">
            <WidgetFrame
              title="Recently played"
              icon={History}
              actions={
                history.length > 0 ? (
                  <Button size="sm" variant="ghost" onClick={clearHistory} className="h-7">
                    Clear
                  </Button>
                ) : undefined
              }
            >
              {history.length === 0 ? (
                <p className="text-[13px] text-fg-muted">Tracks you play while NOVA is open are listed here.</p>
              ) : (
                <ul className="h-full space-y-2.5 overflow-y-auto">
                  {history.map((entry) => (
                    <li key={`${entry.at}-${entry.title}`} className="text-[13px]">
                      <p className="truncate font-medium text-fg">{entry.title}</p>
                      <p className="truncate text-[12px] text-fg-subtle">
                        {[entry.artist, entry.source].filter(Boolean).join(" · ")} ·{" "}
                        {new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </WidgetFrame>
          </div>
        </div>
      </div>
    </Page>
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
