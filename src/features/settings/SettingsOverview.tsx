import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { ArrowRight, Check, CloudDownload, Ear, FolderSearch, History, type LucideIcon, Palette, Play, Sparkles, Volume2 } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { ACCENT_PRESETS, deriveAccentTokens } from "@/design/accent";
import { AutoModeDialog, useAgent, WholePcDialog } from "@/features/nova-assistant/AgentSettings";
import { finderAddAllDrives, finderPickFolder, finderStatus } from "@/features/nova-assistant/api";
import { speak, speaksGerman, useVoice, watchNovaVoice } from "@/features/nova-assistant/voice";
import { configureWake, type WakePrefs, wakeStatus } from "@/features/nova-assistant/wake";
import { notifyError } from "@/features/notifications/store";
import { useUpdates } from "@/features/updates/store";
import { cn } from "@/lib/cn";
import { isDesktop } from "@/lib/native";
import { useSettings } from "@/stores/settings";
import { accentName } from "./AccentSettings";
import { ago, recordChange, useRecentSettings } from "./recent";
import { FIELD } from "./SettingsLayout";
import type { SettingsGroup, SettingsSectionInfo } from "./SettingsPage";

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
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="glass flex min-w-0 flex-col rounded-widget p-4">
      <header className="mb-3 flex items-center gap-2">
        <Icon size={15} className="text-accent-text" aria-hidden />
        <h3 id={titleId} className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-fg">
          {title}
        </h3>
        {more && (
          <button type="button" aria-label={`Mehr zu ${title}`} onClick={more} className="flex items-center gap-1 rounded-full px-1.5 text-[11.5px] text-fg-subtle transition-colors hover:text-accent-text">
            Mehr <ArrowRight size={12} aria-hidden />
          </button>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5">{children}</div>
    </section>
  );
}

interface SwitchLineProps {
  label: string;
  hint?: string;
  /** The setting this is, by the name of its row in its section, so a change shows under "Zuletzt geändert". */
  setting: string;
  section: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}

