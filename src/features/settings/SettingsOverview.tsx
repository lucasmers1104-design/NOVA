import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { ArrowRight, Check, CloudDownload, Ear, FolderSearch, Play, Palette, Sparkles, type LucideIcon, Volume2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Switch } from "@/components/ui/Switch";
import { ACCENT_PRESETS, deriveAccentTokens } from "@/design/accent";
import { useAgent } from "@/features/nova-assistant/AgentSettings";
import { finderAddAllDrives, finderPickFolder, finderStatus } from "@/features/nova-assistant/api";
import { speak, speaksGerman, useVoice, watchNovaVoice } from "@/features/nova-assistant/voice";
import { configureWake, wakeStatus, type WakePrefs } from "@/features/nova-assistant/wake";
import { notifyError } from "@/features/notifications/store";
import { useUpdates } from "@/features/updates/store";
import { cn } from "@/lib/cn";
import { isDesktop } from "@/lib/native";
import { useSettings } from "@/stores/settings";

const FINDER_KEY = ["assistant", "finder"] as const;
const WAKE_KEY = ["wake", "status"] as const;

interface TileProps {
  title: string;
  icon: LucideIcon;
  /** The section with everything else about this. */
  more?: () => void;
  children: ReactNode;
}

function Tile({ title, icon: Icon, more, children }: TileProps) {
  return (
    <section className="glass flex min-w-0 flex-col rounded-widget p-4">
      <header className="mb-3 flex items-center gap-2">
        <Icon size={15} className="text-accent-text" aria-hidden />
        <h3 className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-fg">{title}</h3>
        {more && (
          <button type="button" onClick={more} className="flex items-center gap-1 text-[11.5px] text-fg-subtle transition-colors hover:text-accent-text">
            More <ArrowRight size={12} aria-hidden />
          </button>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5">{children}</div>
    </section>
  );
}

function SwitchLine({ label, hint, checked, disabled, onChange }: { label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-[12.5px] text-fg">{label}</p>
        {hint && <p className="text-[11.5px] leading-snug text-fg-subtle">{hint}</p>}
      </div>
      <Switch label={label} checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  );
}

/** What's still to set up, as a ring that fills. */
function SetupCard({ steps, onOpen }: { steps: { label: string; done: boolean; section: string }[]; onOpen: (section: string) => void }) {
  const done = steps.filter((s) => s.done).length;
  const radius = 21;
  const round = 2 * Math.PI * radius;
  return (
    <section className="glass rounded-widget p-4">
      <div className="flex items-center gap-4">
        <span className="relative flex size-14 shrink-0 items-center justify-center text-accent-text">
          <svg viewBox="0 0 54 54" className="absolute inset-0 -rotate-90" aria-hidden>
            <circle cx="27" cy="27" r={radius} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth="4" />
            <circle cx="27" cy="27" r={radius} fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeDasharray={round} strokeDashoffset={round * (1 - done / steps.length)} className="transition-[stroke-dashoffset] duration-500" />
          </svg>
          <span className="text-[13px] font-semibold text-fg tabular-nums">
            {done}/{steps.length}
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-fg">{done === steps.length ? "NOVA is all set" : "Get the most out of NOVA"}</h3>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {steps.map((step) => (
              <li key={step.label}>
                <button
                  type="button"
                  onClick={() => onOpen(step.section)}
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] transition-colors",
                    step.done ? "bg-success/10 text-success hover:bg-success/15" : "bg-white/[0.06] text-fg hover:bg-white/[0.1]",
                  )}
                >
                  {step.done ? <Check size={12} aria-hidden /> : <ArrowRight size={12} className="text-accent-text" aria-hidden />}
                  {step.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** The first page of Settings: how things stand, and what people change most, right here. */
export function SettingsOverview({ onOpen }: { onOpen: (section: string) => void }) {
  const desktop = isDesktop();
  const client = useQueryClient();
  const { status: agent, update: updateAgent } = useAgent();
  const prefs = agent?.prefs;
  const displayName = useSettings((s) => s.displayName);
  const accent = useSettings((s) => s.accent);
  const setAccent = useSettings((s) => s.setAccent);
  const transparency = useSettings((s) => s.transparency);
  const setTransparency = useSettings((s) => s.setTransparency);
  const novaVoice = useVoice((s) => s.novaVoice);
  const { data: wake } = useQuery({ queryKey: WAKE_KEY, queryFn: wakeStatus, enabled: desktop });
  const { data: finder } = useQuery({ queryKey: FINDER_KEY, queryFn: finderStatus, enabled: desktop });
  const { data: version } = useQuery({ queryKey: ["app", "version"], queryFn: () => (desktop ? getVersion() : __NOVA_VERSION__), staleTime: Number.POSITIVE_INFINITY });
  const update = useUpdates();
  const german = speaksGerman(prefs?.language ?? "auto");
  const [phrase, setPhrase] = useState("");
  const [confirmingAuto, setConfirmingAuto] = useState(false);
  const [confirmingPc, setConfirmingPc] = useState(false);

  useEffect(() => (desktop ? watchNovaVoice() : undefined), [desktop]);

  const setWake = (patch: Partial<WakePrefs>) => {
    if (!wake) return;
    configureWake({ ...wake.prefs, ...patch }).then(
      (next) => client.setQueryData(WAKE_KEY, next),
      (error: unknown) => notifyError("Couldn't change that", error),
    );
  };
  const finderAction = (action: typeof finderAddAllDrives) =>
    void action().then(
      (next) => client.setQueryData(FINDER_KEY, next),
      (error: unknown) => notifyError("Couldn't add that", error),
    );

  const items = finder?.folders.reduce((sum, folder) => sum + folder.files, 0) ?? 0;
  const steps = [
    { label: "Your name", done: displayName.trim() !== "", section: "you" },
    { label: "Connect an AI", done: Boolean(agent?.activeProvider), section: "ai" },
    { label: "Pick a voice", done: Boolean(prefs?.voice) || novaVoice?.state === "ready", section: "assistant-brain" },
    { label: "Hey NOVA", done: Boolean(wake?.prefs.phrase || wake?.prefs.clap), section: "wake" },
    { label: "Give NOVA your folders", done: (finder?.folders.length ?? 0) > 0, section: "finder" },
  ];
  const trySaying = () => {
    if (prefs) void speak(phrase.trim() || (german ? "Hallo, ich bin NOVA. So klinge ich." : "Hi, I'm NOVA. This is how I sound."), prefs, "test", german);
  };

  return (
    <div className="space-y-4">
      <SetupCard steps={steps} onOpen={onOpen} />
      <div className="grid grid-cols-2 gap-4">
        <Tile title="Hear NOVA" icon={Volume2} more={() => onOpen("assistant-brain")}>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              trySaying();
            }}
          >
            <input
              value={phrase}
              onChange={(event) => setPhrase(event.target.value)}
              placeholder={german ? "Was soll NOVA sagen?" : "What should NOVA say?"}
              aria-label="What NOVA should say"
              className="h-9 min-w-0 flex-1 rounded-control border border-line bg-black/25 px-3 text-[12.5px] text-fg outline-none select-text placeholder:text-fg-subtle focus:border-line-strong"
            />
            <Button size="sm" variant="primary" type="submit" disabled={!prefs} icon={<Play size={13} aria-hidden />}>
              Try
            </Button>
          </form>
          <label className="flex items-center gap-2.5 text-[12px] text-fg-muted">
            Speed
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.1}
              value={prefs?.speechRate ?? 1}
              disabled={!prefs}
              onChange={(event) => updateAgent({ speechRate: Number(event.target.value) })}
              className="nova-range min-w-0 flex-1"
              style={{ "--range-fill": `${(((prefs?.speechRate ?? 1) - 0.5) / 1.5) * 100}%` } as React.CSSProperties}
            />
            <span className="w-8 text-right text-fg tabular-nums">{(prefs?.speechRate ?? 1).toFixed(1)}×</span>
          </label>
          <SwitchLine label="Read every reply aloud" checked={prefs?.speakReplies ?? false} disabled={!prefs} onChange={(speakReplies) => updateAgent({ speakReplies })} />
        </Tile>

        <Tile title="Wake NOVA hands-free" icon={Ear} more={() => onOpen("wake")}>
          <SwitchLine label="“Hey NOVA”" checked={wake?.prefs.phrase ?? false} disabled={!wake} onChange={(on) => setWake({ phrase: on })} />
          <SwitchLine label="Double clap" checked={wake?.prefs.clap ?? false} disabled={!wake} onChange={(on) => setWake({ clap: on })} />
          <SwitchLine label="Also in games" checked={wake?.prefs.inGames ?? true} disabled={!wake} onChange={(on) => setWake({ inGames: on })} />
        </Tile>

        <Tile title="NOVA AI" icon={Sparkles} more={() => onOpen("assistant-brain")}>
          <button type="button" onClick={() => onOpen("ai")} className="rounded-[10px] bg-white/[0.04] px-2.5 py-2 text-left transition-colors hover:bg-white/[0.07]">
            <span className="block truncate text-[12.5px] font-medium text-fg">{agent?.activeProvider ? `${agent.activeProvider}` : "No AI connected"}</span>
            <span className="block truncate text-[11.5px] text-fg-subtle">{agent?.activeModel ?? "NOVA only understands simple commands until you add a key"}</span>
          </button>
          <SwitchLine label="Auto mode" hint="Acts without asking, at your own risk" checked={prefs?.autoMode ?? false} disabled={!prefs} onChange={(on) => (on ? setConfirmingAuto(true) : updateAgent({ autoMode: false }))} />
        </Tile>

        <Tile title="Your files" icon={FolderSearch} more={() => onOpen("finder")}>
          <p className="text-[12.5px] text-fg-muted">
            {finder?.progress.running ? `Indexing… ${finder.progress.scanned.toLocaleString()} checked` : items > 0 ? `${items.toLocaleString()} items in ${finder?.folders.length} folder${finder?.folders.length === 1 ? "" : "s"}` : "NOVA only searches your standard folders so far."}
          </p>
          <div className="mt-auto flex flex-wrap gap-1.5">
            <Button size="sm" variant="secondary" disabled={!desktop} onClick={() => finderAction(finderPickFolder)}>
              Add a folder…
            </Button>
            <Button size="sm" variant="ghost" disabled={!desktop} onClick={() => setConfirmingPc(true)}>
              Add the whole PC
            </Button>
          </div>
        </Tile>

        <Tile title="Look" icon={Palette} more={() => onOpen("appearance")}>
          <div role="radiogroup" aria-label="Accent color" className="flex flex-wrap gap-2">
            {ACCENT_PRESETS.map((preset) => {
              const selected = accent.kind === "preset" && accent.id === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={preset.name}
                  title={preset.name}
                  onClick={() => setAccent({ kind: "preset", id: preset.id })}
                  className={cn("flex size-7 items-center justify-center rounded-full transition-transform duration-200 hover:scale-110", selected && "ring-2 ring-fg/80 ring-offset-2 ring-offset-[#151a29]")}
                  style={{ backgroundColor: preset.color }}
                >
                  {selected && <Check size={13} strokeWidth={2.8} style={{ color: deriveAccentTokens(preset.color).onAccent }} aria-hidden />}
                </button>
              );
            })}
          </div>
          <SwitchLine label="Glass effects" checked={transparency} onChange={setTransparency} />
        </Tile>

        <Tile title="Updates" icon={CloudDownload} more={() => onOpen("updates")}>
          <p className="text-[12.5px] text-fg-muted">
            Version <span className="font-medium text-fg tabular-nums">{version ?? __NOVA_VERSION__}</span>
            {update.status === "available" && update.info ? ` · ${update.info.version} is ready` : update.status === "upToDate" ? " · up to date" : ""}
          </p>
          <div className="mt-auto">
            <Button size="sm" variant="secondary" disabled={!desktop || update.status === "checking"} onClick={() => void update.check({ automatic: false })}>
              {update.status === "checking" ? "Checking…" : "Check now"}
            </Button>
          </div>
        </Tile>
      </div>

      <ConfirmDialog
        open={confirmingAuto}
        title="Turn on auto mode?"
        description="NOVA will then do everything without asking: delete files, end programs, close windows, press keys and click in other apps, read your screen. A misheard sentence or a trick on a website it reads can cause real damage, and nothing stops it first. You use this at your own risk."
        confirmLabel="Turn on at my own risk"
        danger
        onClose={() => setConfirmingAuto(false)}
        onConfirm={() => {
          setConfirmingAuto(false);
          updateAgent({ autoMode: true });
        }}
      />
      <ConfirmDialog
        open={confirmingPc}
        title="Add the whole PC to NOVA Finder?"
        description="NOVA indexes the file names on all your drives in the background and can then work with the files there, still asking before it changes anything. Windows, installed programs and app data stay off limits. The index stays on this PC."
        confirmLabel="Add the whole PC"
        onClose={() => setConfirmingPc(false)}
        onConfirm={() => {
          setConfirmingPc(false);
          finderAction(finderAddAllDrives);
        }}
      />
    </div>
  );
}
