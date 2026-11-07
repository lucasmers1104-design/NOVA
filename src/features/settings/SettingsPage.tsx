import { useQuery } from "@tanstack/react-query";
import { getTauriVersion, getVersion } from "@tauri-apps/api/app";
import { Activity, AudioLines, Check, CloudDownload, Cpu, Ear, FolderSearch, Gauge, Globe, Info, Keyboard, KeyRound, LayoutDashboard, Layers, type LucideIcon, Palette, PanelLeft, Plug, Power, RotateCcw, Search, ShieldCheck, Sparkles, TriangleAlert, UserRound } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { SHORTCUTS } from "@/app/shortcuts";
import { NovaMark } from "@/components/brand/NovaMark";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { Kbd } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { AgentSettings, AssistantHistoryRow, FinderSettings } from "@/features/nova-assistant/AgentSettings";
import { SpeechSettings } from "@/features/nova-assistant/SpeechSettings";
import { AssistantSettings } from "@/features/nova-assistant/AssistantSettings";
import { WakeSettings } from "@/features/nova-assistant/WakeSettings";
import { useSystemInfo } from "@/features/system/api";
import { showWhatsNew } from "@/features/updates/WhatsNew";
import { cn } from "@/lib/cn";
import { callNative, isDesktop } from "@/lib/native";
import { useStorageHealth } from "@/lib/persistence";
import { type MotionPreference, REFRESH_INTERVALS_MS, type TitleBarClock, useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { AccentSettings } from "./AccentSettings";
import { BackdropSettings } from "./BackdropSettings";
import { AiProviderSettings, IntegrationsSettings, ProfilesSettings, StartupSettings, UpdatesSettings, useExternalConnections } from "./ExtraSettings";
import { NavigationSettings } from "./NavigationSettings";
import { REVEAL_SETTINGS_EVENT, SettingRow, SettingsSection } from "./SettingsLayout";
import { SettingsOverview } from "./SettingsOverview";

const GROUPS: readonly { label: string; sections: readonly { id: string; label: string; icon: LucideIcon }[] }[] = [
  {
    label: "You",
    sections: [
      { id: "you", label: "Your name", icon: UserRound },
      { id: "appearance", label: "Appearance", icon: Palette },
      { id: "profiles", label: "Profiles", icon: Layers },
      { id: "navigation", label: "Navigation", icon: PanelLeft },
      { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    ],
  },
  {
    label: "NOVA AI",
    sections: [
      { id: "assistant-brain", label: "Model & voice", icon: AudioLines },
      { id: "wake", label: "Hey NOVA & claps", icon: Ear },
      { id: "assistant", label: "The NOVA dot", icon: Sparkles },
      { id: "finder", label: "NOVA Finder", icon: FolderSearch },
      { id: "ai", label: "AI providers", icon: KeyRound },
      { id: "local-ai", label: "Local AI & performance", icon: Cpu },
    ],
  },
  {
    label: "This PC",
    sections: [
      { id: "startup", label: "Startup", icon: Power },
      { id: "updates", label: "Updates", icon: CloudDownload },
      { id: "integrations", label: "Integrations", icon: Plug },
      { id: "system", label: "System", icon: Activity },
      { id: "shortcuts", label: "Keyboard shortcuts", icon: Keyboard },
    ],
  },
  {
    label: "NOVA",
    sections: [
      { id: "privacy", label: "Privacy", icon: ShieldCheck },
      { id: "about", label: "About NOVA", icon: Info },
    ],
  },
];

/** What the search finds: the settings by the name their row shows, with the words people may use instead. */
const SEARCHABLE: readonly { label: string; section: string; words?: string }[] = [
  { label: "Your name", section: "you", words: "name heißen nennen anrede" },
  { label: "Accent color", section: "appearance", words: "farbe akzent color" },
  { label: "Background", section: "appearance", words: "hintergrund verlauf gradient bild picture png wallpaper" },
  { label: "Transparency effects", section: "appearance", words: "glas glass transparenz" },
  { label: "Wallpaper backdrop", section: "appearance", words: "hintergrundbild" },
  { label: "Motion", section: "appearance", words: "animation bewegung" },
  { label: "Workspace profiles", section: "profiles", words: "profil" },
  { label: "Sidebar sections", section: "navigation", words: "seitenleiste menü" },
  { label: "24-hour clock", section: "dashboard", words: "uhr zeit" },
  { label: "Title bar clock", section: "dashboard", words: "uhr zeit" },
  { label: "AI provider", section: "assistant-brain", words: "ki anbieter claude gemini openai" },
  { label: "Thoroughness", section: "assistant-brain", words: "gründlichkeit effort schnell" },
  { label: "Monthly limit", section: "assistant-brain", words: "kosten geld budget limit" },
  { label: "Spoken replies", section: "assistant-brain", words: "vorlesen sprechen" },
  { label: "Keep listening", section: "assistant-brain", words: "mikrofon mikro weiterhören" },
  { label: "Auto mode", section: "assistant-brain", words: "auto modus automatisch ohne fragen" },
  { label: "Voice", section: "assistant-brain", words: "stimme thorsten gemini elevenlabs" },
  { label: "Speed and volume", section: "assistant-brain", words: "tempo lautstärke geschwindigkeit" },
  { label: "Speech recognition language", section: "assistant-brain", words: "sprache deutsch englisch" },
  { label: "Wake with “Hey NOVA”", section: "wake", words: "hey nova aufwecken wake mikrofon" },
  { label: "How sure NOVA must be", section: "wake", words: "empfindlichkeit versteht" },
  { label: "Wake with a double clap", section: "wake", words: "klatschen clap" },
  { label: "Clap detection", section: "wake", words: "klatschen empfindlichkeit" },
  { label: "After waking", section: "wake" },
  { label: "Play a sound when NOVA wakes", section: "wake", words: "ton chime" },
  { label: "Also in games", section: "wake", words: "spiele fortnite vollbild" },
  { label: "Show the NOVA dot", section: "assistant", words: "punkt taskleiste" },
  { label: "Where it sits", section: "assistant", words: "punkt position ecke taskleiste" },
  { label: "Search inside text files", section: "finder", words: "suche ordner dateien" },
  { label: "NOVA Finder folders", section: "finder", words: "ordner dateien pfad zugriff ganzer pc festplatte" },
  { label: "API keys", section: "ai", words: "schlüssel key anthropic openai gemini" },
  { label: "NOVA's own voices", section: "local-ai", words: "offline stimmen erkennung grafikkarte" },
  { label: "Start with Windows", section: "startup", words: "autostart" },
  { label: "Keep running in the tray", section: "startup", words: "hintergrund" },
  { label: "Windows notifications", section: "startup", words: "benachrichtigung erinnerung" },
  { label: "Automatic updates", section: "updates", words: "aktualisierung version" },
  { label: "Weather", section: "integrations", words: "wetter ort" },
  { label: "News feeds", section: "integrations", words: "nachrichten" },
  { label: "Refresh interval", section: "system", words: "aktualisieren cpu" },
  { label: "Keyboard shortcuts", section: "shortcuts", words: "tastenkürzel tasten" },
  { label: "Action history and usage", section: "privacy", words: "verlauf datenschutz löschen" },
  { label: "Version", section: "about", words: "what's new neu" },
  { label: "Reset settings", section: "about", words: "zurücksetzen" },
];

export function searchSettings(query: string): typeof SEARCHABLE {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return SEARCHABLE.filter((setting) => {
    const text = `${setting.label} ${setting.words ?? ""}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  }).slice(0, 8);
}

const OVERVIEW = "overview";

const MOTION_OPTIONS = [
  { value: "system", label: "System" },
  { value: "reduced", label: "Reduced" },
  { value: "full", label: "Full" },
] as const satisfies readonly { value: MotionPreference; label: string }[];

const TITLE_BAR_CLOCK_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "time", label: "Time" },
  { value: "time-date", label: "Time & date" },
] as const satisfies readonly { value: TitleBarClock; label: string }[];

const REFRESH_OPTIONS = REFRESH_INTERVALS_MS.map((ms) => ({ value: ms, label: `${ms / 1000}s` }));

export default function SettingsPage() {
  const requestedSection = useUi((s) => s.settingsSection);
  const clearSettingsSection = useUi((s) => s.clearSettingsSection);
  const [active, setActive] = useState(requestedSection ?? OVERVIEW);
  const [query, setQuery] = useState("");
  // A setting the search led to: shown and briefly lit up once its section is there.
  const [target, setTarget] = useState<string | null>(null);
  const results = searchSettings(query);

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
    const frame = requestAnimationFrame(() => {
      const row = [...document.querySelectorAll<HTMLElement>("[data-setting]")].find((el) => el.dataset.setting === target);
      if (!row) return;
      row.scrollIntoView({ block: "center" });
      row.classList.add("setting-found");
      setTimeout(() => row.classList.remove("setting-found"), 1800);
    });
    return () => cancelAnimationFrame(frame);
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

  return (
    <Page>
      <PageHeader title="Settings" description="Personalize NOVA. Changes are saved automatically on this PC." />
      <div className="grid grid-cols-[212px_minmax(0,1fr)] items-start gap-6">
        <nav aria-label="Settings sections" className="sticky top-0 max-h-[calc(100vh-3.5rem)] space-y-3 overflow-y-auto pb-4">
          <label className="flex h-9 items-center gap-2 rounded-control border border-line bg-black/25 px-2.5 focus-within:border-line-strong">
            <Search size={14} className="shrink-0 text-fg-subtle" aria-hidden />
            <span className="sr-only">Search settings</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && results[0]) open(results[0].section, results[0].label);
                if (event.key === "Escape") setQuery("");
              }}
              placeholder="Search settings"
              className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-fg outline-none select-text placeholder:text-fg-subtle"
            />
          </label>
          {query.trim() ? (
            results.length === 0 ? (
              <p className="px-2.5 text-[12px] text-fg-subtle">Nothing found.</p>
            ) : (
              <ul className="space-y-0.5">
                {results.map((result) => (
                  <li key={result.label}>
                    <button type="button" onClick={() => open(result.section, result.label)} className="w-full rounded-control px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.05]">
                      <span className="block truncate text-[12.5px] font-medium text-fg">{result.label}</span>
                      <span className="block truncate text-[11px] text-fg-subtle">{GROUPS.flatMap((g) => g.sections).find((s) => s.id === result.section)?.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <>
              {navButton(OVERVIEW, "Overview", Gauge)}
              {GROUPS.map((group) => (
                <div key={group.label}>
                  <p className="px-2.5 pb-1 text-[10.5px] font-semibold tracking-[0.08em] text-fg-subtle uppercase">{group.label}</p>
                  <div className="space-y-0.5">{group.sections.map(({ id, label, icon }) => navButton(id, label, icon))}</div>
                </div>
              ))}
            </>
          )}
        </nav>

        <div className="min-w-0 max-w-3xl space-y-5">
          <StorageWarning />
          <Section id={active} onOpen={open} />
        </div>
      </div>
    </Page>
  );
}

/** One section at a time: eighteen in a row was too much to find anything in. */
function Section({ id, onOpen }: { id: string; onOpen: (section: string) => void }) {
  switch (id) {
    case "you":
      return <NameSection />;
    case "appearance":
      return <AppearanceSection />;
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
    case "shortcuts":
      return <ShortcutsSection />;
    case "privacy":
      return <PrivacySection />;
    case "about":
      return <AboutSection />;
    default:
      return <SettingsOverview onOpen={onOpen} />;
  }
}

function NameSection() {
  const displayName = useSettings((s) => s.displayName);
  const setDisplayName = useSettings((s) => s.setDisplayName);
  const { data: info } = useSystemInfo();
  const nameId = useId();

  return (
    <SettingsSection id="you" title="Your name" description="What NOVA calls you, on Home and when it talks to you." icon={UserRound}>
      <SettingRow
        label="Your name"
        htmlFor={nameId}
        description={info?.userName ? `Without one, Home shows your Windows account name (${info.userName}) and NOVA AI doesn't use a name at all.` : "Without one, NOVA AI doesn't use a name at all."}
      >
        <input
          id={nameId}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Your name"
          maxLength={40}
          className="h-9 w-56 rounded-control border border-line bg-black/25 px-3 text-[13px] text-fg outline-none select-text placeholder:text-fg-subtle focus:border-line-strong"
        />
      </SettingRow>
    </SettingsSection>
  );
}

function AppearanceSection() {
  const transparency = useSettings((s) => s.transparency);
  const setTransparency = useSettings((s) => s.setTransparency);
  const motion = useSettings((s) => s.motion);
  const setMotion = useSettings((s) => s.setMotion);
  const wallpaperBackdrop = useSettings((s) => s.wallpaperBackdrop);
  const setWallpaperBackdrop = useSettings((s) => s.setWallpaperBackdrop);
  const hasGradient = useSettings((s) => s.backdropGradient !== null || s.backdropImage !== null);

  return (
    <SettingsSection id="appearance" title="Appearance" description="Accent color, background, glass, corners, font and motion." icon={Palette}>
      <AccentSettings />
      <BackdropSettings />
      <SettingRow label="Transparency effects" description="Frosted-glass surfaces. Turn off for smoother performance on integrated graphics.">
        <Switch label="Transparency effects" checked={transparency} onChange={setTransparency} />
      </SettingRow>
      <SettingRow label="Wallpaper backdrop" description={hasGradient ? "Off while a gradient or your own picture is chosen above." :"Shows your desktop wallpaper softly behind NOVA's glass, like macOS. Needs transparency effects."}>
        <Switch label="Wallpaper backdrop" checked={wallpaperBackdrop && !hasGradient} disabled={!transparency || hasGradient} onChange={setWallpaperBackdrop} />
      </SettingRow>
      <SettingRow label="Motion" description="“System” follows the Windows animation setting.">
        <SegmentedControl label="Motion" value={motion} options={MOTION_OPTIONS} onChange={setMotion} />
      </SettingRow>
    </SettingsSection>
  );
}

function DashboardSection() {
  const use24HourClock = useSettings((s) => s.use24HourClock);
  const setUse24HourClock = useSettings((s) => s.setUse24HourClock);
  const titleBarClock = useSettings((s) => s.titleBarClock);
  const setTitleBarClock = useSettings((s) => s.setTitleBarClock);

  return (
    <SettingsSection id="dashboard" title="Dashboard" description="How Home tells time." icon={LayoutDashboard}>
      <SettingRow label="24-hour clock" description="Show times as 18:30 instead of 6:30 PM.">
        <Switch label="24-hour clock" checked={use24HourClock} onChange={setUse24HourClock} />
      </SettingRow>
      <SettingRow label="Title bar clock" description="Keeps the time in view on every page, next to the notifications.">
        <SegmentedControl label="Title bar clock" value={titleBarClock} options={TITLE_BAR_CLOCK_OPTIONS} onChange={setTitleBarClock} />
      </SettingRow>
    </SettingsSection>
  );
}

function SystemSection() {
  const refreshIntervalMs = useSettings((s) => s.refreshIntervalMs);
  const setRefreshInterval = useSettings((s) => s.setRefreshInterval);

  return (
    <SettingsSection id="system" title="System" description="Live metric collection." icon={Activity}>
      <SettingRow
        label="Refresh interval"
        description="How often CPU and memory update. Shorter intervals use slightly more CPU; polling pauses while NOVA is minimized."
      >
        <SegmentedControl label="Refresh interval" value={refreshIntervalMs} options={REFRESH_OPTIONS} onChange={setRefreshInterval} />
      </SettingRow>
    </SettingsSection>
  );
}

function ShortcutsSection() {
  return (
    <SettingsSection id="shortcuts" title="Keyboard shortcuts" description="Available everywhere in NOVA." icon={Keyboard}>
      {SHORTCUTS.map((shortcut) => (
        <div key={shortcut.id} className="flex items-center justify-between py-3 text-[13px] first:pt-0 last:pb-0">
          <span className="text-fg">{shortcut.description}</span>
          <span className="flex gap-1">
            {shortcut.keys.map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </span>
        </div>
      ))}
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
        <p className="font-medium text-fg">NOVA's database is unavailable</p>
        <p className="mt-0.5 text-fg-muted">Settings are being kept in temporary WebView storage instead. Details: {error}</p>
      </div>
    </div>
  );
}

const PRIVACY_FACTS = [
  "Settings, layouts, tasks, notes and chats are stored in a local database on this PC.",
  "No analytics, telemetry or tracking of any kind.",
  "System metrics, apps, files and media are read locally and never leave your device.",
  "Asked for the weather or your internet speed, NOVA contacts Open-Meteo or downloads a test file from Hetzner. Only then.",
  "NOVA Finder only knows the folders you give it. Even with the whole PC added, Windows, installed programs and app data stay off limits.",
  "AI keys live in Windows Credential Manager. Only your messages — and screenshots or files when you share them — go to the provider you chose.",
  "Wallpaper colors are sampled on this PC.",
  "The NOVA AI dot never captures your screen in the background. Changes to files wait for your OK, unless you turn on auto mode.",
  "Voice input uses Windows speech recognition or NOVA's offline recognizer, only while the microphone is open. After a spoken reply it opens again by itself, unless you turn that off.",
  "NOVA's own voices run on this PC. If you pick an online voice, what NOVA says goes to that service (Google or ElevenLabs).",
  "“Hey NOVA” and the double clap keep the microphone open only while you turn them on, also in games unless you turn that off. The sound is checked on this PC and never recorded, saved or sent.",
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
    <SettingsSection id="privacy" title="Privacy" description="NOVA is local-first by design." icon={ShieldCheck}>
      <div className="mb-4 rounded-[14px] border border-line bg-black/20 p-4">
        <p className="flex items-center gap-2 text-[13px] font-medium text-fg">
          <Globe size={14} className="text-accent-text" aria-hidden /> External connections
        </p>
        {connections.length === 0 ? (
          <p className="mt-1 text-[12.5px] text-fg-muted">None. NOVA currently makes no network connections.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-[12.5px] text-fg-muted">
            {connections.map((c) => (
              <li key={c}>• {c}</li>
            ))}
          </ul>
        )}
      </div>
      <ul className="space-y-2.5">
        {PRIVACY_FACTS.map((fact) => (
          <li key={fact} className="flex items-start gap-2.5 text-[13px] text-fg-muted">
            <Check size={15} className="mt-0.5 shrink-0 text-success" aria-hidden />
            {fact}
          </li>
        ))}
      </ul>
      <div className="mt-5 border-t border-line pt-4">
        <AssistantHistoryRow />
      </div>
    </SettingsSection>
  );
}

function AboutSection() {
  const resetSettings = useSettings((s) => s.resetSettings);
  const [confirming, setConfirming] = useState(false);
  const { data: runtime } = useQuery({
    queryKey: ["app", "runtime"],
    queryFn: async () => (isDesktop() ? { version: await getVersion(), tauri: await getTauriVersion() } : null),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const { data: storage } = useQuery({
    queryKey: ["app", "storage"],
    queryFn: () => (isDesktop() ? callNative<StorageStatus>("storage_status") : null),
  });

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  return (
    <SettingsSection id="about" title="About NOVA" icon={Info}>
      <div className="flex items-center gap-4 pb-4">
        <NovaMark size={48} />
        <div>
          <p className="text-[15px] font-semibold tracking-[0.16em] text-fg">NOVA</p>
          <p className="text-[12.5px] text-fg-muted">Your Personal Command Center · Everything. Connected.</p>
        </div>
      </div>
      <SettingRow label="Version" description={runtime ? `Desktop runtime · Tauri ${runtime.tauri}` : "Browser preview — native features are unavailable."}>
        <span className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={showWhatsNew}>
            What's new
          </Button>
          <span className="text-[13px] font-medium text-fg tabular-nums">{runtime?.version ?? __NOVA_VERSION__}</span>
        </span>
      </SettingRow>
      <SettingRow
        label="Local database"
        description={
          storage ? (
            <span className="break-all select-text">{storage.path ?? "No data folder available"}</span>
          ) : (
            "Browser preview — data is kept in this browser's storage."
          )
        }
      >
        <span className={cn("text-[13px] font-medium tabular-nums", storage?.available === false ? "text-warning" : "text-fg")}>
          {storage ? (storage.available ? `Schema v${storage.schemaVersion}` : "Unavailable") : "—"}
        </span>
      </SettingRow>
      <SettingRow label="Reset settings" description="Restore appearance, navigation, dashboard and system preferences. Your name, weather place, news feeds, startup and update choices and dashboard layouts are kept.">
        <Button
          size="sm"
          variant={confirming ? "danger" : "secondary"}
          icon={<RotateCcw size={14} aria-hidden />}
          onClick={() => {
            if (confirming) {
              resetSettings();
              setConfirming(false);
            } else {
              setConfirming(true);
            }
          }}
        >
          {confirming ? "Click again to reset" : "Reset…"}
        </Button>
      </SettingRow>
    </SettingsSection>
  );
}
