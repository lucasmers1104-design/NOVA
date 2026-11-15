import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clapperboard } from "lucide-react";
import { useId, useState } from "react";
import { SettingCard, SettingLine } from "@/components/settings-kit";
import { Button } from "@/components/ui/Button";
import { notifyError } from "@/features/notifications/store";
import type { ReplayStatus } from "@/features/settings/GamesSettings";
import { FIELD } from "@/features/settings/SettingsLayout";
import { cn } from "@/lib/cn";
import { callNative, isDesktop } from "@/lib/native";

const KEY = ["replay"];

/** "Schick das an die Jungs": the channel webhook your latest clip goes to. Moved here from Spiele & Clips. */
export function ClipDiscordCard() {
  const client = useQueryClient();
  const { data: status } = useQuery({ queryKey: KEY, queryFn: () => callNative<ReplayStatus>("replay_status"), enabled: isDesktop() });
  const [name, setName] = useState<string | null>(null);
  const [webhook, setWebhook] = useState("");
  const nameId = useId();
  const webhookId = useId();

  const save = (data: ReplayStatus) => client.setQueryData(KEY, data);
  const configure = useMutation({
    mutationFn: (update: { enabled: boolean; discordName: string }) => callNative<ReplayStatus>("replay_configure", { update }),
    onSuccess: save,
    onError: (error) => notifyError("Das ließ sich nicht speichern", error),
  });
  const discord = useMutation({
    mutationFn: (url: string) => callNative<ReplayStatus>("replay_discord_set", { webhook: url }),
    onSuccess: (data) => {
      save(data);
      setWebhook("");
    },
    onError: (error) => notifyError("Der Discord-Kanal ließ sich nicht speichern", error),
  });

  if (!status) return null;
  const shownName = name ?? status.discordName;

  return (
    <SettingCard title="Clips schicken" description="Ein Kanal, in den NOVA deinen letzten Clip schickt, wenn du „Schick das an die Jungs“ sagst." icon={Clapperboard}>
      <SettingLine
        label="Discord-Kanal"
        htmlFor={status.discordSet ? undefined : webhookId}
        description={
          status.discordSet
            ? `Gespeichert. Sag „Schick das an ${status.discordName || "…"}“, und NOVA schickt deinen letzten Clip dorthin, verkleinert, falls Discord das braucht.`
            : "In Discord: Einstellungen des Kanals → Integrationen → Webhooks → Neuer Webhook → Webhook-URL kopieren, dann hier einfügen. NOVA schickt nur an diese Adresse."
        }
      >
        {status.discordSet ? (
          <Button size="sm" variant="ghost" disabled={discord.isPending} data-records onClick={() => discord.mutate("")}>
            Entfernen
          </Button>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (webhook.trim()) discord.mutate(webhook);
            }}
          >
            <input id={webhookId} type="password" autoComplete="off" value={webhook} onChange={(event) => setWebhook(event.target.value)} placeholder="https://discord.com/api/webhooks/…" className={cn(FIELD, "w-56")} />
            <Button size="sm" type="submit" disabled={!webhook.trim() || discord.isPending}>
              Speichern
            </Button>
          </form>
        )}
      </SettingLine>
      <SettingLine label="So nennst du ihn" htmlFor={nameId} description="Bei diesem Namen schickt NOVA sofort, z. B. „Schick das an die Jungs“.">
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
          className={cn(FIELD, "w-56")}
        />
      </SettingLine>
    </SettingCard>
  );
}
