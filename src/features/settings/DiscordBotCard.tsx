import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import { useId, useState } from "react";
import { SettingCard, SettingLine } from "@/components/settings-kit";
import { Button } from "@/components/ui/Button";
import { notify, notifyError } from "@/features/notifications/store";
import { cn } from "@/lib/cn";
import { callNative, isDesktop } from "@/lib/native";
import { useSettings } from "@/stores/settings";
import { FIELD } from "./SettingsLayout";

/** Mirrors `DiscordStatus` in src-tauri/src/discord.rs. */
export interface DiscordBotStatus {
  configured: boolean;
  /** A shared channel webhook is saved. */
  chat: boolean;
  /** An own bot token and channel are saved. */
  bot: boolean;
  label: string | null;
}

const KEY = ["discord-bot"];

/** NOVA writes in a Discord channel for you, after you confirm. Friends with NOVA share the same channel webhook. */
export function DiscordBotCard() {
  const client = useQueryClient();
  const { data: status } = useQuery({ queryKey: KEY, queryFn: () => callNative<DiscordBotStatus>("discord_bot_status"), enabled: isDesktop() });
  const name = useSettings((s) => s.displayName.trim());
  const [webhook, setWebhook] = useState("");
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [channelId, setChannelId] = useState("");
  const [botOpen, setBotOpen] = useState(false);
  const webhookId = useId();
  const labelId = useId();
  const tokenId = useId();
  const channelFieldId = useId();

  const stored = (data: DiscordBotStatus) => {
    client.setQueryData(KEY, data);
    setWebhook("");
    setLabel("");
    setToken("");
    setChannelId("");
    setBotOpen(false);
  };
  const chat = useMutation({
    mutationFn: (args: { webhook: string; label: string }) => callNative<DiscordBotStatus>("discord_chat_set", args),
    onSuccess: stored,
    onError: (error) => notifyError("Der Discord-Chat ließ sich nicht speichern", error),
  });
  const bot = useMutation({
    mutationFn: (args: { token: string; channelId: string; label: string }) => callNative<DiscordBotStatus>("discord_bot_set", args),
    onSuccess: stored,
    onError: (error) => notifyError("Der Discord-Bot ließ sich nicht speichern", error),
  });
  const check = useMutation({
    mutationFn: () => callNative<string>("discord_bot_check"),
    onSuccess: (found) => notify(`Discord kennt „${found}“, alles bereit`, { kind: "success" }),
    onError: (error) => notifyError("Discord hat die Verbindung nicht angenommen", error),
  });

  if (!status) return null;

  const channel = status.label ?? "deinen Kanal";
  const shownAs = name ? `„${name} · via Nova“` : "„NOVA“ (trag unter „Du“ deinen Namen ein, dann steht er dabei)";
  return (
    <SettingCard title="Für dich schreiben" description="NOVA schreibt in einen Discord-Kanal, wenn du es sagst. Du siehst jede Nachricht vorher und bestätigst sie." icon={MessagesSquare}>
      {status.chat ? (
        <SettingLine label="Discord-Chat" description={`Gespeichert für ${channel}. Deine Nachrichten erscheinen als ${shownAs}. Sag z. B. „Schreib in ${status.label ?? "den Kanal"}, dass ich in 10 Minuten online komme“.`}>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={check.isPending} onClick={() => check.mutate()}>
              Prüfen
            </Button>
            <Button size="sm" variant="ghost" disabled={chat.isPending} onClick={() => chat.mutate({ webhook: "", label: "" })}>
              Entfernen
            </Button>
          </div>
        </SettingLine>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (webhook.trim()) chat.mutate({ webhook, label });
          }}
        >
          <SettingLine
            label="Discord-Chat"
            htmlFor={webhookId}
            description="Ein Webhook des Kanals: Kanaleinstellungen → Integrationen → Webhooks → Neuer Webhook → Webhook-URL kopieren. Gib dieselbe Adresse deinen Freunden mit NOVA, dann schreibt jeder unter seinem eigenen Namen. Gerät sie in falsche Hände, löschst du den Webhook und legst einen neuen an."
          >
            <input id={webhookId} type="password" autoComplete="off" value={webhook} onChange={(event) => setWebhook(event.target.value)} placeholder="https://discord.com/api/webhooks/…" className={cn(FIELD, "w-56")} />
          </SettingLine>
          <SettingLine label="Name des Kanals" htmlFor={labelId} description="So nennst du ihn, wenn du NOVA etwas schreiben lässt.">
            <div className="flex gap-2">
              <input id={labelId} maxLength={40} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="die Jungs" className={cn(FIELD, "w-40")} />
              <Button size="sm" type="submit" disabled={!webhook.trim() || chat.isPending}>
                Chat speichern
              </Button>
            </div>
          </SettingLine>
        </form>
      )}

      {status.bot ? (
        <SettingLine label="Discord-Bot" description={status.chat ? "Eigener Bot, nur auf diesem PC. Solange ein Discord-Chat gespeichert ist, schreibt NOVA über den Chat." : "Eigener Bot, nur auf diesem PC. Nachrichten erscheinen unter dem Namen des Bots."}>
          <div className="flex gap-2">
            {!status.chat && (
              <Button size="sm" variant="secondary" disabled={check.isPending} onClick={() => check.mutate()}>
                Prüfen
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={bot.isPending} onClick={() => bot.mutate({ token: "", channelId: "", label: "" })}>
              Entfernen
            </Button>
          </div>
        </SettingLine>
      ) : !botOpen ? (
        <SettingLine label="Discord-Bot" description="Optional: ein eigener Bot statt des Chats, nur für diesen PC. Gib seinen Token nie weiter: Damit lässt sich der Bot auf allen seinen Servern steuern.">
          <Button size="sm" variant="ghost" onClick={() => setBotOpen(true)}>
            Einrichten
          </Button>
        </SettingLine>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (token.trim() && channelId.trim()) bot.mutate({ token, channelId, label: status.label ? "" : label });
          }}
        >
          <SettingLine label="Discord-Bot" htmlFor={tokenId} description="Der Token deines Bots: discord.com/developers → New Application → Bot → Reset Token. Lade den Bot dann über OAuth2 mit „Send Messages“ auf deinen Server ein.">
            <input id={tokenId} type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} className={cn(FIELD, "w-56")} />
          </SettingLine>
          <SettingLine label="Kanal-ID" htmlFor={channelFieldId} description="In Discord: Einstellungen → Erweitert → Entwicklermodus an, dann Rechtsklick auf den Kanal → Kanal-ID kopieren.">
            <div className="flex gap-2">
              <input id={channelFieldId} inputMode="numeric" autoComplete="off" value={channelId} onChange={(event) => setChannelId(event.target.value)} placeholder="123456789012345678" className={cn(FIELD, "w-44")} />
              <Button size="sm" type="submit" disabled={!token.trim() || !channelId.trim() || bot.isPending}>
                Bot speichern
              </Button>
            </div>
          </SettingLine>
        </form>
      )}
    </SettingCard>
  );
}
