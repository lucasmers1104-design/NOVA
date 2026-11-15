import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { AudioLines, BrainCircuit, Coins, Download, FolderSearch, History, Play, Plus, RefreshCw, Square, Trash, Volume2 } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { PreviewStage, SegmentedControl, SettingCard, SettingLine, SliderRow } from "@/components/settings-kit";
import { Button, IconButton } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Switch } from "@/components/ui/Switch";
import { PROVIDERS, providerInfo, useModels } from "@/features/ai/api";
import { notifyError, notify } from "@/features/notifications/store";
import { recordChange } from "@/features/settings/recent";
import { FIELD, MoreOptions, SettingsNotice, SettingsSection } from "@/features/settings/SettingsLayout";
import { cn } from "@/lib/cn";
import { isDesktop } from "@/lib/native";
import {
  agentStatus,
  ASSISTANT_STATUS_KEY,
  assistantStatus,
  clearHistory,
  configureAgent,
  finderAddAllDrives,
  finderAddStandardFolders,
  finderPickFolder,
  finderReindex,
  finderRemoveFolder,
  finderSetContent,
  finderStatus,
} from "./api";
import { NovaDot } from "./components/NovaDot";
import { ASSISTANT_EVENTS, type AgentPrefs, type AgentStatus, type AssistantState, DEFAULT_DOT_LOOK, type FinderStatus, type ProviderId } from "./types";
import { useSpeech } from "./speech/api";
import { GEMINI_VOICES, OnlineVoiceKeyRow, serviceOf, useOnlineVoices } from "./OnlineVoiceSettings";
import { installNovaVoice, isOnlineVoice, NOVA_VOICE, type NovaVoiceStatus, speak, stopSpeaking, useVoice, voices, watchNovaVoice } from "./voice";

const AGENT_KEY = ["assistant", "agent"] as const;
const FINDER_KEY = ["assistant", "finder"] as const;

const EFFORTS = [
  { value: "low", label: "Schnell" },
  { value: "medium", label: "Ausgewogen" },
  { value: "high", label: "Gründlich" },
] as const satisfies readonly { value: AgentPrefs["effort"]; label: string }[];

const LANGUAGES = [
  { value: "auto", label: "Wie Windows" },
  { value: "de-DE", label: "Deutsch (Deutschland)" },
  { value: "de-AT", label: "Deutsch (Österreich)" },
  { value: "de-CH", label: "Deutsch (Schweiz)" },
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
];

// Wide enough for the longest choice ("Automatisch (Thorsten für Deutsch, sonst Windows)"):
// a select cuts its text off without a word, and then the choice can't be read.
const SELECT = cn(FIELD, "max-w-[22rem]");

const TITLE = "Modell & Stimme";

export function useAgent() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: AGENT_KEY, queryFn: agentStatus, enabled: isDesktop() });
  useEffect(() => {
    if (!isDesktop()) return;
    const unlisten = listen<AgentStatus>(ASSISTANT_EVENTS.agent, (event) => client.setQueryData(AGENT_KEY, event.payload));
    return () => void unlisten.then((stop) => stop());
  }, [client]);
  const save = useMutation({
    mutationFn: configureAgent,
    onSuccess: (next) => client.setQueryData(AGENT_KEY, next),
    onError: (error) => notifyError("Die Einstellungen von NOVA AI ließen sich nicht speichern", error),
  });
  const update = (patch: Partial<AgentPrefs>) => {
    const current = query.data?.prefs;
    if (current) save.mutate({ ...current, ...patch });
  };
  return { status: query.data, update, saving: save.isPending };
}

interface AskProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

