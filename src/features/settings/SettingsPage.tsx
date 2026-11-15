import { useQuery } from "@tanstack/react-query";
import { getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { Activity, AudioLines, Check, Clapperboard, Clock, CloudDownload, Cpu, Database, Ear, FolderSearch, Gauge, Globe, Info, Keyboard, KeyRound, LayoutDashboard, Layers, type LucideIcon, MemoryStick, Palette, PanelLeft, Plug, Power, ShieldCheck, Sparkles, TriangleAlert, UserRound } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { type Shortcut, SHORTCUTS } from "@/app/shortcuts";
import { NovaMark } from "@/components/brand/NovaMark";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { ResetButton, SegmentedControl, SettingCard, SettingLine } from "@/components/settings-kit";
import { Kbd } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { FOCUSABLE } from "@/components/ui/Dialog";
import { Switch } from "@/components/ui/Switch";
import { AgentSettings, AssistantHistoryCard, FinderSettings } from "@/features/nova-assistant/AgentSettings";
import { SpeechSettings } from "@/features/nova-assistant/SpeechSettings";
import { AssistantSettings } from "@/features/nova-assistant/AssistantSettings";
import { WakeSettings } from "@/features/nova-assistant/WakeSettings";
import { useSystemInfo } from "@/features/system/api";
import { TelemetrySettings } from "@/features/telemetry/TelemetrySettings";
import { useTour } from "@/features/tour/store";
import { showWhatsNew } from "@/features/updates/WhatsNew";
import { cn } from "@/lib/cn";
import { callNative, isDesktop } from "@/lib/native";
import { useStorageHealth } from "@/lib/persistence";
import { greetingFor } from "@/lib/time";
import { REFRESH_INTERVALS_MS, type TitleBarClock, useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { AppearanceSettings } from "./AppearanceSettings";
import { DevKeyCard } from "./DevKeyCard";
import { GamesSettings } from "./GamesSettings";
import { AiProviderSettings, IntegrationsSettings, ProfilesSettings, StartupSettings, UpdatesSettings, useExternalConnections } from "./ExtraSettings";
import { NavigationSettings } from "./NavigationSettings";
import { PerformanceSettings } from "./PerformanceSettings";
import { useRecordChanges } from "./recent";
import { FIELD, REVEAL_SETTINGS_EVENT, SettingsSection } from "./SettingsLayout";
import { SettingsOverview } from "./SettingsOverview";
import { SettingsSearch } from "./SettingsSearch";

export interface SettingsSectionInfo {
  id: string;
  label: string;
  icon: LucideIcon;
  /** What is in there, in a few words, for the tiles on the Settings home. */
  hint: string;
}

export interface SettingsGroup {
  label: string;
  sections: readonly SettingsSectionInfo[];
}

const GROUPS: readonly SettingsGroup[] = [
  {
    label: "Du",
    sections: [
      { id: "you", label: "Dein Name", icon: UserRound, hint: "Wie NOVA dich nennt" },
      { id: "appearance", label: "Darstellung", icon: Palette, hint: "Akzent, Hintergrund, Glas, Bewegung" },
      { id: "profiles", label: "Profile", icon: Layers, hint: "Layout und Look auf einmal wechseln" },
      { id: "navigation", label: "Navigation", icon: PanelLeft, hint: "Seitenleiste ordnen und ausblenden" },
      { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, hint: "Uhrzeit auf Home und in der Titelleiste" },
    ],
  },
  {
    label: "NOVA AI",
    sections: [
      { id: "assistant-brain", label: "Modell & Stimme", icon: AudioLines, hint: "Welche KI antwortet und wie sie klingt" },
      { id: "wake", label: "Hey NOVA & Klatschen", icon: Ear, hint: "NOVA ohne Hände wecken" },
      { id: "games", label: "Spiele & Clips", icon: Clapperboard, hint: "„Clip das“ und deine Clips" },
      { id: "assistant", label: "Der NOVA-Punkt", icon: Sparkles, hint: "Aussehen, Platz und Tastenkürzel" },
      { id: "finder", label: "NOVA Finder", icon: FolderSearch, hint: "Welche Ordner NOVA durchsucht" },
      { id: "ai", label: "KI-Anbieter", icon: KeyRound, hint: "API-Schlüssel für Claude, GPT und Gemini" },
      { id: "local-ai", label: "Sprache auf diesem PC", icon: Cpu, hint: "Eigene Stimmen, Offline-Erkennung, Tempo" },
    ],
  },
  {
    label: "Dieser PC",
    sections: [
      { id: "startup", label: "Start", icon: Power, hint: "Autostart, Infobereich, Benachrichtigungen" },
      { id: "updates", label: "Updates", icon: CloudDownload, hint: "Version und automatische Updates" },
      { id: "integrations", label: "Integrationen", icon: Plug, hint: "Wetter, Nachrichten, Kalender" },
      { id: "system", label: "System", icon: Activity, hint: "Wie oft Live-Werte neu gelesen werden" },
      { id: "performance", label: "Leistung", icon: MemoryStick, hint: "Arbeitsspeicher messen und freigeben" },
      { id: "shortcuts", label: "Tastenkürzel", icon: Keyboard, hint: "Was überall in NOVA funktioniert" },
    ],
  },
  {
    label: "NOVA",
    sections: [
      { id: "privacy", label: "Datenschutz", icon: ShieldCheck, hint: "Was auf dem PC bleibt und was nicht" },
      { id: "about", label: "Über NOVA", icon: Info, hint: "Version, Einführung, Zurücksetzen" },
    ],
  },
];

/**
 * What the search finds: each setting by the name its row shows (`data-setting`), with
 * the words people may use instead, in German and in English (the labels used to be English).
 */
export const SEARCHABLE: readonly { label: string; section: string; words?: string }[] = [
  { label: "Dein Name", section: "you", words: "name heißen nennen anrede your name" },
  { label: "Einführung", section: "about", words: "tour start the tour tutorial hilfe help" },
  { label: "Akzentfarbe", section: "appearance", words: "farbe akzent accent color colour" },
  { label: "Hintergrund", section: "appearance", words: "background verlauf gradient bild picture png wallpaper" },
  { label: "Windows-Hintergrundbild zeigen", section: "appearance", words: "wallpaper backdrop desktop hintergrundbild" },
  { label: "Transparenz", section: "appearance", words: "transparency effects glas glass milchglas" },
  { label: "Glasstärke", section: "appearance", words: "glass strength glas deckkraft opacity" },
  { label: "Glasfarbe", section: "appearance", words: "glass color glas tönung tint" },
  { label: "Ecken", section: "appearance", words: "corners rund radius kantig" },
  { label: "Schrift", section: "appearance", words: "font schriftart inter segoe" },
  { label: "Bewegung", section: "appearance", words: "motion animation reduziert reduced" },
  { label: "Profile", section: "profiles", words: "workspace profiles profil arbeitsprofil" },
  { label: "Bereiche der Seitenleiste", section: "navigation", words: "sidebar sections seitenleiste menü reihenfolge sortieren ausblenden" },
  { label: "24-Stunden-Uhr", section: "dashboard", words: "24-hour clock uhr zeit" },
  { label: "Uhr in der Titelleiste", section: "dashboard", words: "title bar clock uhr zeit datum" },
  { label: "KI-Anbieter", section: "assistant-brain", words: "ai provider ki anbieter claude gemini openai" },
  { label: "Gründlichkeit", section: "assistant-brain", words: "thoroughness effort schnell gründlich" },
  { label: "Monatslimit", section: "assistant-brain", words: "monthly limit kosten geld budget" },
  { label: "Antworten vorlesen", section: "assistant-brain", words: "spoken replies vorlesen sprechen" },
  { label: "Weiter zuhören", section: "assistant-brain", words: "keep listening mikrofon mikro weiterhören" },
  { label: "Auto-Modus", section: "assistant-brain", words: "auto mode modus automatisch ohne fragen" },
  { label: "Stimme", section: "assistant-brain", words: "voice thorsten gemini elevenlabs probehören klang" },
  { label: "Tempo", section: "assistant-brain", words: "speed geschwindigkeit sprechtempo" },
  { label: "Lautstärke", section: "assistant-brain", words: "volume laut leise" },
  { label: "Sprache der Spracherkennung", section: "assistant-brain", words: "speech recognition language sprache deutsch englisch" },
  { label: "Mit „Hey NOVA“ wecken", section: "wake", words: "hey nova aufwecken wake mikrofon" },
  { label: "Wie sicher NOVA sein muss", section: "wake", words: "how sure empfindlichkeit versteht sensitivity" },
  { label: "Mit Doppelklatschen wecken", section: "wake", words: "double clap klatschen" },
  { label: "Klatsch-Erkennung", section: "wake", words: "clap detection klatschen empfindlichkeit" },
  { label: "Nach dem Wecken", section: "wake", words: "after waking zuhören öffnen" },
  { label: "Ton beim Wecken", section: "wake", words: "sound chime ton klang" },
  { label: "Auch in Spielen", section: "wake", words: "also in games spiele fortnite vollbild" },
  { label: "Clip das!", section: "games", words: "clip clips aufnahme aufnehmen video replay spiele gaming ffmpeg" },
  { label: "Deine Clips", section: "games", words: "your clips ordner videos folder" },
  { label: "Discord", section: "games", words: "discord jungs schicken teilen webhook relay bot kanal" },
  { label: "NOVA-Punkt anzeigen", section: "assistant", words: "show the nova dot punkt taskleiste" },
  { label: "Wo er sitzt", section: "assistant", words: "where it sits punkt position ecke taskleiste corner" },
  { label: "Tastenkürzel", section: "assistant", words: "keyboard shortcut hotkey tasten strg alt punkt nova ai öffnen" },
  { label: "Stil", section: "assistant", words: "punkt style glas orb ring flach aussehen look" },
  { label: "In Textdateien suchen", section: "finder", words: "search inside text files suche inhalt dateien" },
  { label: "Ordner für NOVA Finder", section: "finder", words: "folders ordner dateien pfad zugriff ganzer pc festplatte" },
  { label: "API-Schlüssel", section: "ai", words: "api keys key anthropic openai gemini claude" },
  { label: "Stimmen auf diesem PC", section: "local-ai", words: "own voices offline stimmen eva thorsten martin" },
  { label: "Online-Stimmen", section: "local-ai", words: "online voices gemini elevenlabs schlüssel" },
  { label: "Leistungsmodus", section: "local-ai", words: "performance mode auto max low sparmodus" },
  { label: "Läuft auf", section: "local-ai", words: "runs on prozessor grafikkarte gpu cpu directml" },
  { label: "Spracherkennung", section: "local-ai", words: "speech recognition offline windows parakeet erkennung" },
  { label: "Messungen", section: "local-ai", words: "measurements benchmark messen geschwindigkeit" },
  { label: "Mit Windows starten", section: "startup", words: "start with windows autostart" },
  { label: "Im Infobereich weiterlaufen", section: "startup", words: "keep running in the tray hintergrund infobereich" },
  { label: "Windows-Benachrichtigungen", section: "startup", words: "windows notifications benachrichtigung erinnerung" },
  { label: "Automatisch aktualisieren", section: "updates", words: "automatic updates aktualisierung version" },
  { label: "Update-Quelle", section: "updates", words: "update source github repository" },
  { label: "Wetter", section: "integrations", words: "weather ort" },
  { label: "Nachrichten-Feeds", section: "integrations", words: "news feeds nachrichten rss" },
  { label: "Aktualisierungsintervall", section: "system", words: "refresh interval aktualisieren cpu" },
  { label: "Arbeitsspeicher", section: "performance", words: "ram speicher memory verbrauch leistung performance mb" },
  { label: "Hauptfenster beim Schließen freigeben", section: "performance", words: "ram speicher tray schließen fenster leistung" },
  { label: "NOVA-AI-Fenster freigeben nach", section: "performance", words: "ram speicher panel assistent leerlauf leistung" },
  { label: "Tastenkürzel", section: "shortcuts", words: "keyboard shortcuts tasten befehlspalette" },
  { label: "Aktionsverlauf und Nutzung", section: "privacy", words: "action history usage verlauf datenschutz löschen" },
  { label: "Nutzungsstatistik senden", section: "privacy", words: "usage statistics statistik telemetrie zustimmung widerrufen datenschutz" },
  { label: "Version", section: "about", words: "what's new was ist neu" },
  { label: "Einstellungen zurücksetzen", section: "about", words: "reset settings zurücksetzen" },
  { label: "Entwickler-Schlüssel", section: "about", words: "developer dev key entwickler schlüssel freischalten unlock" },
];

/** Words as people type them: split at anything that is no letter or digit ("Auto-Modus" is two). */
const wordsOf = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * How well a term fits a setting; lower is better, `null` is no fit. A name that starts
 * with it comes first, then a word of the name, then one of the other words, and last a
 * match inside a word: that still counts, because German builds its words from parts
 * ("bild" finds "Hintergrundbild"), but it mustn't push "Ecken" behind "wecken".
 */
function fit(setting: (typeof SEARCHABLE)[number], term: string): number | null {
  const label = setting.label.toLowerCase();
  if (label.startsWith(term)) return 0;
  if (wordsOf(label).some((word) => word.startsWith(term))) return 1;
  if (wordsOf(setting.words ?? "").some((word) => word.startsWith(term))) return 2;
  return `${label} ${setting.words ?? ""}`.toLowerCase().includes(term) ? 3 : null;
}

/** The settings that fit every word of the query, the best fit first. */
export function searchSettings(query: string): typeof SEARCHABLE {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return SEARCHABLE.flatMap((setting) => {
    const fits = terms.map((term) => fit(setting, term));
    return fits.includes(null) ? [] : [{ setting, score: fits.reduce<number>((sum, value) => sum + (value ?? 0), 0) }];
  })
    // A stable sort: among equal fits the order of the list (the order of the sections) stays.
    .sort((a, b) => a.score - b.score)
    .slice(0, 8)
    .map(({ setting }) => setting);
}

const OVERVIEW = "overview";
const SECTIONS = GROUPS.flatMap((group) => group.sections);
const sectionOf = (id: string) => SECTIONS.find((section) => section.id === id);

const TITLE_BAR_CLOCK_OPTIONS = [
  { value: "off", label: "Aus" },
  { value: "time", label: "Uhrzeit" },
  { value: "time-date", label: "Uhrzeit & Datum" },
] as const satisfies readonly { value: TitleBarClock; label: string }[];

const REFRESH_OPTIONS = REFRESH_INTERVALS_MS.map((ms) => ({ value: ms, label: `${ms / 1000} s` }));

export default function SettingsPage() {
  const requestedSection = useUi((s) => s.settingsSection);
  const clearSettingsSection = useUi((s) => s.clearSettingsSection);
  const [active, setActive] = useState(requestedSection ?? OVERVIEW);
  const [query, setQuery] = useState("");
  // A setting the search led to: shown and briefly lit up once its section is there.
  const [target, setTarget] = useState<string | null>(null);
  const results = searchSettings(query);
  const content = useRef<HTMLDivElement>(null);
  useRecordChanges(content, active);

  const open = (section: string, setting: string | null = null) => {
    setActive(section);
    setTarget(setting);
    setQuery("");
    document.getElementById("main")?.scrollTo({ top: 0 });
  };

  // Opened from elsewhere (e.g. the NOVA AI panel) at a specific section.
  useEffect(() => {
    if (!requestedSection) return;
    open(requestedSection);
    clearSettingsSection();
  }, [requestedSection, clearSettingsSection]);

  useEffect(() => {
    if (!target) return;
    window.dispatchEvent(new Event(REVEAL_SETTINGS_EVENT));
    let lit: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      const row = [...document.querySelectorAll<HTMLElement>("[data-setting]")].find((el) => el.dataset.setting === target);
      if (!row) return;
      row.scrollIntoView({ block: "center" });
      // The keyboard lands where the eye does: on the setting's own control.
      row.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
      row.classList.add("setting-found");
      lit = setTimeout(() => row.classList.remove("setting-found"), 1800);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(lit);
    };
  }, [target, active]);

  const navButton = (id: string, label: string, Icon: LucideIcon) => (
    <button
      key={id}
      type="button"
      onClick={() => open(id)}
      aria-current={active === id ? "page" : undefined}
      className={cn(
        "flex h-8 w-full items-center gap-2.5 rounded-control px-2.5 text-left text-[12.5px] font-medium transition-colors",
        active === id ? "bg-white/[0.07] text-fg" : "text-fg-muted hover:bg-white/[0.04] hover:text-fg",
      )}
    >
      <Icon size={14} className={active === id ? "text-accent-text" : "text-fg-subtle"} aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );

  // On the home the search is the wide field in the middle; inside a section it sits here.
  const searchingBeside = active !== OVERVIEW && query.trim() !== "";
  return (
    <Page>
      <PageHeader title="Einstellungen" description="Mach NOVA zu deinem. Jede Änderung wird sofort auf diesem PC gespeichert." />
      <div className="grid grid-cols-[212px_minmax(0,1fr)] items-start gap-6">
        <nav aria-label="Bereiche der Einstellungen" className="sticky top-0 max-h-[calc(100vh-3.5rem)] space-y-3 overflow-y-auto pb-4">
          {active !== OVERVIEW && <SettingsSearch query={query} onQuery={setQuery} results={results} sectionOf={sectionOf} onOpen={open} />}
          {!searchingBeside && (
            <>
              {navButton(OVERVIEW, "Übersicht", Gauge)}
              {GROUPS.map((group) => (
                <div key={group.label}>
                  <p className="px-2.5 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-fg-subtle uppercase">{group.label}</p>
                  <div className="space-y-0.5">{group.sections.map(({ id, label, icon }) => navButton(id, label, icon))}</div>
                </div>
              ))}
            </>
          )}
        </nav>

        <div ref={content} className="min-w-0 max-w-3xl space-y-5">
          <StorageWarning />
          <Section id={active} onOpen={open} search={<SettingsSearch large autoFocus query={query} onQuery={setQuery} results={results} sectionOf={sectionOf} onOpen={open} />} searching={query.trim() !== ""} />
        </div>
      </div>
    </Page>
  );
}

interface SectionProps {
  id: string;
  onOpen: (section: string, setting?: string | null) => void;
  /** The home's search field. */
  search: ReactNode;
  searching: boolean;
}

/** One section at a time: eighteen in a row was too much to find anything in. */
function Section({ id, onOpen, search, searching }: SectionProps) {
  switch (id) {
    case "you":
      return <NameSection />;
    case "appearance":
      return <AppearanceSettings />;
    case "profiles":
      return <ProfilesSettings />;
    case "navigation":
      return <NavigationSettings />;
    case "dashboard":
      return <DashboardSection />;
    case "assistant":
      return <AssistantSettings />;
    case "wake":
      return <WakeSettings />;
    case "games":
      return <GamesSettings />;
    case "assistant-brain":
      return <AgentSettings />;
    case "local-ai":
      return <SpeechSettings />;
    case "finder":
      return <FinderSettings />;
    case "ai":
      return <AiProviderSettings />;
    case "integrations":
      return <IntegrationsSettings />;
    case "startup":
      return <StartupSettings />;
    case "updates":
      return <UpdatesSettings />;
    case "system":
      return <SystemSection />;
    case "performance":
      return <PerformanceSettings />;
    case "shortcuts":
      return <ShortcutsSection />;
    case "privacy":
      return <PrivacySection />;
    case "about":
      return <AboutSection />;
    default:
      return <SettingsOverview groups={GROUPS} search={search} searching={searching} onOpen={onOpen} />;
  }
}

function NameSection() {
  const displayName = useSettings((s) => s.displayName);
  const setDisplayName = useSettings((s) => s.setDisplayName);
  const { data: info } = useSystemInfo();
  const nameId = useId();
  const shown = displayName.trim() || info?.userName || "";

  return (
    <SettingsSection id="you" title="Dein Name" description="Wie NOVA dich nennt: auf Home und wenn es mit dir spricht." icon={UserRound}>
      <SettingCard title="Anrede">
        {/* The greeting as Home shows it, so the name can be read in its place while it is typed. */}
        <p aria-hidden className="pb-4 text-[24px] leading-tight font-semibold tracking-[-0.015em] text-fg">
          {greetingFor(new Date())}
          {shown && (
            <>
              , <span className="text-accent-text">{shown}</span>
            </>
          )}
        </p>
        <SettingLine
          label="Dein Name"
          htmlFor={nameId}
          description={info?.userName ? `Ohne Namen zeigt Home den deines Windows-Kontos (${info.userName}), und NOVA AI spricht dich gar nicht mit Namen an.` : "Ohne Namen spricht NOVA AI dich gar nicht mit Namen an."}
        >
          <input id={nameId} value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Dein Name" maxLength={40} className={cn(FIELD, "w-56")} />
        </SettingLine>
      </SettingCard>
    </SettingsSection>
  );
}

function DashboardSection() {
  const use24HourClock = useSettings((s) => s.use24HourClock);
  const setUse24HourClock = useSettings((s) => s.setUse24HourClock);
  const titleBarClock = useSettings((s) => s.titleBarClock);
  const setTitleBarClock = useSettings((s) => s.setTitleBarClock);

  return (
    <SettingsSection id="dashboard" title="Dashboard" description="Wie NOVA die Uhrzeit zeigt." icon={LayoutDashboard}>
      <SettingCard title="Uhrzeit" icon={Clock}>
        <SettingLine label="24-Stunden-Uhr" description="Zeigt 18:30 statt 6:30 PM.">
          <Switch label="24-Stunden-Uhr" checked={use24HourClock} onChange={setUse24HourClock} />
        </SettingLine>
        <SettingLine label="Uhr in der Titelleiste" description="Hält die Uhrzeit auf jeder Seite im Blick, neben den Mitteilungen.">
          <SegmentedControl label="Uhr in der Titelleiste" value={titleBarClock} options={TITLE_BAR_CLOCK_OPTIONS} onChange={setTitleBarClock} />
        </SettingLine>
      </SettingCard>
    </SettingsSection>
  );
}

function SystemSection() {
  const refreshIntervalMs = useSettings((s) => s.refreshIntervalMs);
  const setRefreshInterval = useSettings((s) => s.setRefreshInterval);

  return (
    <SettingsSection id="system" title="System" description="Wie NOVA die Live-Werte dieses PCs liest." icon={Activity}>
      <SettingCard title="Live-Werte" icon={Activity}>
        <SettingLine label="Aktualisierungsintervall" description="Wie oft CPU und Arbeitsspeicher neu gelesen werden. Kürzer kostet etwas mehr CPU; solange NOVA minimiert ist, ruht das Lesen.">
          <SegmentedControl label="Aktualisierungsintervall" value={refreshIntervalMs} options={REFRESH_OPTIONS} onChange={setRefreshInterval} />
        </SettingLine>
      </SettingCard>
    </SettingsSection>
  );
}

/** What each shortcut does, in the words of Settings (the command palette has its own). */
const SHORTCUT_LABELS: Record<Shortcut["id"], string> = {
  palette: "Befehlspalette öffnen",
  sidebar: "Seitenleiste ein- oder ausklappen",
  settings: "Einstellungen öffnen",
};

function ShortcutsSection() {
  return (
    <SettingsSection id="shortcuts" title="Tastenkürzel" description="Funktionieren überall in NOVA. Das Kürzel für NOVA AI stellst du unter „Der NOVA-Punkt“ ein." icon={Keyboard}>
      <SettingCard title="In NOVA" icon={Keyboard}>
        <dl data-setting="Tastenkürzel" className="divide-y divide-line">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.id} className="flex items-center justify-between gap-6 py-3 text-[13px] first:pt-0 last:pb-0">
              <dt className="font-medium text-fg">{SHORTCUT_LABELS[shortcut.id]}</dt>
              <dd className="flex gap-1">
                {shortcut.keys.map((key) => (
                  <Kbd key={key}>{key === "Ctrl" ? "Strg" : key}</Kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </SettingCard>
    </SettingsSection>
  );
}

/** Shown only when the local database failed; settings then persist in WebView storage instead. */
function StorageWarning() {
  const error = useStorageHealth((s) => s.error);
  if (!error) return null;
  return (
    <div role="alert" className="flex items-start gap-3 rounded-widget border border-warning/30 bg-warning/10 p-4 text-[13px]">
      <TriangleAlert size={17} className="mt-0.5 shrink-0 text-warning" aria-hidden />
      <div>
        <p className="font-medium text-fg">NOVAs Datenbank ist nicht erreichbar</p>
        <p className="mt-0.5 text-fg-muted">Die Einstellungen liegen solange im vorläufigen Speicher der WebView. Details: {error}</p>
      </div>
    </div>
  );
}

const PRIVACY_FACTS = [
  "Einstellungen, Layouts, Aufgaben, Notizen und Chats liegen in einer lokalen Datenbank auf diesem PC.",
  "Nutzungsstatistik ist freiwillig und aus, bis du zustimmst. Sie enthält nie Chats, Sprache, Dateien, Screenshots, Tastatureingaben, Fenster- oder Programmnamen.",
  "Systemwerte, Apps, Dateien und Medien werden lokal gelesen und verlassen dein Gerät nie.",
  "Fragst du nach dem Wetter oder deiner Internetgeschwindigkeit, fragt NOVA bei Open-Meteo an oder lädt eine Testdatei von Hetzner. Nur dann.",
  "NOVA Finder kennt nur die Ordner, die du ihm gibst. Auch mit dem ganzen PC bleiben Windows, installierte Programme und App-Daten tabu.",
  "KI-Schlüssel liegen in der Windows-Anmeldeinformationsverwaltung. Nur deine Nachrichten, und Screenshots oder Dateien, wenn du sie teilst, gehen an den Anbieter, den du gewählt hast.",
  "Die Farben deines Hintergrundbilds werden auf diesem PC gelesen.",
  "Der NOVA-Punkt nimmt deinen Bildschirm nie im Hintergrund auf. Änderungen an Dateien warten auf dein OK, außer du schaltest den Auto-Modus ein.",
  "Spracheingabe nutzt die Windows-Spracherkennung oder NOVAs Offline-Erkennung, nur solange das Mikrofon offen ist. Nach einer gesprochenen Antwort öffnet es sich von selbst wieder, außer du schaltest das aus.",
  "NOVAs eigene Stimmen laufen auf diesem PC. Wählst du eine Online-Stimme, geht das, was NOVA sagt, an diesen Dienst (Google oder ElevenLabs).",
  "„Hey NOVA“ und das Doppelklatschen halten das Mikrofon nur offen, solange du sie einschaltest, auch in Spielen, außer du schaltest das aus. Der Ton wird auf diesem PC geprüft und nie aufgenommen, gespeichert oder gesendet.",
];

interface StorageStatus {
  available: boolean;
  path: string | null;
  schemaVersion: number | null;
  error: string | null;
}

function PrivacySection() {
  const connections = useExternalConnections();
  return (
    <SettingsSection id="privacy" title="Datenschutz" description="NOVA arbeitet zuerst lokal. Hier steht, was den PC verlässt, und nur weil du es so willst." icon={ShieldCheck}>
      <TelemetrySettings />
      <SettingCard title="Verbindungen nach außen" description="Alles, womit sich NOVA mit deinen jetzigen Einstellungen verbinden kann." icon={Globe}>
        {connections.length === 0 ? (
          <p className="text-[12.5px] text-fg-muted">Keine. NOVA baut gerade keine Netzwerkverbindungen auf.</p>
        ) : (
          <ul className="space-y-1.5 text-[12.5px] leading-relaxed text-fg-muted">
            {connections.map((connection) => (
              <li key={connection} className="flex gap-2">
                <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-fg-subtle" />
                {connection}
              </li>
            ))}
          </ul>
        )}
      </SettingCard>
      <SettingCard title="Worauf du dich verlassen kannst" icon={ShieldCheck}>
        <ul className="space-y-2.5">
          {PRIVACY_FACTS.map((fact) => (
            <li key={fact} className="flex items-start gap-2.5 text-[13px] leading-relaxed text-fg-muted">
              <Check size={15} className="mt-0.5 shrink-0 text-success" aria-hidden />
              {fact}
            </li>
          ))}
        </ul>
      </SettingCard>
      <AssistantHistoryCard />
    </SettingsSection>
  );
}

function AboutSection() {
  const resetSettings = useSettings((s) => s.resetSettings);
  const { data: runtime } = useQuery({
    queryKey: ["app", "runtime"],
    queryFn: async () => (isDesktop() ? { version: await getVersion(), tauri: await getTauriVersion() } : null),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const { data: storage } = useQuery({
    queryKey: ["app", "storage"],
    queryFn: () => (isDesktop() ? callNative<StorageStatus>("storage_status") : null),
  });

  return (
    <SettingsSection id="about" title="Über NOVA" description="Your Personal Command Center · Everything. Connected." icon={Info}>
      <SettingCard title="NOVA" icon={Info}>
        <div className="flex items-center gap-4 pb-4">
          <NovaMark size={48} />
          <div>
            <p className="text-[15px] font-semibold tracking-[0.16em] text-fg">NOVA</p>
            <p className="text-[12.5px] text-fg-muted">{runtime ? `Desktop-App · Tauri ${runtime.tauri}` : "Vorschau im Browser: Was Windows braucht, gibt es hier nicht."}</p>
          </div>
        </div>
        <SettingLine label="Version" description="Was in dieser Version dazugekommen ist, zeigt „Was ist neu“.">
          <span className="flex items-center gap-3">
            <span className="text-[13px] font-medium text-fg tabular-nums">{runtime?.version ?? __NOVA_VERSION__}</span>
            <Button size="sm" variant="secondary" onClick={showWhatsNew}>
              Was ist neu
            </Button>
          </span>
        </SettingLine>
        <SettingLine label="Einführung" description="Die Tour vom ersten Start, noch einmal von vorn.">
          <Button size="sm" variant="secondary" onClick={() => useTour.getState().start()}>
            Tour starten
          </Button>
        </SettingLine>
      </SettingCard>
      <SettingCard title="Deine Daten" icon={Database}>
        <SettingLine label="Lokale Datenbank" description={storage ? <span className="break-all select-text">{storage.path ?? "Kein Datenordner vorhanden"}</span> : "Vorschau im Browser: Die Daten liegen im Speicher dieses Browsers."}>
          <span className={cn("text-[13px] font-medium tabular-nums", storage?.available === false ? "text-warning" : "text-fg")}>{storage ? (storage.available ? `Schema v${storage.schemaVersion}` : "Nicht erreichbar") : "—"}</span>
        </SettingLine>
        <SettingLine label="Einstellungen zurücksetzen" description="Stellt Darstellung, Navigation, Dashboard und System wieder her. Dein Name, Wetter-Ort, Nachrichten-Feeds, Start- und Update-Einstellungen und deine Dashboard-Layouts bleiben.">
          <ResetButton onReset={resetSettings} />
        </SettingLine>
      </SettingCard>
      <DevKeyCard />
    </SettingsSection>
  );
}
