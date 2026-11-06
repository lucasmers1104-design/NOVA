import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Play } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { aiKeys } from "@/features/ai/api";
import { notifyError } from "@/features/notifications/store";
import { SettingRow } from "@/features/settings/SettingsLayout";
import { callNative, isDesktop } from "@/lib/native";
import { isOnlineVoice, useVoice } from "./voice";

/** Google's voices, all of which speak German (the model picks up the language from the text). */
export const GEMINI_VOICES = [
  { id: "Sulafat", name: "Sulafat, warm" },
  { id: "Achird", name: "Achird, friendly" },
  { id: "Kore", name: "Kore, firm" },
  { id: "Puck", name: "Puck, upbeat" },
  { id: "Aoede", name: "Aoede, breezy" },
  { id: "Charon", name: "Charon, informative" },
  { id: "Leda", name: "Leda, youthful" },
  { id: "Fenrir", name: "Fenrir, excitable" },
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
    help: "Free of charge within Google's limits (see your limits in Google AI Studio). No credit card needed. What NOVA says goes to Google, and this key also lets NOVA AI answer with Gemini.",
    save: (key: string) => callNative<void>("ai_key_set", { provider: "gemini", key }),
    hint: "AIza…",
  },
  elevenlabs: {
    name: "ElevenLabs",
    url: "https://elevenlabs.io/app/settings/api-keys",
    help: "10,000 free credits a month, about 20,000 characters with the fast voice NOVA uses. No credit card needed. What NOVA says goes to ElevenLabs.",
    save: (key: string) => callNative<void>("elevenlabs_key_set", { key }),
    hint: "sk_…",
  },
} as const;

type Service = keyof typeof SERVICES;

export function serviceOf(voice: string): Service {
  return voice.split(":")[1] === "elevenlabs" ? "elevenlabs" : "gemini";
}

/** Settings → Local AI & performance: the online voices beside NOVA's own, with their keys. */
export function OnlineVoiceList({ current, onChoose, onListen }: { current: string; onChoose: (voice: string) => void; onListen: (voice: string) => void }) {
  const { keys, elevenlabs } = useOnlineVoices();
  const problem = useVoice((s) => s.onlineVoiceProblem);
  const services: readonly { service: Service; voices: readonly { id: string; name: string }[] }[] = [
    { service: "gemini", voices: GEMINI_VOICES },
    { service: "elevenlabs", voices: elevenlabs },
  ];
  return (
    <div className="py-4">
      <div className="text-[13.5px] font-medium text-fg">Online voices</div>
      <p className="mt-0.5 text-[12.5px] text-fg-muted">The most natural voices. They need the internet and a free key. If one fails, NOVA's own voice takes over.</p>
      {problem && isOnlineVoice(current) && <p className="mt-2 text-[12px] text-warning">The online voice didn't work, so another one took over: {problem}</p>}
      {services.map(({ service, voices }) => (
        <div key={service} className="mt-3">
          <OnlineVoiceKeyRow service={service} />
          <ul className="space-y-1.5">
            {voices.map((voice) => {
              const value = `online:${service}:${voice.id}`;
              const usable = keys?.[service] ?? false;
              return (
                <li key={value} className="flex items-center justify-between gap-3 rounded-[12px] border border-line bg-white/[0.02] px-3 py-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[13px] text-fg">
                    {voice.name}
                    {current === value && <Badge tone="accent">NOVA's voice</Badge>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <IconButton size="sm" label={`Listen to ${voice.name}`} disabled={!usable} onClick={() => onListen(value)}>
                      <Play size={14} aria-hidden />
                    </IconButton>
                    {current !== value && (
                      <Button size="sm" variant="ghost" disabled={!usable} onClick={() => onChoose(value)}>
                        Use
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
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
    },
    onError: (error) => notifyError("Couldn't save the key", error),
  });
  const configured = keys?.[service] ?? false;

  return (
    <SettingRow
      label={`${info.name} key`}
      description={
        <>
          {info.help}{" "}
          <button type="button" onClick={() => void callNative("open_url", { url: info.url })} className="inline-flex items-center gap-1 text-fg-subtle hover:text-accent-text">
            Get a key <ExternalLink size={11} aria-hidden />
          </button>
        </>
      }
    >
      {configured ? (
        <div className="flex items-center gap-1.5">
          <Badge tone="success">Key saved</Badge>
          {/* The Gemini key belongs to AI providers, where it can be removed. */}
          {service === "elevenlabs" && (
            <Button size="sm" variant="ghost" className="hover:text-danger" onClick={() => void callNative("elevenlabs_key_delete").then(refresh, (error: unknown) => notifyError("Couldn't remove the key", error))}>
              Remove
            </Button>
          )}
        </div>
      ) : (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <input
            type="password"
            aria-label={`${info.name} API key`}
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={info.hint}
            className="h-9 w-44 rounded-control border border-line bg-black/25 px-3 font-mono text-[13px] text-fg outline-none placeholder:text-fg-subtle focus:border-line-strong"
          />
          <Button size="sm" variant="primary" type="submit" disabled={!key.trim() || save.isPending}>
            Save
          </Button>
        </form>
      )}
    </SettingRow>
  );
}