/** Asked before auto mode goes on, wherever Settings offers the switch. */
export function AutoModeDialog({ open, onClose, onConfirm }: AskProps) {
  return (
    <ConfirmDialog
      open={open}
      title="Auto-Modus einschalten?"
      description="NOVA tut dann alles, ohne zu fragen: Dateien löschen, Programme beenden, Fenster schließen, Tasten drücken und in anderen Apps klicken, deinen Bildschirm lesen. Ein falsch verstandener Satz oder ein Trick auf einer Webseite, die es liest, kann echten Schaden anrichten, und nichts hält es vorher auf. Du nutzt das auf eigene Gefahr."
      confirmLabel="Auf eigene Gefahr einschalten"
      cancelLabel="Abbrechen"
      danger
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}

/** Asked before NOVA Finder takes in every drive. */
export function WholePcDialog({ open, onClose, onConfirm }: AskProps) {
  return (
    <ConfirmDialog
      open={open}
      title="Den ganzen PC zu NOVA Finder hinzufügen?"
      description="NOVA indiziert im Hintergrund die Dateinamen auf allen Laufwerken und kann dann mit den Dateien dort arbeiten; bevor es etwas ändert, fragt es weiterhin. Windows, installierte Programme und App-Daten bleiben tabu. Der Index bleibt auf diesem PC."
      confirmLabel="Ganzen PC hinzufügen"
      cancelLabel="Abbrechen"
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}

const multiple = (value: number) => `${value.toFixed(1)}×`;
const percentOf = (value: number) => `${Math.round(value * 100)} %`;

/** Settings → Modell & Stimme. */
export function AgentSettings() {
  const { status, update, saving } = useAgent();
  const limitId = useId();
  const voiceId = useId();
  const providerId = useId();
  const languageId = useId();
  const [limitDraft, setLimitDraft] = useState<string | null>(null);
  const [voiceList, setVoiceList] = useState<SpeechSynthesisVoice[]>(() => voices());
  const novaVoice = useVoice((s) => s.novaVoice);
  const onlineProblem = useVoice((s) => s.onlineVoiceProblem);
  const online = useOnlineVoices();
  const [confirmingAuto, setConfirmingAuto] = useState(false);
  const speech = useSpeech();
  // NOVA's own voices that are downloaded (Thorsten is always offered: it downloads itself).
  const novaVoices = (speech.status?.items ?? []).filter((i) => i.kind === "voice" && i.id !== "thorsten" && i.install.state === "ready");

  useEffect(() => (isDesktop() ? watchNovaVoice() : undefined), []);

  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const refresh = () => setVoiceList(voices());
    speechSynthesis.addEventListener("voiceschanged", refresh);
    refresh();
    return () => speechSynthesis.removeEventListener("voiceschanged", refresh);
  }, []);

  if (!isDesktop()) {
    return (
      <SettingsSection id="assistant-brain" title={TITLE} description="Welche KI antwortet und wie NOVA spricht." icon={AudioLines}>
        <SettingsNotice>Das gibt es in der NOVA-Desktop-App.</SettingsNotice>
      </SettingsSection>
    );
  }

  const prefs = status?.prefs;
  const configured = PROVIDERS.filter((p) => status?.keys[p.id]);
  const chosen: ProviderId | null = prefs?.provider ?? null;
  const usage = status?.usageThisMonth;
  const spent = (usage?.costMicros ?? 0) / 1_000_000;
  // Turning it on is decided in a dialog outside this page, so the change is noted here.
  const setAutoMode = (autoMode: boolean) => {
    update({ autoMode });
    recordChange("assistant-brain", "Auto-Modus");
  };
  // German for NOVA's own voices and German Windows voices, else for a German system.
  const germanVoice = prefs ? prefs.voice.startsWith("nova:") || /^de/i.test(voiceList.find((v) => v.name === prefs.voice)?.lang ?? navigator.language) : false;

  return (
    <SettingsSection id="assistant-brain" title={TITLE} description="Welche KI NOVA AI antworten lässt, was sie kosten darf und wie NOVA klingt." icon={AudioLines}>
      {prefs && <VoiceStage prefs={prefs} german={germanVoice} name={voiceName(prefs.voice, novaVoices, online.elevenlabs)} />}

      <SettingCard title="Stimme" description="Wähl eine Stimme und hör sie dir oben an. Tempo und Lautstärke gelten sofort." icon={Volume2}>
        <SettingLine label="Stimme" htmlFor={voiceId} description={onlineProblem && isOnlineVoice(prefs?.voice ?? "") ? `Die Online-Stimme hat nicht funktioniert, deshalb ist eine andere eingesprungen: ${onlineProblem}` : voiceDescription(prefs?.voice ?? "", novaVoice)}>
          <div className="flex items-center gap-1.5">
            <select id={voiceId} className={SELECT} disabled={!prefs} value={prefs?.voice ?? ""} onChange={(event) => update({ voice: event.target.value })}>
              <option value="">Automatisch (Thorsten für Deutsch, sonst Windows)</option>
              <option value={NOVA_VOICE}>Thorsten, NOVAs natürliche Stimme</option>
              {novaVoices.map((v) => (
                <option key={v.id} value={`nova:${v.id}`}>
                  {v.label}, NOVA-Stimme{v.experimental ? " (experimentell)" : ""}
                </option>
              ))}
              <optgroup label="Online: Google Gemini (kostenlos, am natürlichsten)">
                {GEMINI_VOICES.map((v) => (
                  <option key={v.id} value={`online:gemini:${v.id}`}>
                    {v.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Online: ElevenLabs (Freikontingent)">
                {online.elevenlabs.map((v) => (
                  <option key={v.id} value={`online:elevenlabs:${v.id}`}>
                    {v.name}
                  </option>
                ))}
              </optgroup>
              {/* A voice from an account list that can't be read right now stays selectable. */}
              {prefs?.voice.startsWith("online:elevenlabs:") && !online.elevenlabs.some((v) => prefs.voice.endsWith(`:${v.id}`)) && <option value={prefs.voice}>ElevenLabs-Stimme</option>}
              {voiceList.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
            {(prefs?.voice === "" || prefs?.voice.startsWith("nova:")) && (novaVoice?.state === "missing" || novaVoice?.state === "failed") && (
              <Button size="sm" variant="ghost" icon={<Download size={13} aria-hidden />} onClick={() => void installNovaVoice()}>
                {novaVoice.state === "failed" ? "Noch mal" : "Laden"}
              </Button>
            )}
          </div>
        </SettingLine>
        {prefs && isOnlineVoice(prefs.voice) && <OnlineVoiceKeyRow service={serviceOf(prefs.voice)} />}
        <SliderRow label="Tempo" value={prefs?.speechRate ?? 1} min={0.5} max={2} step={0.1} defaultValue={1} format={multiple} disabled={!prefs} onChange={(speechRate) => update({ speechRate })} />
        <SliderRow label="Lautstärke" value={prefs?.speechVolume ?? 1} min={0} max={1} step={0.05} defaultValue={1} format={percentOf} disabled={!prefs} onChange={(speechVolume) => update({ speechVolume })} />
        <SettingLine label="Antworten vorlesen" description="NOVA liest seine Antworten vor. Auf Gesprochenes antwortet es immer mit der Stimme.">
          <Switch label="Antworten vorlesen" checked={prefs?.speakReplies ?? false} disabled={!prefs} onChange={(speakReplies) => update({ speakReplies })} />
        </SettingLine>
        <SettingLine label="Weiter zuhören" description="Nach einer gesprochenen Antwort öffnet sich das Mikrofon wieder, und du redest einfach weiter. Sagst du nichts, schließt es sich von selbst.">
          <Switch label="Weiter zuhören" checked={prefs?.keepListening ?? true} disabled={!prefs} onChange={(keepListening) => update({ keepListening })} />
        </SettingLine>
      </SettingCard>

      <SettingCard title="KI" description="Wer antwortet, und wie viel NOVA von sich aus tun darf." icon={BrainCircuit}>
        <SettingLine
          label="KI-Anbieter"
          htmlFor={providerId}
          description={
            status?.activeProvider
              ? `Antwortet gerade: ${status.activeProvider} · ${status.activeModel}`
              : configured.length === 0
                ? "Kein Anbieter verbunden. NOVA AI versteht dann nur lokale Befehle (Dateien finden, Apps öffnen). Hinterleg einen Schlüssel unter KI-Anbieter."
                : "Wähl unter „Modelle, Kostenlimit und Sprache“ ein Modell für diesen Anbieter."
          }
        >
          <select id={providerId} className={SELECT} disabled={!prefs || saving} value={chosen ?? "auto"} onChange={(event) => update({ provider: event.target.value === "auto" ? null : (event.target.value as ProviderId) })}>
            <option value="auto">Automatisch (der erste verbundene)</option>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id} disabled={!status?.keys[p.id]}>
                {p.name}
                {status?.keys[p.id] ? "" : " (kein Schlüssel)"}
              </option>
            ))}
          </select>
        </SettingLine>
        {/* Flipping the switch may only open the dialog: no change yet. */}
        <div data-no-record>
          <SettingLine
            label="Auto-Modus"
            description={prefs?.autoMode ? "An, auf deine Gefahr: NOVA handelt, ohne vorher zu fragen. Alles, was es tut, steht im Aktionsverlauf." : "NOVA handelt, ohne dich vorher zu fragen, auch wenn es Dateien löscht oder Programme beendet. Auf deine Gefahr."}
          >
            <Switch label="Auto-Modus" checked={prefs?.autoMode ?? false} disabled={!prefs} onChange={(on) => (on ? setConfirmingAuto(true) : setAutoMode(false))} />
          </SettingLine>
        </div>
      </SettingCard>
      <AutoModeDialog open={confirmingAuto} onClose={() => setConfirmingAuto(false)} onConfirm={() => setAutoMode(true)} />

      <MoreOptions title="Modelle, Kostenlimit und Sprache" description="Welches Modell je Anbieter, wie gründlich es denkt und was ein Monat kosten darf." icon={Coins}>
        {PROVIDERS.filter((p) => status?.keys[p.id] || p.id === "anthropic").map((p) => (
          <ModelRow
            key={p.id}
            provider={p.id}
            name={p.name}
            hasKey={status?.keys[p.id] ?? false}
            value={prefs?.models[p.id] ?? ""}
            disabled={!prefs || saving}
            onChange={(model) => {
              const models = { ...prefs?.models };
              if (model) models[p.id] = model;
              else delete models[p.id];
              update({ models });
            }}
          />
        ))}
        <SettingLine label="Gründlichkeit" description="„Schnell“ antwortet früher, „Gründlich“ denkt bei schweren Bitten länger nach (Claude-Modelle).">
          <SegmentedControl label="Gründlichkeit" value={prefs?.effort ?? "medium"} options={EFFORTS} onChange={(effort) => update({ effort })} />
        </SettingLine>
        <SettingLine
          label="Monatslimit"
          htmlFor={limitId}
          description={
            <>
              Diesen Monat: {usage?.requests ?? 0} Anfragen · {((usage?.inputTokens ?? 0) / 1000).toFixed(1)}k rein · {((usage?.outputTokens ?? 0) / 1000).toFixed(1)}k raus
              {spent > 0 && ` · ≈ ${spent.toFixed(2)} $`}
              {(usage?.unpricedRequests ?? 0) > 0 && ` · ${usage?.unpricedRequests} ohne Preisschätzung (sie zählen nicht zum Limit)`}. Die Kosten sind Schätzungen für Claude-Modelle, nur die deckt das Limit ab. Verbindlich ist die Rechnung deines Anbieters.
            </>
          }
        >
          <div className="flex items-center gap-1.5">
            <input
              id={limitId}
              inputMode="decimal"
              placeholder="Kein Limit"
              value={limitDraft ?? (prefs?.monthlyLimitUsd != null ? String(prefs.monthlyLimitUsd) : "")}
              onChange={(event) => setLimitDraft(event.target.value)}
              onBlur={() => {
                if (limitDraft === null) return;
                const value = limitDraft.trim().replace(",", ".");
                const limit = value === "" ? null : Number(value);
                setLimitDraft(null);
                if (limit === null || (Number.isFinite(limit) && limit >= 0)) update({ monthlyLimitUsd: limit });
                else notify("Gib einen positiven Betrag ein, oder lass das Feld leer für kein Limit", { kind: "warning" });
              }}
              className={cn(FIELD, "w-24")}
            />
            <span className="text-[13px] text-fg-muted">$</span>
          </div>
        </SettingLine>
        <SettingLine
          label="Sprache der Spracherkennung"
          htmlFor={languageId}
          description="Die Windows-Spracherkennung braucht dafür womöglich „Online-Spracherkennung“ unter Windows-Einstellungen → Datenschutz → Spracherkennung. NOVAs Offline-Erkennung (Sprache auf diesem PC) versteht Deutsch und Englisch von selbst."
        >
          <select id={languageId} className={SELECT} disabled={!prefs} value={prefs?.language ?? "auto"} onChange={(event) => update({ language: event.target.value })}>
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </SettingLine>
      </MoreOptions>
    </SettingsSection>
  );
}

/** What the chosen voice is called on the stage. */
function voiceName(voice: string, novaVoices: readonly { id: string; label: string }[], elevenlabs: readonly { id: string; name: string }[]): string {
  if (voice === "") return "Automatisch";
  if (voice === NOVA_VOICE) return "Thorsten";
  if (voice.startsWith("nova:")) return novaVoices.find((v) => `nova:${v.id}` === voice)?.label ?? "NOVA-Stimme";
  if (voice.startsWith("online:gemini:")) return GEMINI_VOICES.find((v) => voice.endsWith(`:${v.id}`))?.name ?? "Google Gemini";
  if (voice.startsWith("online:elevenlabs:")) return elevenlabs.find((v) => voice.endsWith(`:${v.id}`))?.name ?? "ElevenLabs";
  return voice;
}

interface VoiceStageProps {
  prefs: AgentPrefs;
  /** The sample sentence is German. */
  german: boolean;
  name: string;
}

/**
 * NOVA's voice, to listen to: the dot (in the look it has on the desktop) thinks
 * while the voice is being made and follows it while it speaks, with the real level.
 */
function VoiceStage({ prefs, german, name }: VoiceStageProps) {
  const { data: assistant } = useQuery({ queryKey: ASSISTANT_STATUS_KEY, queryFn: assistantStatus });
  const speaking = useVoice((s) => s.mode === "speaking");
  const level = useVoice((s) => s.level);
  // From the click until the first sound: the voice is being made.
  const [preparing, setPreparing] = useState(false);
  const [phrase, setPhrase] = useState("");
  const state: AssistantState = speaking ? "speaking" : preparing ? "thinking" : "idle";

  // Leaving the page ends the sample.
  useEffect(() => () => stopSpeaking(), []);

  const audition = (event: FormEvent) => {
    event.preventDefault();
    if (speaking || preparing) {
      stopSpeaking();
      setPreparing(false);
      return;
    }
    setPreparing(true);
    void speak(phrase.trim() || (german ? "Hallo, ich bin NOVA. So klinge ich." : "Hi, I'm NOVA. This is how I sound."), prefs, "test", german).finally(() => setPreparing(false));
  };

  return (
    <PreviewStage label="Probe: so klingt NOVA" backdrop="dusk" height={212}>
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6">
        {/* A picture of the dot at work: nothing to click, so it is no stop for the keyboard. */}
        <div inert className="flex">
          <NovaDot look={{ ...(assistant?.look ?? DEFAULT_DOT_LOOK), diameter: 56, idleOpacity: 100, activity: true }} open={false} state={state} level={level} onToggle={() => {}} onMenu={() => {}} onDragStart={() => {}} />
        </div>
        <p className="text-[12.5px] text-white/75" role="status">
          {speaking ? `${name} spricht …` : preparing ? `${name} holt Luft …` : name}
        </p>
        <form onSubmit={audition} className="flex w-full max-w-md items-center gap-2">
          <input value={phrase} onChange={(event) => setPhrase(event.target.value)} placeholder="Was soll NOVA sagen?" aria-label="Was NOVA sagen soll" maxLength={200} className={cn(FIELD, "min-w-0 flex-1 backdrop-blur-md")} />
          <Button size="sm" variant="primary" type="submit" icon={speaking || preparing ? <Square size={11} aria-hidden /> : <Play size={13} aria-hidden />}>
            {speaking || preparing ? "Stopp" : "Anhören"}
          </Button>
        </form>
      </div>
    </PreviewStage>
  );
}

/** What the voice row says about the chosen voice and NOVA's own voice. */
export function voiceDescription(voice: string, nova: NovaVoiceStatus | null): string {
  if (isOnlineVoice(voice)) return "Eine Online-Stimme: sehr natürlich, braucht das Internet und einen Schlüssel. Fällt sie aus oder ist das Freikontingent verbraucht, springt NOVAs eigene Stimme ein.";
  if (voice.startsWith("nova:") && voice !== NOVA_VOICE && nova?.state === "ready") return "Eine von NOVAs eigenen Stimmen. Sie läuft auf diesem PC (siehe Sprache auf diesem PC).";
  if (voice !== "" && !voice.startsWith("nova:")) return "Eine Windows-Stimme, die auf diesem PC installiert ist.";
  switch (nova?.state) {
    case "downloading":
      return `Thorsten wird geladen (etwa 85 MB, einmalig) … ${nova.percent} %. Bis dahin spricht NOVA mit einer Windows-Stimme.`;
    case "failed":
      return `${nova.message}. NOVA spricht solange mit einer Windows-Stimme.`;
    case "missing":
      return "Thorsten klingt natürlich und läuft auf diesem PC. Die Stimme wird einmal geladen (etwa 85 MB); bis dahin spricht NOVA mit einer Windows-Stimme.";
    default:
      return "Thorsten klingt natürlich und läuft auf diesem PC, ganz ohne Internet.";
  }
}

function ModelRow({ provider, name, hasKey, value, disabled, onChange }: { provider: ProviderId; name: string; hasKey: boolean; value: string; disabled: boolean; onChange: (model: string) => void }) {
  const { data: models, isLoading, error } = useModels(provider, hasKey);
  const id = useId();
  // Without a key the suggested models are offered, so the choice can be made up front.
  const list = models ?? providerInfo(provider).suggestedModels.map((model) => ({ id: model, name: model }));
  return (
    <SettingLine label={`Modell für ${name}`} htmlFor={id} description={error ? `Die Modelle ließen sich nicht laden: ${error instanceof Error ? error.message : String(error)}` : value ? undefined : "Folgt dem Modell, das im Tab NOVA AI gewählt ist."}>
      <select id={id} className={SELECT} disabled={disabled || isLoading} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Wie im Tab NOVA AI</option>
        {value && !list.some((m) => m.id === value) && <option value={value}>{value}</option>}
        {list.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    </SettingLine>
  );
}

/** Settings → NOVA Finder. */
export function FinderSettings() {
  const client = useQueryClient();
  const desktop = isDesktop();
  const { data: status } = useQuery({ queryKey: FINDER_KEY, queryFn: finderStatus, enabled: desktop });
  const set = (next: FinderStatus) => client.setQueryData(FINDER_KEY, next);
  const run = (action: () => Promise<FinderStatus>, failure: string) => void action().then(set, (error: unknown) => notifyError(failure, error));

  useEffect(() => {
    if (!desktop) return;
    const unlisten = listen(ASSISTANT_EVENTS.finder, () => void client.invalidateQueries({ queryKey: FINDER_KEY }));
    return () => void unlisten.then((stop) => stop());
  }, [client, desktop]);

  const [confirmingPc, setConfirmingPc] = useState(false);
  const progress = status?.progress;
  const total = status?.folders.reduce((sum, folder) => sum + folder.files, 0) ?? 0;
  const count = (value: number) => value.toLocaleString("de-DE");
  return (
    <SettingsSection id="finder" title="NOVA Finder" description="Die Ordner, die NOVA AI durchsucht. Der Index bleibt auf diesem PC, und nichts wird indiziert, bis du einen Ordner hinzufügst." icon={FolderSearch}>
      {!desktop ? (
        <SettingsNotice>Das gibt es in der NOVA-Desktop-App.</SettingsNotice>
      ) : (
        <>
          <SettingCard
            title="Ordner"
            description="Hier sucht NOVA, wenn du nach einer Datei fragst."
            icon={FolderSearch}
            actions={
              (status?.folders.length ?? 0) > 0 && (
                <Button size="sm" variant="ghost" icon={<RefreshCw size={13} aria-hidden />} disabled={progress?.running} onClick={() => run(finderReindex, "Das Indizieren ließ sich nicht starten")}>
                  Index auffrischen
                </Button>
              )
            }
          >
            <div data-setting="Ordner für NOVA Finder">
              {status?.folders.length === 0 && <p className="rounded-[14px] border border-dashed border-line-strong px-3 py-4 text-center text-[12.5px] text-fg-muted">Noch keine Ordner. NOVA sucht nur nach Dateinamen in deinen Standardordnern.</p>}
              <ul className="space-y-1.5">
                {status?.folders.map((folder) => (
                  <li key={folder.path} className="flex items-center gap-3 rounded-[14px] border border-line bg-white/[0.02] px-3 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-fg">{folder.path}</span>
                      <span className={cn("text-[11.5px]", folder.exists ? "text-fg-subtle" : "text-warning")}>{folder.exists ? `${count(folder.files)} Einträge im Index` : "Ordner nicht gefunden"}</span>
                    </span>
                    <IconButton label={`${folder.path} nicht mehr durchsuchen`} size="sm" data-records onClick={() => run(() => finderRemoveFolder(folder.path), "Der Ordner ließ sich nicht entfernen")}>
                      <Trash size={14} aria-hidden />
                    </IconButton>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" icon={<Plus size={14} aria-hidden />} data-records onClick={() => run(finderPickFolder, "Der Ordner ließ sich nicht hinzufügen")}>
                  Ordner hinzufügen …
                </Button>
                <Button size="sm" variant="ghost" data-records onClick={() => run(finderAddStandardFolders, "Die Ordner ließen sich nicht hinzufügen")}>
                  Dokumente, Desktop, Downloads & mehr
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmingPc(true)}>
                  Ganzen PC hinzufügen
                </Button>
              </div>
              <p className="mt-2.5 text-[12px] text-fg-muted" aria-live="polite">
                {progress?.running
                  ? `Wird indiziert … ${count(progress.scanned)} Einträge geprüft${progress.current ? ` in ${progress.current}` : ""}`
                  : progress?.error
                    ? `Das letzte Indizieren ist fehlgeschlagen: ${progress.error}`
                    : total > 0
                      ? `${count(total)} Einträge im Index${progress?.lastFinished ? ` · Stand ${new Date(progress.lastFinished).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}` : ""}. NOVA frischt den Index im Hintergrund auf.`
                      : null}
              </p>
            </div>
          </SettingCard>
          <WholePcDialog
            open={confirmingPc}
            onClose={() => setConfirmingPc(false)}
            onConfirm={() => {
              run(finderAddAllDrives, "Die Laufwerke ließen sich nicht hinzufügen");
              recordChange("finder", "Ordner für NOVA Finder");
            }}
          />
          <SettingCard title="Inhalt">
            <SettingLine label="In Textdateien suchen" description="Nimmt auch den Anfang von Textdateien (.txt, .md, .csv, Code …) in den Index, damit NOVA sie über ihren Inhalt findet. Ausschalten löscht den gespeicherten Text.">
              <Switch label="In Textdateien suchen" checked={status?.content ?? true} disabled={!status} onChange={(enabled) => run(() => finderSetContent(enabled), "Das ließ sich nicht ändern")} />
            </SettingLine>
          </SettingCard>
        </>
      )}
    </SettingsSection>
  );
}

/** Clears NOVA AI's action log and usage records. */
export function AssistantHistoryCard() {
  const [confirming, setConfirming] = useState(false);
  const client = useQueryClient();
  if (!isDesktop()) return null;
  return (
    <>
      <SettingCard title="Verlauf von NOVA AI" icon={History}>
        <SettingLine label="Aktionsverlauf und Nutzung" description="NOVA AI hält lokal fest, was es getan hat (Suchen, Geöffnetes, Dokumente, Dateiänderungen, Screenshots), und wie viele Tokens es verbraucht hat. Unterhaltungen werden nie gespeichert.">
          <Button size="sm" variant="secondary" icon={<History size={14} aria-hidden />} onClick={() => setConfirming(true)}>
            Löschen …
          </Button>
        </SettingLine>
      </SettingCard>
      <ConfirmDialog
        open={confirming}
        title="Verlauf von NOVA AI löschen?"
        description="Löscht den Aktionsverlauf und die Nutzungsdaten auf diesem PC. Das lässt sich nicht rückgängig machen."
        confirmLabel="Verlauf löschen"
        cancelLabel="Abbrechen"
        danger
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void clearHistory().then(
            () => {
              void client.invalidateQueries({ queryKey: AGENT_KEY });
              notify("Verlauf von NOVA AI gelöscht", { kind: "success" });
            },
            (error: unknown) => notifyError("Der Verlauf ließ sich nicht löschen", error),
          );
        }}
      />
    </>
  );
}