function SwitchLine({ label, hint, setting, section, checked, disabled, onChange }: SwitchLineProps) {
  return (
    <div data-setting={setting} data-setting-section={section} className="flex items-center justify-between gap-3">
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
    <section aria-label="Einrichtung" className="glass rounded-widget p-4">
      <div className="flex items-center gap-4">
        <span className="relative flex size-14 shrink-0 items-center justify-center text-accent-text">
          <svg viewBox="0 0 54 54" className="absolute inset-0 -rotate-90" aria-hidden>
            <circle cx="27" cy="27" r={radius} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth="4" />
            <circle cx="27" cy="27" r={radius} fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeDasharray={round} strokeDashoffset={round * (1 - done / steps.length)} className="transition-[stroke-dashoffset] duration-500" />
          </svg>
          <span className="text-[13px] font-semibold text-fg tabular-nums" aria-label={`${done} von ${steps.length} eingerichtet`}>
            {done}/{steps.length}
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-fg">{done === steps.length ? "NOVA ist startklar" : "Hol mehr aus NOVA heraus"}</h3>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {steps.map((step) => (
              <li key={step.label}>
                <button
                  type="button"
                  onClick={() => onOpen(step.section)}
                  className={cn("flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] transition-colors", step.done ? "bg-success/10 text-success hover:bg-success/15" : "bg-white/[0.06] text-fg hover:bg-white/[0.1]")}
                >
                  {step.done ? <Check size={12} aria-hidden /> : <ArrowRight size={12} className="text-accent-text" aria-hidden />}
                  {step.label}
                  <span className="sr-only">{step.done ? " (erledigt)" : " (offen)"}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** The settings changed last, each one click away from its row. */
function RecentChanges({ sections, onOpen }: { sections: readonly SettingsSectionInfo[]; onOpen: (section: string, setting: string) => void }) {
  const titleId = useId();
  const stored = useRecentSettings((s) => s.recent);
  const clear = useRecentSettings((s) => s.clear);
  // A section that no longer exists has nowhere to jump to.
  const recent = stored.flatMap((entry) => {
    const section = sections.find((s) => s.id === entry.section);
    return section ? [{ ...entry, section }] : [];
  });
  return (
    <section aria-labelledby={titleId} className="glass rounded-widget p-4">
      <header className="flex items-center gap-2">
        <History size={15} className="text-accent-text" aria-hidden />
        <h3 id={titleId} className="min-w-0 flex-1 text-[13.5px] font-semibold text-fg">
          Zuletzt geändert
        </h3>
        {recent.length > 0 && (
          <button type="button" onClick={clear} className="rounded-full px-1.5 text-[11.5px] text-fg-subtle transition-colors hover:text-fg">
            Liste leeren
          </button>
        )}
      </header>
      {recent.length === 0 ? (
        <p className="mt-2 text-[12.5px] leading-relaxed text-fg-muted">Was du änderst, steht danach hier. So findest du es wieder, ohne zu suchen.</p>
      ) : (
        <ul className="mt-3 grid grid-cols-2 gap-1.5">
          {recent.map(({ section, label, at }) => {
            const Icon = section.icon;
            return (
              <li key={`${section.id}:${label}`} className="min-w-0">
                <button type="button" onClick={() => onOpen(section.id, label)} className="group flex w-full items-center gap-2.5 rounded-[14px] border border-line bg-white/[0.02] px-2.5 py-2 text-left transition-colors hover:border-line-strong hover:bg-white/[0.05]">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-[9px] bg-white/[0.05] text-accent-text">
                    <Icon size={13} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-fg">{label}</span>
                    <span className="block truncate text-[11.5px] text-fg-subtle">
                      {section.label} · {ago(at)}
                    </span>
                  </span>
                  <ArrowRight size={13} className="shrink-0 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Every section as a tile, grouped as in the list beside the page. */
function Categories({ groups, onOpen }: { groups: readonly SettingsGroup[]; onOpen: (section: string) => void }) {
  return (
    <nav aria-label="Alle Bereiche" className="glass space-y-4 rounded-widget p-4">
      {groups.map((group) => (
        <div key={group.label}>
          <h3 className="px-0.5 pb-2 text-[10.5px] font-semibold tracking-[0.08em] text-fg-subtle uppercase">{group.label}</h3>
          <ul className="grid grid-cols-3 gap-2">
            {group.sections.map(({ id, label, icon: Icon, hint }) => (
              <li key={id} className="min-w-0">
                <button
                  type="button"
                  onClick={() => onOpen(id)}
                  className="group flex h-full w-full items-start gap-2.5 rounded-[16px] border border-line bg-white/[0.02] p-3 text-left transition-[border-color,background-color,transform] duration-200 ease-nova hover:-translate-y-px hover:border-line-strong hover:bg-white/[0.05] active:translate-y-0 active:scale-[0.99]"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] border border-line bg-white/[0.04] text-accent-text transition-colors group-hover:border-accent/40">
                    <Icon size={15} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-fg">{label}</span>
                    <span className="block text-[11.5px] leading-snug text-fg-subtle">{hint}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

interface SettingsOverviewProps {
  groups: readonly SettingsGroup[];
  /** The search field; its results stand in for the page while something is typed. */
  search: ReactNode;
  searching: boolean;
  onOpen: (section: string, setting?: string | null) => void;
}

/** The first page of Settings: find a setting, see how things stand, and change what people change most right here. */
export function SettingsOverview({ groups, search, searching, onOpen }: SettingsOverviewProps) {
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
      (error: unknown) => notifyError("Das ließ sich nicht ändern", error),
    );
  };
  const finderAction = (action: typeof finderAddAllDrives) =>
    void action().then(
      (next) => client.setQueryData(FINDER_KEY, next),
      (error: unknown) => notifyError("Das ließ sich nicht hinzufügen", error),
    );

  const items = finder?.folders.reduce((sum, folder) => sum + folder.files, 0) ?? 0;
  const folders = finder?.folders.length ?? 0;
  const steps = [
    { label: "Dein Name", done: displayName.trim() !== "", section: "you" },
    { label: "KI verbinden", done: Boolean(agent?.activeProvider), section: "ai" },
    { label: "Stimme wählen", done: Boolean(prefs?.voice) || novaVoice?.state === "ready", section: "assistant-brain" },
    { label: "Hey NOVA", done: Boolean(wake?.prefs.phrase || wake?.prefs.clap), section: "wake" },
    { label: "Ordner freigeben", done: folders > 0, section: "finder" },
  ];
  const trySaying = () => {
    if (prefs) void speak(phrase.trim() || (german ? "Hallo, ich bin NOVA. So klinge ich." : "Hi, I'm NOVA. This is how I sound."), prefs, "test", german);
  };
  const rate = prefs?.speechRate ?? 1;
  // Turning it on is decided in a dialog outside this page, so the change is noted here.
  const setAutoMode = (autoMode: boolean) => {
    updateAgent({ autoMode });
    recordChange("assistant-brain", "Auto-Modus");
  };

  return (
    <div className="space-y-4">
      <h2 className="sr-only">Übersicht</h2>
      {search}
      {!searching && (
        <>
          <SetupCard steps={steps} onOpen={onOpen} />
          <RecentChanges sections={groups.flatMap((group) => group.sections)} onOpen={onOpen} />
          <Categories groups={groups} onOpen={onOpen} />

          <h3 className="px-1 pt-1 text-[10.5px] font-semibold tracking-[0.08em] text-fg-subtle uppercase">Schnell eingestellt</h3>
          <div className="grid grid-cols-2 gap-4">
            <Tile title="NOVA hören" icon={Volume2} more={() => onOpen("assistant-brain")}>
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  trySaying();
                }}
              >
                <input value={phrase} onChange={(event) => setPhrase(event.target.value)} placeholder="Was soll NOVA sagen?" aria-label="Was NOVA sagen soll" className={cn(FIELD, "min-w-0 flex-1")} />
                <Button size="sm" variant="primary" type="submit" disabled={!prefs} icon={<Play size={13} aria-hidden />}>
                  Anhören
                </Button>
              </form>
              <label data-setting="Tempo" data-setting-section="assistant-brain" className="flex items-center gap-2.5 text-[12px] text-fg-muted">
                Tempo
                <input
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.1}
                  value={rate}
                  disabled={!prefs}
                  aria-valuetext={`${rate.toFixed(1)}-fach`}
                  onChange={(event) => updateAgent({ speechRate: Number(event.target.value) })}
                  className="nova-range min-w-0 flex-1"
                  style={{ "--range-fill": `${((rate - 0.5) / 1.5) * 100}%` } as CSSProperties}
                />
                <span className="w-8 text-right text-fg tabular-nums">{rate.toFixed(1)}×</span>
              </label>
              <SwitchLine label="Jede Antwort vorlesen" setting="Antworten vorlesen" section="assistant-brain" checked={prefs?.speakReplies ?? false} disabled={!prefs} onChange={(speakReplies) => updateAgent({ speakReplies })} />
            </Tile>

            <Tile title="NOVA ohne Hände wecken" icon={Ear} more={() => onOpen("wake")}>
              <SwitchLine label="„Hey NOVA“" setting="Mit „Hey NOVA“ wecken" section="wake" checked={wake?.prefs.phrase ?? false} disabled={!wake} onChange={(on) => setWake({ phrase: on })} />
              <SwitchLine label="Doppelklatschen" setting="Mit Doppelklatschen wecken" section="wake" checked={wake?.prefs.clap ?? false} disabled={!wake} onChange={(on) => setWake({ clap: on })} />
              <SwitchLine label="Auch in Spielen" setting="Auch in Spielen" section="wake" checked={wake?.prefs.inGames ?? true} disabled={!wake} onChange={(on) => setWake({ inGames: on })} />
            </Tile>

            <Tile title="NOVA AI" icon={Sparkles} more={() => onOpen("assistant-brain")}>
              <button type="button" onClick={() => onOpen("ai")} className="rounded-[10px] bg-white/[0.04] px-2.5 py-2 text-left transition-colors hover:bg-white/[0.07]">
                <span className="block truncate text-[12.5px] font-medium text-fg">{agent?.activeProvider ?? "Keine KI verbunden"}</span>
                <span className="block truncate text-[11.5px] text-fg-subtle">{agent?.activeModel ?? "Ohne Schlüssel versteht NOVA nur einfache Befehle"}</span>
              </button>
              {/* Flipping the switch may only open the dialog: no change yet. */}
              <div data-no-record>
                <SwitchLine
                  label="Auto-Modus"
                  hint="Handelt, ohne zu fragen, auf eigene Gefahr"
                  setting="Auto-Modus"
                  section="assistant-brain"
                  checked={prefs?.autoMode ?? false}
                  disabled={!prefs}
                  onChange={(on) => (on ? setConfirmingAuto(true) : setAutoMode(false))}
                />
              </div>
            </Tile>

            <Tile title="Deine Dateien" icon={FolderSearch} more={() => onOpen("finder")}>
              <p className="text-[12.5px] text-fg-muted" aria-live="polite">
                {finder?.progress.running
                  ? `Wird indiziert … ${finder.progress.scanned.toLocaleString("de-DE")} geprüft`
                  : items > 0
                    ? `${items.toLocaleString("de-DE")} Einträge in ${folders === 1 ? "einem Ordner" : `${folders} Ordnern`}`
                    : "NOVA durchsucht bisher nur deine Standardordner."}
              </p>
              <div className="mt-auto flex flex-wrap gap-1.5">
                <Button size="sm" variant="secondary" disabled={!desktop} onClick={() => finderAction(finderPickFolder)}>
                  Ordner hinzufügen …
                </Button>
                <Button size="sm" variant="ghost" disabled={!desktop} onClick={() => setConfirmingPc(true)}>
                  Ganzen PC hinzufügen
                </Button>
              </div>
            </Tile>

            <Tile title="Aussehen" icon={Palette} more={() => onOpen("appearance")}>
              <div data-setting="Akzentfarbe" data-setting-section="appearance" role="radiogroup" aria-label="Akzentfarbe" className="flex flex-wrap gap-2">
                {ACCENT_PRESETS.map((preset) => {
                  const selected = accent.kind === "preset" && accent.id === preset.id;
                  const name = accentName({ kind: "preset", id: preset.id });
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={name}
                      title={name}
                      onClick={() => setAccent({ kind: "preset", id: preset.id })}
                      className={cn("flex size-7 items-center justify-center rounded-full transition-transform duration-200 hover:scale-110", selected && "ring-2 ring-fg/80 ring-offset-2 ring-offset-[#151a29]")}
                      style={{ backgroundColor: preset.color }}
                    >
                      {selected && <Check size={13} strokeWidth={2.8} style={{ color: deriveAccentTokens(preset.color).onAccent }} aria-hidden />}
                    </button>
                  );
                })}
              </div>
              <SwitchLine label="Glas-Effekte" setting="Transparenz" section="appearance" checked={transparency} onChange={setTransparency} />
            </Tile>

            <Tile title="Updates" icon={CloudDownload} more={() => onOpen("updates")}>
              <p className="text-[12.5px] text-fg-muted" aria-live="polite">
                Version <span className="font-medium text-fg tabular-nums">{version ?? __NOVA_VERSION__}</span>
                {update.status === "available" && update.info ? ` · ${update.info.version} ist da` : update.status === "upToDate" ? " · aktuell" : ""}
              </p>
              <div className="mt-auto">
                <Button size="sm" variant="secondary" disabled={!desktop || update.status === "checking"} onClick={() => void update.check({ automatic: false })}>
                  {update.status === "checking" ? "Suche …" : "Jetzt prüfen"}
                </Button>
              </div>
            </Tile>
          </div>
        </>
      )}

      <AutoModeDialog open={confirmingAuto} onClose={() => setConfirmingAuto(false)} onConfirm={() => setAutoMode(true)} />
      <WholePcDialog open={confirmingPc} onClose={() => setConfirmingPc(false)} onConfirm={() => finderAction(finderAddAllDrives)} />
    </div>
  );
}
