import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CalendarClock, Check, CloudDownload, CloudSun, ExternalLink, KeyRound, Layers, Newspaper, Plug, Plus, Power, RefreshCw, Trash } from "lucide-react";
import { type FormEvent, useState } from "react";
import { SettingCard, SettingLine } from "@/components/settings-kit";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { resolveAccentColor } from "@/design/accent";
import { PROVIDERS, type ProviderId, useDeleteKey, useKeyStatus, useSaveKey } from "@/features/ai/api";
import { useDashboard } from "@/features/dashboard/store";
import { placeLabel } from "@/features/live/api";
import { notifyError } from "@/features/notifications/store";
import { PROFILE_ICONS, useProfiles } from "@/features/profiles/store";
import { useTelemetryStatus } from "@/features/telemetry/api";
import { DEFAULT_UPDATE_SOURCE, effectiveUpdateSource, useUpdates } from "@/features/updates/store";
import { cn } from "@/lib/cn";
import { callNative, isDesktop } from "@/lib/native";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { FIELD, SettingsNotice, SettingsSection } from "./SettingsLayout";

export function ProfilesSettings() {
  const profiles = useProfiles((s) => s.profiles);
  const activeId = useProfiles((s) => s.activeId);
  const apply = useProfiles((s) => s.apply);
  const saveCurrentAs = useProfiles((s) => s.saveCurrentAs);
  const updateFromCurrent = useProfiles((s) => s.updateFromCurrent);
  const remove = useProfiles((s) => s.remove);
  const layouts = useDashboard((s) => s.layouts);
  const [name, setName] = useState("");

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    saveCurrentAs(name);
    setName("");
  };

  return (
    <SettingsSection id="profiles" title="Profile" description="Layout, Akzent und Darstellung auf einmal wechseln, passend zum Moment." icon={Layers}>
      <SettingCard title="Deine Profile" description="Ein Profil merkt sich dein Dashboard-Layout, die Akzentfarbe, das Glas und die Seitenleiste." icon={Layers}>
        <ul data-setting="Profile" className="grid grid-cols-2 gap-2.5">
          {profiles.map((profile) => {
            const Icon = PROFILE_ICONS[profile.kind];
            const active = profile.id === activeId;
            const layout = layouts.find((l) => l.id === profile.layoutId);
            return (
              <li key={profile.id} className={cn("rounded-[16px] border p-3.5 transition-colors", active ? "border-accent/50 bg-accent/[0.07]" : "border-line bg-white/[0.02] hover:border-line-strong")}>
                <div className="flex items-start gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-[12px] text-white" style={{ backgroundColor: resolveAccentColor(profile.accent) }}>
                    <Icon size={19} aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-[13.5px] font-semibold text-fg">
                      <span className="truncate">{profile.name}</span>
                      {active && <Badge tone="accent" className="h-5 px-2 text-[11px]">Aktiv</Badge>}
                    </p>
                    <p className="mt-0.5 truncate text-[12px] text-fg-muted">
                      {layout ? `Layout „${layout.name}“` : "Legt ein eigenes Layout an"} · {profile.transparency ? "Glas" : "Deckend"} · Seitenleiste {profile.sidebarCollapsed ? "kompakt" : "voll"}
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-1.5">
                  <Button size="sm" variant={active ? "secondary" : "primary"} icon={active ? <Check size={13} aria-hidden /> : undefined} data-records onClick={() => apply(profile.id)} className="h-7">
                    {active ? "Neu anwenden" : "Wechseln"}
                  </Button>
                  {profile.kind === "custom" && (
                    <>
                      <IconButton size="sm" label={`${profile.name} mit dem jetzigen Stand überschreiben`} onClick={() => updateFromCurrent(profile.id)}>
                        <RefreshCw size={13} aria-hidden />
                      </IconButton>
                      <IconButton size="sm" label={`${profile.name} löschen`} onClick={() => remove(profile.id)} className="hover:text-danger">
                        <Trash size={13} aria-hidden />
                      </IconButton>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <form onSubmit={save} className="flex items-center gap-2 pt-4">
          <input aria-label="Name für ein neues Profil" value={name} onChange={(event) => setName(event.target.value)} maxLength={40} placeholder="Name für ein Profil aus deinem jetzigen Stand" className={cn(FIELD, "min-w-0 flex-1")} />
          <Button type="submit" size="sm" variant="secondary" icon={<Plus size={14} aria-hidden />} disabled={!name.trim()}>
            Jetzigen Stand speichern
          </Button>
        </form>
      </SettingCard>
    </SettingsSection>
  );
}

export function AiProviderSettings() {
  const { data: status, error } = useKeyStatus();
  return (
    <SettingsSection id="ai" title="KI-Anbieter" description="Die Schlüssel liegen in der Windows-Anmeldeinformationsverwaltung. NOVA kann sie benutzen, zeigt sie aber nie wieder an." icon={KeyRound}>
      {error ? (
        <SettingsNotice>KI-Anbieter gibt es in der NOVA-Desktop-App.</SettingsNotice>
      ) : (
        <SettingCard title="API-Schlüssel" description="Mit einem Schlüssel antwortet NOVA AI über diesen Anbieter. Ohne versteht NOVA nur einfache Befehle." icon={KeyRound}>
          <div data-setting="API-Schlüssel" className="divide-y divide-line">
            {PROVIDERS.map((provider) => (
              <ProviderRow key={provider.id} id={provider.id} configured={status?.[provider.id] ?? false} />
            ))}
          </div>
        </SettingCard>
      )}
    </SettingsSection>
  );
}

function ProviderRow({ id, configured }: { id: ProviderId; configured: boolean }) {
  const provider = PROVIDERS.find((p) => p.id === id)!;
  const saveKey = useSaveKey();
  const deleteKey = useDeleteKey();
  const [key, setKey] = useState("");
  const [editing, setEditing] = useState(false);

  return (
    <div className="py-3.5 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="flex items-center gap-2 text-[13px] font-medium text-fg">
            {provider.name}
            <Badge tone={configured ? "success" : "neutral"} className="h-5 px-2 text-[11px]">
              {configured ? "Schlüssel gespeichert" : "Nicht verbunden"}
            </Badge>
          </p>
          <button type="button" onClick={() => void callNative("open_url", { url: provider.keyUrl })} className="mt-0.5 flex items-center gap-1 text-[12px] text-fg-subtle transition-colors hover:text-accent-text">
            Schlüssel holen <ExternalLink size={11} aria-hidden />
          </button>
        </div>
        <div className="flex gap-1.5">
          {configured && !editing && (
            <Button size="sm" variant="ghost" data-records onClick={() => deleteKey.mutate(id)} className="hover:text-danger">
              Entfernen
            </Button>
          )}
          {!editing && (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              {configured ? "Schlüssel ersetzen" : "Schlüssel hinzufügen"}
            </Button>
          )}
        </div>
      </div>
      {editing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            saveKey.mutate(
              { provider: id, key },
              {
                onSuccess: () => {
                  setKey("");
                  setEditing(false);
                },
              },
            );
          }}
          className="mt-3 flex gap-2"
        >
          <input autoFocus type="password" aria-label={`API-Schlüssel für ${provider.name}`} autoComplete="off" spellCheck={false} value={key} onChange={(event) => setKey(event.target.value)} placeholder={provider.keyHint} className={cn(FIELD, "min-w-0 flex-1 font-mono")} />
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Abbrechen
          </Button>
          <Button size="sm" variant="primary" type="submit" disabled={key.trim().length < 10 || saveKey.isPending}>
            Sicher speichern
          </Button>
        </form>
      )}
    </div>
  );
}

export function StartupSettings() {
  const client = useQueryClient();
  const closeToTray = useSettings((s) => s.closeToTray);
  const setCloseToTray = useSettings((s) => s.setCloseToTray);
  const systemNotifications = useSettings((s) => s.systemNotifications);
  const setSystemNotifications = useSettings((s) => s.setSystemNotifications);
  const desktop = isDesktop();
  const { data: autostart } = useQuery({ queryKey: ["desktop", "autostart"], queryFn: () => callNative<boolean>("autostart_get"), enabled: desktop });
  const setAutostart = useMutation({
    mutationFn: (enabled: boolean) => callNative<boolean>("autostart_set", { enabled }),
    onSuccess: (enabled) => client.setQueryData(["desktop", "autostart"], enabled),
    onError: (error) => notifyError("Der Autostart ließ sich nicht ändern", error),
  });

  return (
    <SettingsSection id="startup" title="Start & Benachrichtigungen" description="Im Hintergrund läuft NOVA nur, wenn du es einschaltest." icon={Power}>
      <SettingCard title="Start" description="Wann NOVA da ist, ohne dass du es öffnest." icon={Power}>
        <SettingLine label="Mit Windows starten" description="Öffnet NOVA, sobald du dich anmeldest. Mit „Im Infobereich weiterlaufen“ startet es still im Infobereich.">
          <Switch label="Mit Windows starten" checked={autostart ?? false} disabled={!desktop || setAutostart.isPending} onChange={(enabled) => setAutostart.mutate(enabled)} />
        </SettingLine>
        <SettingLine label="Im Infobereich weiterlaufen" description="Schließt du das Fenster, bleibt NOVA im Infobereich neben der Uhr, damit Erinnerungen weiter kommen. Beenden über das Symbol dort.">
          <Switch label="Im Infobereich weiterlaufen" checked={closeToTray} disabled={!desktop} onChange={setCloseToTray} />
        </SettingLine>
      </SettingCard>
      <SettingCard title="Benachrichtigungen" icon={Bell}>
        <SettingLine label="Windows-Benachrichtigungen" description="Zeigt Erinnerungen an Aufgaben auch als Windows-Benachrichtigung, zusätzlich zu NOVAs eigener Mitteilungszentrale.">
          <Switch label="Windows-Benachrichtigungen" checked={systemNotifications} onChange={setSystemNotifications} />
        </SettingLine>
      </SettingCard>
    </SettingsSection>
  );
}

export function IntegrationsSettings() {
  const place = useSettings((s) => s.weatherPlace);
  const feeds = useSettings((s) => s.newsFeeds);
  const setPlace = useSettings((s) => s.setWeatherPlace);
  const navigate = useUi((s) => s.navigate);
  return (
    <SettingsSection id="integrations" title="Integrationen" description="Online-Dienste, mit denen NOVA sich verbindet. Nur die, die du einrichtest." icon={Plug}>
      <SettingCard title="Wetter und Nachrichten" description="Eingerichtet wird beides unter Live Information." icon={CloudSun}>
        <SettingLine label="Wetter" description={place ? `Open-Meteo · ${placeLabel(place)}` : "Aus. Wähl einen Ort unter Live Information."}>
          <div className="flex gap-1.5">
            {place && (
              <Button size="sm" variant="ghost" data-records onClick={() => setPlace(null)}>
                Ausschalten
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => navigate("live")}>
              {place ? "Ändern" : "Einrichten"}
            </Button>
          </div>
        </SettingLine>
        <SettingLine label="Nachrichten-Feeds" description={feeds.length ? `${feeds.length} ${feeds.length === 1 ? "Feed" : "Feeds"}: ${feeds.map((feed) => feed.title).join(", ")}` : "Noch keine Feeds."}>
          <Button size="sm" variant="secondary" icon={<Newspaper size={13} aria-hidden />} onClick={() => navigate("live")}>
            Verwalten
          </Button>
        </SettingLine>
      </SettingCard>
      <SettingCard title="Kalender" icon={CalendarClock}>
        <SettingLine label="Kalender-Sync" description="Outlook und Google Kalender sind geplant. Dein NOVA-Kalender funktioniert schon heute, ganz ohne Internet.">
          <Badge>Geplant</Badge>
        </SettingLine>
      </SettingCard>
    </SettingsSection>
  );
}

export function UpdatesSettings() {
  const updateSource = useSettings((s) => s.updateSource);
  const setUpdateSource = useSettings((s) => s.setUpdateSource);
  const autoUpdate = useSettings((s) => s.autoUpdate);
  const setAutoUpdate = useSettings((s) => s.setAutoUpdate);
  const status = useUpdates((s) => s.status);
  const info = useUpdates((s) => s.info);
  const error = useUpdates((s) => s.error);
  const check = useUpdates((s) => s.check);
  const desktop = isDesktop();
  const { data: version } = useQuery({
    queryKey: ["app", "version"],
    queryFn: async () => (desktop ? (await import("@tauri-apps/api/app")).getVersion() : null),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const result = status === "checking" ? "Suche nach Updates …" : status === "upToDate" ? "NOVA ist aktuell." : status === "available" && info ? `Version ${info.version} ist da.` : status === "error" ? error : null;

  return (
    <SettingsSection
      id="updates"
      title="Updates"
      description="Signierte Updates aus deinem Release-Repository. NOVA prüft jeden Download, bevor es ihn installiert."
      icon={CloudDownload}
      actions={
        <Button
          size="sm"
          variant="secondary"
          icon={<RefreshCw size={13} className={status === "checking" ? "animate-spin" : ""} aria-hidden />}
          disabled={!desktop || !effectiveUpdateSource() || status === "checking" || status === "downloading" || status === "installing"}
          onClick={() => void check({ automatic: false })}
        >
          Jetzt prüfen
        </Button>
      }
    >
      <SettingCard title="Version" icon={CloudDownload}>
        <SettingLine
          label="Installierte Version"
          description={
            <>
              {desktop ? "Updates behalten deine Einstellungen, Layouts und Daten." : "Updates gibt es in der NOVA-Desktop-App."}
              {result && (
                <span role="status" className={cn("mt-1 block font-medium", status === "error" ? "text-warning" : "text-fg")}>
                  {result}
                </span>
              )}
            </>
          }
        >
          <span className="text-[13px] font-semibold text-fg tabular-nums">{version ?? "—"}</span>
        </SettingLine>
        <SettingLine label="Automatisch aktualisieren" description="Prüft bei jedem Start von NOVA, auch beim Start mit Windows, und installiert neue Versionen nach 15 Sekunden Vorwarnung. NOVA schließt und öffnet sich dabei von selbst.">
          <Switch label="Automatisch aktualisieren" checked={autoUpdate} onChange={setAutoUpdate} />
        </SettingLine>
        <SettingLine
          label="Update-Quelle"
          description={
            <>
              Dein öffentliches GitHub-Repository als <span className="font-mono">besitzer/name</span>. NOVA liest <span className="font-mono">releases/latest.json</span> aus dessen Hauptzweig.
              {DEFAULT_UPDATE_SOURCE ? ` Leer lassen für ${DEFAULT_UPDATE_SOURCE}.` : ""}
            </>
          }
        >
          <input aria-label="Update-Quelle" value={updateSource} onChange={(event) => setUpdateSource(event.target.value)} placeholder={DEFAULT_UPDATE_SOURCE || "besitzer/repository"} spellCheck={false} className={cn(FIELD, "w-60 font-mono")} />
        </SettingLine>
      </SettingCard>
    </SettingsSection>
  );
}

/** Lists every external connection that is currently enabled. */
export function useExternalConnections(): string[] {
  const place = useSettings((s) => s.weatherPlace);
  const feeds = useSettings((s) => s.newsFeeds);
  const { data: keys } = useKeyStatus();
  const { data: statistics } = useTelemetryStatus();
  const list: string[] = [];
  if (statistics?.accepted) list.push(`Nutzungsstatistik: ${statistics.host}, weil du zugestimmt hast`);
  if (place) list.push("Wetter: api.open-meteo.com (die Koordinaten deines gewählten Orts)");
  for (const feed of feeds) {
    try {
      list.push(`Nachrichten: ${new URL(feed.url).hostname}`);
    } catch {
      // Invalid URLs are never stored; ignore defensively.
    }
  }
  for (const provider of PROVIDERS) if (keys?.[provider.id]) list.push(`KI: ${provider.name}, nur wenn du eine Nachricht schickst (NOVA AI schickt Screenshots und Dateien mit, die du teilst)`);
  const updateSource = useSettings((s) => s.updateSource.trim()) || DEFAULT_UPDATE_SOURCE;
  const autoUpdate = useSettings((s) => s.autoUpdate);
  if (updateSource) {
    const host = updateSource.includes("://") ? updateSource.replace(/^https?:\/\//, "").split("/")[0] : `raw.githubusercontent.com/${updateSource}`;
    list.push(`Updates: ${host}, ${autoUpdate ? "bei jedem Start" : "nur wenn du prüfst"}`);
  }
  list.push("Stimmen und Offline-Spracherkennung: huggingface.co, api.nuget.org, github.com, nur für Downloads, die du startest (jede Datei wird gegen eine feste Prüfsumme geprüft)");
  list.push("Online-Stimmen: generativelanguage.googleapis.com oder api.elevenlabs.io, nur wenn du eine wählst (was NOVA sagt, geht dorthin)");
  list.push("Clips: github.com für das Videowerkzeug ffmpeg, wenn du Clips einschaltest (gegen eine feste Prüfsumme geprüft), und discord.com, wenn du einen Clip in den gespeicherten Kanal schickst");
  list.push("Webseiten: jede öffentliche Seite, nur wenn NOVA AI für deine Anfrage eine Seite liest (es kann auch über Anthropic im Web suchen und erreicht nie dein eigenes Netzwerk)");
  return list;
}
