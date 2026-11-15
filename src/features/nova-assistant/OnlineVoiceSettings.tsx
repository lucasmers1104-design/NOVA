import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Globe, Play, Square } from "lucide-react";
import { type ReactNode, useState } from "react";
import { SettingCard, SettingLine } from "@/components/settings-kit";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { aiKeys } from "@/features/ai/api";
import { notify, notifyError } from "@/features/notifications/store";
import { FIELD } from "@/features/settings/SettingsLayout";
import { cn } from "@/lib/cn";
import { callNative, isDesktop } from "@/lib/native";
import { isOnlineVoice, useVoice } from "./voice";

/** Google's voices, all of which speak German (the model picks up the language from the text). */
export const GEMINI_VOICES = [
  { id: "Sulafat", name: "Sulafat, warm" },
  { id: "Achird", name: "Achird, freundlich" },
  { id: "Kore", name: "Kore, bestimmt" },
  { id: "Puck", name: "Puck, lebhaft" },
  { id: "Aoede", name: "Aoede, luftig" },
  { id: "Charon", name: "Charon, sachlich" },
  { id: "Leda", name: "Leda, jugendlich" },
  { id: "Fenrir", name: "Fenrir, aufgeregt" },
] as const;

/** Offered until the account's own list can be read. */
const ELEVENLABS_DEFAULTS = [
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "George" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam" },
];

interface OnlineVoiceKeys {
  gemini: boolean;
  elevenlabs: boolean;
}

const KEYS = ["assistant", "onlineVoiceKeys"] as const;

export function useOnlineVoices() {
  const keys = useQuery({ queryKey: KEYS, queryFn: () => callNative<OnlineVoiceKeys>("online_voice_keys"), enabled: isDesktop() });
  const hasElevenLabs = keys.data?.elevenlabs ?? false;
  const listed = useQuery({
    queryKey: ["assistant", "elevenlabsVoices"],
    queryFn: () => callNative<{ id: string; name: string }[]>("elevenlabs_voices_list"),
    enabled: hasElevenLabs,
    staleTime: 10 * 60_000,
    retry: false,
  });
  return { keys: keys.data, elevenlabs: listed.data?.length ? listed.data : ELEVENLABS_DEFAULTS };
}

const SERVICES = {
  gemini: {
    name: "Google Gemini",
    url: "https://aistudio.google.com/apikey",
    help: "Kostenlos, aber nur für ein paar Anfragen pro Minute (deine Limits stehen in Google AI Studio). In langen Gesprächen springt deshalb manchmal NOVAs eigene Stimme ein. Keine Kreditkarte nötig. Was NOVA sagt, geht an Google, und mit diesem Schlüssel kann NOVA AI auch mit Gemini antworten.",
    save: (key: string) => callNative<void>("ai_key_set", { provider: "gemini", key }),
    hint: "AIza…",
  },
  elevenlabs: {
    name: "ElevenLabs",
    url: "https://elevenlabs.io/app/settings/api-keys",
    help: "10.000 freie Credits im Monat, etwa 20.000 Zeichen mit der schnellen Stimme, die NOVA nutzt. Keine Kreditkarte nötig. Was NOVA sagt, geht an ElevenLabs.",
    save: (key: string) => callNative<void>("elevenlabs_key_set", { key }),
    hint: "sk_…",
  },
} as const;

type Service = keyof typeof SERVICES;

export function serviceOf(voice: string): Service {
  return voice.split(":")[1] === "elevenlabs" ? "elevenlabs" : "gemini";
}

interface VoiceRowProps {
  name: string;
  /** Beside the name: what makes this voice special. */
  badges?: ReactNode;
  /** Under the name: what there is to know about it. */
  detail?: ReactNode;
  /** It is NOVA's voice right now. */
  chosen: boolean;
  /** Its sample is playing. */
  playing: boolean;
  /** It can be listened to and chosen (downloaded, or its key is saved). */
  usable: boolean;
  onListen: () => void;
  onChoose: () => void;
  /** After the buttons, e.g. download or remove. */
  children?: ReactNode;
}

