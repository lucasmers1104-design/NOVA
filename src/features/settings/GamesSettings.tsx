import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Clapperboard, FolderOpen, MessagesSquare, Video } from "lucide-react";
import { useEffect } from "react";
import { SettingCard, SettingLine } from "@/components/settings-kit";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { notifyError } from "@/features/notifications/store";
import { callNative, isDesktop } from "@/lib/native";
import { useUi } from "@/stores/ui";
import { SettingsNotice, SettingsSection } from "./SettingsLayout";

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

/** "Clip das!" and what NOVA records for it. Sending clips to Discord lives in the Discord tab. */
export function GamesSettings() {
  const client = useQueryClient();
  const { data: status } = useQuery({ queryKey: KEY, queryFn: () => callNative<ReplayStatus>("replay_status"), enabled: isDesktop() });
  const navigate = useUi((s) => s.navigate);

  useEffect(() => {
    if (!isTauri()) return;
    const stop = listen<ReplayStatus>("replay://status", (event) => client.setQueryData(KEY, event.payload));
    return () => void stop.then((unlisten) => unlisten()).catch(() => {});
  }, [client]);

  const save = (data: ReplayStatus) => client.setQueryData(KEY, data);
  const configure = useMutation({
    mutationFn: (update: { enabled: boolean; discordName: string }) => callNative<ReplayStatus>("replay_configure", { update }),
    onSuccess: save,
    onError: (error) => notifyError("Das ließ sich nicht speichern", error),
  });
  const install = useMutation({ mutationFn: () => callNative<ReplayStatus>("replay_install"), onSuccess: save, onError: (error) => notifyError("Der Download ist nicht gestartet", error) });

  const title = "Spiele & Clips";
  if (!isDesktop()) {
    return (
      <SettingsSection id="games" title={title} description="Sag beim Spielen „Clip das“." icon={Clapperboard}>
        <SettingsNotice>Das gibt es in der NOVA-Desktop-App.</SettingsNotice>
      </SettingsSection>
    );
  }
  if (!status) return null;

  const turn = (enabled: boolean) => {
    configure.mutate({ enabled, discordName: status.discordName });
    if (enabled && !status.installed) install.mutate();
  };
  const downloaded = status.downloading === null ? 0 : Math.min(100, (status.downloading / status.downloadSize) * 100);

  return (
    <SettingsSection
      id="games"
      title={title}
      description="Sag beim Spielen „Clip das“, und NOVA speichert die letzten Sekunden als Video. Frag jederzeit „Wie lange zock ich schon?“ oder „Was hat da eben geruckelt?“."
      icon={Clapperboard}
    >
      <SettingCard title="Clips" description="NOVA nimmt nur auf, solange ein Spiel im Vollbild läuft." icon={Video}>
        <SettingLine
          label="Clip das!"
          description={
            status.enabled && status.installed
              ? `Solange ein Spiel im Vollbild läuft, behält NOVA die letzte Minute${status.encoder ? `, aufgenommen über deine Grafikkarte (${status.encoder})` : ""}. „Clip das“ speichert die letzten 30 Sekunden, „Clip die letzte Minute“ alles. Außerhalb von Spielen wird nichts aufgenommen.`
              : `NOVA nimmt mit ffmpeg auf, einem freien Videowerkzeug${status.installed ? "" : `: ${mb(status.downloadSize)} MB, einmal herunterzuladen`}. Aufgenommen wird nur, solange ein Spiel vorn ist.`
          }
        >
          <Switch label="Clip das!" checked={status.enabled} disabled={configure.isPending} onChange={turn} />
        </SettingLine>
        {status.downloading !== null && (
          <div className="py-3.5">
            <div role="progressbar" aria-label="ffmpeg wird geladen" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(downloaded)} className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]">
              <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${downloaded}%` }} />
            </div>
            <p className="mt-1.5 text-[12px] text-fg-muted">
              ffmpeg wird geladen … {mb(status.downloading)} von {mb(status.downloadSize)} MB
            </p>
          </div>
        )}
        {status.enabled && !status.installed && status.downloading === null && (
          <p className="py-3.5 text-[12px] text-fg-muted">
            ffmpeg ist noch nicht heruntergeladen.{" "}
            <button type="button" className="font-medium text-accent-text hover:underline" onClick={() => install.mutate()}>
              Jetzt laden
            </button>
          </p>
        )}
        {status.error && (
          <p role="alert" className="py-3.5 text-[12px] text-warning">
            {status.error}
          </p>
        )}
        <SettingLine label="Deine Clips" description={<span className="break-all select-text">{status.folder}</span>}>
          <Button size="sm" variant="secondary" icon={<FolderOpen size={13} aria-hidden />} onClick={() => void callNative("replay_open_folder").catch((error: unknown) => notifyError("Der Ordner ließ sich nicht öffnen", error))}>
            Ordner öffnen
          </Button>
        </SettingLine>
      </SettingCard>

      <SettingCard title="An Discord schicken" description="„Schick das an die Jungs“ und alles andere rund um Discord findest du jetzt im eigenen Tab." icon={MessagesSquare}>
        <SettingLine label="Discord" description="Clips schicken, NOVA in Kanälen schreiben lassen und Ansagen im Call.">
          <Button size="sm" variant="secondary" onClick={() => navigate("discord")}>
            Zum Discord-Tab
          </Button>
        </SettingLine>
      </SettingCard>
    </SettingsSection>
  );
}
