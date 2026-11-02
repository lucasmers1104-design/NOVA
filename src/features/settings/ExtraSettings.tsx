import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Check, CloudDownload, ExternalLink, KeyRound, Layers, Plug, Plus, Power, RefreshCw, Trash } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { resolveAccentColor } from "@/design/accent";
import { PROVIDERS, type ProviderId, useDeleteKey, useKeyStatus, useSaveKey } from "@/features/ai/api";
import { useDashboard } from "@/features/dashboard/store";
import { placeLabel } from "@/features/live/api";
import { notifyError } from "@/features/notifications/store";
import { PROFILE_ICONS, useProfiles } from "@/features/profiles/store";
import { DEFAULT_UPDATE_SOURCE, effectiveUpdateSource, useUpdates } from "@/features/updates/store";
import { cn } from "@/lib/cn";
import { callNative, isDesktop } from "@/lib/native";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { SettingRow, SettingsSection } from "./SettingsLayout";

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
    <SettingsSection id="profiles" title="Workspace profiles" description="Switch layout, accent and appearance together for different moments." icon={Layers}>
      <ul className="grid grid-cols-2 gap-3 pb-4">
        {profiles.map((profile) => {
          const Icon = PROFILE_ICONS[profile.kind];
          const active = profile.id === activeId;
          const layout = layouts.find((l) => l.id === profile.layoutId);
          return (
            <li key={profile.id} className={cn("rounded-[16px] border p-4 transition-colors", active ? "border-accent/50 bg-accent/[0.07]" : "border-line bg-white/[0.03]")}>
              <div className="flex items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-[12px] text-white" style={{ backgroundColor: resolveAccentColor(profile.accent) }}>
                  <Icon size={19} aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-[14px] font-semibold text-fg">
                    {profile.name}
                    {active && <Badge tone="accent" className="h-5 px-2 text-[11px]">Active</Badge>}
                  </p>
                  <p className="mt-0.5 truncate text-[12px] text-fg-muted">
                    {layout ? `Layout “${layout.name}”` : "Creates its own layout"} · {profile.transparency ? "Glass" : "Solid"} · Sidebar {profile.sidebarCollapsed ? "compact" : "full"}
                  </p>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-1.5">
                <Button size="sm" variant={active ? "secondary" : "primary"} icon={active ? <Check size={13} /> : undefined} onClick={() => apply(profile.id)} className="h-7">
                  {active ? "Re-apply" : "Switch"}
                </Button>
                {profile.kind === "custom" && (
                  <>
                    <IconButton size="sm" label={`Update ${profile.name} with the current setup`} onClick={() => updateFromCurrent(profile.id)}>
                      <RefreshCw size={13} />
                    </IconButton>
                    <IconButton size="sm" label={`Delete ${profile.name}`} onClick={() => remove(profile.id)} className="hover:text-danger">
                      <Trash size={13} />
                    </IconButton>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <form onSubmit={save} className="flex items-center gap-2 pt-4">
        <label className="flex h-9 flex-1 items-center rounded-control border border-line bg-black/25 px-3 focus-within:border-line-strong">
          <span className="sr-only">New profile name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Name for a profile from your current setup" className="h-full flex-1 bg-transparent text-[13px] text-fg outline-none select-text placeholder:text-fg-subtle" />
        </label>
        <Button type="submit" size="sm" variant="secondary" icon={<Plus size={14} />} disabled={!name.trim()}>
          Save current setup
        </Button>
      </form>
    </SettingsSection>
  );
}

export function AiProviderSettings() {
  const { data: status, error } = useKeyStatus();
  return (
    <SettingsSection
      id="ai"
      title="AI providers"
      description="Keys are stored in Windows Credential Manager. NOVA can use them but never shows them again."
      icon={KeyRound}
    >
      {error ? (
        <p className="text-[13px] text-fg-muted">AI providers are available in the desktop app.</p>
      ) : (
        PROVIDERS.map((provider) => <ProviderRow key={provider.id} id={provider.id} configured={status?.[provider.id] ?? false} />)
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
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="flex items-center gap-2 text-[13.5px] font-medium text-fg">
            {provider.name}
            <Badge tone={configured ? "success" : "neutral"} className="h-5 px-2 text-[11px]">
              {configured ? "Key saved" : "Not connected"}
            </Badge>
          </p>
          <button
            type="button"
            onClick={() => void callNative("open_url", { url: provider.keyUrl })}
            className="mt-0.5 flex items-center gap-1 text-[12px] text-fg-subtle hover:text-accent-text"
          >
            Get a key <ExternalLink size={11} aria-hidden />
          </button>
        </div>
        <div className="flex gap-1.5">
          {configured && !editing && (
            <Button size="sm" variant="ghost" onClick={() => deleteKey.mutate(id)} className="hover:text-danger">
              Remove
            </Button>
          )}
          {!editing && (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              {configured ? "Replace key" : "Add key"}
            </Button>
          )}
        </div>
      </div>
      {editing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
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
          <label className="flex h-9 flex-1 items-center rounded-control border border-line bg-black/25 px-3 focus-within:border-line-strong">
            <span className="sr-only">{provider.name} API key</span>
            <input
              autoFocus
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={provider.keyHint}
              className="h-full flex-1 bg-transparent font-mono text-[13px] text-fg outline-none placeholder:text-fg-subtle"
            />
          </label>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" type="submit" disabled={key.trim().length < 10 || saveKey.isPending}>
            Save securely
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
    onError: (error) => notifyError("Couldn't change the startup setting", error),
  });

  return (
    <SettingsSection id="startup" title="Startup & notifications" description="Background behavior is off unless you turn it on." icon={Power}>
      <SettingRow label="Start with Windows" description="Opens NOVA when you sign in. With “Keep running in the tray” on, it starts quietly in the tray.">
        <Switch label="Start with Windows" checked={autostart ?? false} disabled={!desktop || setAutostart.isPending} onChange={(v) => setAutostart.mutate(v)} />
      </SettingRow>
      <SettingRow label="Keep running in the tray" description="Closing the window hides NOVA to the tray so reminders keep working. Quit from the tray icon.">
        <Switch label="Keep running in the tray" checked={closeToTray} disabled={!desktop} onChange={setCloseToTray} />
      </SettingRow>
      <SettingRow
        label="Windows notifications"
        description={
          <span className="flex items-center gap-1">
            <Bell size={12} aria-hidden /> Show task reminders as Windows notifications, in addition to NOVA's notification center.
          </span>
        }
      >
        <Switch label="Windows notifications" checked={systemNotifications} onChange={setSystemNotifications} />
      </SettingRow>
    </SettingsSection>
  );
}

export function IntegrationsSettings() {
  const place = useSettings((s) => s.weatherPlace);
  const feeds = useSettings((s) => s.newsFeeds);
  const setPlace = useSettings((s) => s.setWeatherPlace);
  const navigate = useUi((s) => s.navigate);
  return (
    <SettingsSection id="integrations" title="Integrations" description="Online services NOVA connects to — only those you set up." icon={Plug}>
      <SettingRow label="Weather" description={place ? `Open-Meteo · ${placeLabel(place)}` : "Off — choose a location in Live Information."}>
        <div className="flex gap-1.5">
          {place && (
            <Button size="sm" variant="ghost" onClick={() => setPlace(null)}>
              Turn off
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => navigate("live")}>
            {place ? "Change" : "Set up"}
          </Button>
        </div>
      </SettingRow>
      <SettingRow label="News feeds" description={feeds.length ? `${feeds.length} feed${feeds.length > 1 ? "s" : ""}: ${feeds.map((f) => f.title).join(", ")}` : "No feeds added."}>
        <Button size="sm" variant="secondary" onClick={() => navigate("live")}>
          Manage
        </Button>
      </SettingRow>
      <SettingRow label="Calendar sync" description="Outlook and Google Calendar adapters are planned. Your NOVA calendar works fully offline today.">
        <Badge>Planned</Badge>
      </SettingRow>
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

  const result =
    status === "checking"
      ? "Checking…"
      : status === "upToDate"
        ? "NOVA is up to date."
        : status === "available" && info
          ? `Version ${info.version} is available.`
          : status === "error"
            ? error
            : null;

  return (
    <SettingsSection
      id="updates"
      title="Updates"
      description="Signed updates from your release repository. NOVA verifies every download before installing it."
      icon={CloudDownload}
    >
      <SettingRow label="Installed version" description={desktop ? "Updates keep your settings, layouts and data." : "Updates are available in the desktop app."}>
        <span className="text-[13px] font-semibold text-fg tabular-nums">{version ?? "—"}</span>
      </SettingRow>
      <SettingRow
        label="Update source"
        description={
          <>
            Your public GitHub repository as <span className="font-mono">owner/name</span> — NOVA reads <span className="font-mono">releases/latest.json</span> from its
            main branch.{DEFAULT_UPDATE_SOURCE ? ` Leave empty to use ${DEFAULT_UPDATE_SOURCE}.` : ""}
          </>
        }
      >
        <label className="flex h-9 w-60 items-center rounded-full border border-line bg-black/25 px-3 focus-within:border-line-strong">
          <span className="sr-only">Update source</span>
          <input
            value={updateSource}
            onChange={(e) => setUpdateSource(e.target.value)}
            placeholder={DEFAULT_UPDATE_SOURCE || "owner/repository"}
            spellCheck={false}
            className="h-full w-full bg-transparent font-mono text-[12.5px] text-fg outline-none select-text placeholder:text-fg-subtle"
          />
        </label>
      </SettingRow>
      <SettingRow label="Update automatically" description="Checks every time NOVA starts — also when it starts with Windows — and installs new versions after a 15-second notice. NOVA closes and reopens by itself.">
        <Switch label="Update automatically" checked={autoUpdate} onChange={setAutoUpdate} />
      </SettingRow>
      <div className="flex items-center justify-between gap-4 pt-4">
        <p className={cn("text-[12.5px]", status === "error" ? "text-warning" : "text-fg-muted")}>{result}</p>
        <Button
          size="sm"
          variant="secondary"
          icon={<RefreshCw size={13} className={status === "checking" ? "animate-spin" : ""} />}
          disabled={!desktop || !effectiveUpdateSource() || status === "checking" || status === "downloading" || status === "installing"}
          onClick={() => void check({ automatic: false })}
        >
          Check now
        </Button>
      </div>
    </SettingsSection>
  );
}

/** Lists every external connection that is currently enabled. */
export function useExternalConnections(): string[] {
  const place = useSettings((s) => s.weatherPlace);
  const feeds = useSettings((s) => s.newsFeeds);
  const { data: keys } = useKeyStatus();
  const list: string[] = [];
  if (place) list.push("Weather: api.open-meteo.com (your chosen place's coordinates)");
  for (const feed of feeds) {
    try {
      list.push(`News: ${new URL(feed.url).hostname}`);
    } catch {
      // Invalid URLs are never stored; ignore defensively.
    }
  }
  for (const provider of PROVIDERS) if (keys?.[provider.id]) list.push(`AI: ${provider.name} — only when you send a message`);
  const updateSource = useSettings((s) => s.updateSource.trim()) || DEFAULT_UPDATE_SOURCE;
  const autoUpdate = useSettings((s) => s.autoUpdate);
  if (updateSource) {
    const host = updateSource.includes("://") ? updateSource.replace(/^https?:\/\//, "").split("/")[0] : `raw.githubusercontent.com/${updateSource}`;
    list.push(`Updates: ${host} — ${autoUpdate ? "at every start" : "only when you check"}`);
  }
  return list;
}