/** One voice to listen to and to make NOVA's own. */
export function VoiceRow({ name, badges, detail, chosen, playing, usable, onListen, onChoose, children }: VoiceRowProps) {
  return (
    <li className={cn("flex items-center justify-between gap-3 rounded-[14px] border px-3 py-2 transition-colors", chosen ? "border-accent/50 bg-accent/[0.07]" : "border-line bg-white/[0.02]")}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-fg">
          {name}
          {chosen && <Badge tone="accent">NOVAs Stimme</Badge>}
          {badges}
        </div>
        {detail && <div className="mt-0.5 text-[12px] leading-relaxed text-fg-muted">{detail}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <IconButton size="sm" label={playing ? `${name} stoppen` : `${name} anhören`} disabled={!usable} onClick={onListen} className={cn(playing && "bg-accent/15")}>
          {playing ? <Square size={11} className="text-accent-text" aria-hidden /> : <Play size={14} aria-hidden />}
        </IconButton>
        {!chosen && (
          <Button size="sm" variant="ghost" disabled={!usable} data-records onClick={onChoose}>
            Nehmen
          </Button>
        )}
        {children}
      </div>
    </li>
  );
}

interface OnlineVoiceListProps {
  current: string;
  /** The voice whose sample is playing. */
  playing: string | null;
  onChoose: (voice: string) => void;
  onListen: (voice: string) => void;
}

/** Settings → Sprache auf diesem PC: the online voices beside NOVA's own, with their keys. */
export function OnlineVoiceList({ current, playing, onChoose, onListen }: OnlineVoiceListProps) {
  const { keys, elevenlabs } = useOnlineVoices();
  const problem = useVoice((s) => s.onlineVoiceProblem);
  const services: readonly { service: Service; voices: readonly { id: string; name: string }[] }[] = [
    { service: "gemini", voices: GEMINI_VOICES },
    { service: "elevenlabs", voices: elevenlabs },
  ];
  return (
    <SettingCard title="Online-Stimmen" description="Die natürlichsten Stimmen. Sie brauchen das Internet und einen kostenlosen Schlüssel. Fällt eine aus, springt NOVAs eigene Stimme ein." icon={Globe}>
      {problem && isOnlineVoice(current) && (
        <p role="alert" className="pb-3.5 text-[12px] text-warning">
          Die Online-Stimme hat nicht funktioniert, deshalb ist eine andere eingesprungen: {problem}
        </p>
      )}
      {services.map(({ service, voices }) => (
        <div key={service} className="py-3.5 first:pt-0 last:pb-0">
          <OnlineVoiceKeyRow service={service} />
          <ul data-setting="Online-Stimmen" className="mt-3 space-y-1.5">
            {voices.map((voice) => {
              const value = `online:${service}:${voice.id}`;
              return <VoiceRow key={value} name={voice.name} chosen={current === value} playing={playing === value} usable={keys?.[service] ?? false} onListen={() => onListen(value)} onChoose={() => onChoose(value)} />;
            })}
          </ul>
        </div>
      ))}
    </SettingCard>
  );
}

/** The key for one online service. */
export function OnlineVoiceKeyRow({ service }: { service: Service }) {
  const info = SERVICES[service];
  const client = useQueryClient();
  const { keys } = useOnlineVoices();
  const [key, setKey] = useState("");
  const refresh = () => {
    void client.invalidateQueries({ queryKey: KEYS });
    void client.invalidateQueries({ queryKey: aiKeys.keyStatus });
    void client.invalidateQueries({ queryKey: ["assistant", "elevenlabsVoices"] });
  };
  const save = useMutation({
    mutationFn: () => info.save(key),
    onSuccess: () => {
      setKey("");
      refresh();
      notify(`Schlüssel für ${info.name} gespeichert`, { kind: "success", body: "Du kannst die Stimmen jetzt nutzen." });
    },
    onError: (error) => notifyError("Der Schlüssel ließ sich nicht speichern", error),
  });
  const configured = keys?.[service] ?? false;

  return (
    <SettingLine
      label={`Schlüssel für ${info.name}`}
      description={
        <>
          {info.help}{" "}
          <button type="button" onClick={() => void callNative("open_url", { url: info.url })} className="inline-flex items-center gap-1 text-fg-subtle transition-colors hover:text-accent-text">
            Schlüssel holen <ExternalLink size={11} aria-hidden />
          </button>
        </>
      }
    >
      {configured ? (
        <div className="flex items-center gap-1.5">
          <Badge tone="success">Schlüssel gespeichert</Badge>
          {/* The Gemini key belongs to AI providers, where it can be removed. */}
          {service === "elevenlabs" && (
            <Button size="sm" variant="ghost" className="hover:text-danger" data-records onClick={() => void callNative("elevenlabs_key_delete").then(refresh, (error: unknown) => notifyError("Der Schlüssel ließ sich nicht entfernen", error))}>
              Entfernen
            </Button>
          )}
        </div>
      ) : (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <input type="password" aria-label={`API-Schlüssel für ${info.name}`} autoComplete="off" spellCheck={false} value={key} onChange={(event) => setKey(event.target.value)} placeholder={info.hint} className={cn(FIELD, "w-44 font-mono")} />
          <Button size="sm" variant="primary" type="submit" disabled={!key.trim() || save.isPending}>
            Speichern
          </Button>
        </form>
      )}
    </SettingLine>
  );
}
