import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Clapperboard, FolderOpen } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { notifyError } from "@/features/notifications/store";
import { callNative, isDesktop } from "@/lib/native";
import { SettingRow, SettingsSection } from "./SettingsLayout";

/** Mirrors `ReplayStatus` in src-tauri/src/replay.rs. */
export interface ReplayStatus {
  enabled: boolean;
  installed: boolean;
  downloading: number | null;
  downloadSize: number;
  recording: boolean;
  encoder: string | null;
  error: string | null;
  folder: string;
  discordName: string;
  discordSet: boolean;
}

const KEY = ["replay"];
const mb = (bytes: number) => Math.round(bytes / 1_000_000);
const INPUT = "h-9 rounded-control border border-line bg-black/25 px-3 text-[13px] text-fg outline-none select-text placeholder:text-fg-subtle focus:border-line-strong";

/** "Clip das!", what NOVA records for it, and the Discord channel clips go to. */
export function GamesSettings() {
  const client = useQueryClient();
  const { data: status } = useQuery({ queryKey: KEY, queryFn: () => callNative<ReplayStatus>("replay_status"), enabled: isDesktop() });
  const [name, setName] = useState<string | null>(null);
  const [webhook, setWebhook] = useState("");
  const nameId = useId();
  const webhookId = useId();

  useEffect(() => {
    if (!isTauri()) return;
    const stop = listen<ReplayStatus>("replay://status", (event) => client.setQueryData(KEY, event.payload));
    return () => void stop.then((unlisten) => unlisten()).catch(() => {});
  }, [client]);

  const save = (data: ReplayStatus) => client.setQueryData(KEY, data);
  const configure = useMutation({
    mutationFn: (update: { enabled: boolean; discordName: string }) => callNative<ReplayStatus>("replay_configure", { update }),
    onSuccess: save,
    onError: (error) => notifyError("NOVA couldn't save that", error),
  });
  const install = useMutation({ mutationFn: () => callNative<ReplayStatus>("replay_install"), onSuccess: save, onError: (error) => notifyError("The download didn't start", error) });
  const discord = useMutation({
    mutationFn: (url: string) => callNative<ReplayStatus>("replay_discord_set", { webhook: url }),
    onSuccess: (data) => {
      save(data);
      setWebhook("");
    },
    onError: (error) => notifyError("NOVA couldn't save the Discord channel", error),
  });

  if (!isDesktop()) {
    return (
      <SettingsSection id="games" title="Games & clips" description="Say “Clip das” while you play." icon={Clapperboard}>
        <p className="text-[13px] text-fg-muted">Available in the NOVA desktop app.</p>
      </SettingsSection>
    );
  }
  if (!status) return null;

  const turn = (enabled: boolean) => {
    configure.mutate({ enabled, discordName: status.discordName });
    if (enabled && !status.installed) install.mutate();
  };
  const shownName = name ?? status.discordName;

  return (
    <SettingsSection id="games" title="Games & clips" description="Say “Clip das” while you play, and NOVA saves the last seconds as a video. Ask “Wie lange zock ich schon?” or “Was hat da eben geruckelt?” any time." icon={Clapperboard}>
      <SettingRow
        label="Clip das!"
        description={
          status.enabled && status.installed
            ? `While a game runs in fullscreen, NOVA keeps the last minute${status.encoder ? `, recorded on your graphics card (${status.encoder})` : ""}. “Clip das” saves the last 30 seconds, “Clip die letzte Minute” all of it. Nothing is recorded outside games.`
            : `NOVA records with ffmpeg, a free video tool${status.installed ? "" : `: ${mb(status.downloadSize)} MB to download once`}. Recording only runs while a game is in front.`
        }
      >
        <Switch label="Clip das!" checked={status.enabled} disabled={configure.isPending} onChange={turn} />
      </SettingRow>
      {status.downloading !== null && (
        <div className="py-2">
          <div role="progressbar" aria-label="Downloading ffmpeg" aria-valuenow={Math.round((status.downloading / status.downloadSize) * 100)} className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]">
            <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.min(100, (status.downloading / status.downloadSize) * 100)}%` }} />
          </div>
          <p className="mt-1 text-[12px] text-fg-muted">
            Downloading ffmpeg… {mb(status.downloading)} of {mb(status.downloadSize)} MB
          </p>
        </div>
      )}
      {status.enabled && !status.installed && status.downloading === null && (
        <p className="py-2 text-[12px] text-fg-muted">
          ffmpeg isn't downloaded yet.{" "}
          <button type="button" className="font-medium text-accent-text hover:underline" onClick={() => install.mutate()}>
            Download it now
          </button>
        </p>
      )}
      {status.error && <p className="py-1 text-[12px] text-warning">{status.error}</p>}
      <SettingRow label="Your clips" description={status.folder}>
        <Button size="sm" variant="secondary" icon={<FolderOpen size={13} />} onClick={() => void callNative("replay_open_folder").catch((error: unknown) => notifyError("Couldn't open the folder", error))}>
          Open folder
        </Button>
      </SettingRow>
      <SettingRow
        label="Discord channel"
        htmlFor={webhookId}
        description={
          status.discordSet
            ? `Saved. Say “Schick das an ${status.discordName || "…"}” and NOVA sends your latest clip there, made smaller if Discord needs that.`
            : "In Discord: the channel's settings → Integrations → Webhooks → New Webhook → Copy Webhook URL, then paste it here. NOVA only ever sends to this address."
        }
      >
        {status.discordSet ? (
          <Button size="sm" variant="ghost" disabled={discord.isPending} onClick={() => discord.mutate("")}>
            Remove
          </Button>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (webhook.trim()) discord.mutate(webhook);
            }}
          >
            <input id={webhookId} type="password" autoComplete="off" value={webhook} onChange={(event) => setWebhook(event.target.value)} placeholder="https://discord.com/api/webhooks/…" className={`${INPUT} w-56`} />
            <Button size="sm" type="submit" disabled={!webhook.trim() || discord.isPending}>
              Save
            </Button>
          </form>
        )}
      </SettingRow>
      <SettingRow label="What you call it" htmlFor={nameId} description="NOVA sends right away when you say this name, e.g. “Schick das an die Jungs”.">
        <input
          id={nameId}
          value={shownName}
          maxLength={40}
          placeholder="die Jungs"
          onChange={(event) => setName(event.target.value)}
          onBlur={() => {
            if (name !== null && name.trim() !== status.discordName) configure.mutate({ enabled: status.enabled, discordName: name.trim() });
            setName(null);
          }}
          className={`${INPUT} w-56`}
        />
      </SettingRow>
    </SettingsSection>
  );
}
