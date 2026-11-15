import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LockOpen } from "lucide-react";
import { useState } from "react";
import { SettingCard, SettingLine } from "@/components/settings-kit";
import { Button } from "@/components/ui/Button";
import { callNative, isDesktop } from "@/lib/native";

/** Mirrors `DevKeyStatus` in src-tauri/src/devkey.rs. */
export interface DevKeyStatus {
  unlocked: boolean;
  lockedModel: string;
}

export const DEV_KEY = ["dev-key"];
/** The one model NOVA AI uses without the developer key; the native side says it too. */
export const LOCKED_MODEL = "claude-haiku-5-5";

export function useDevKey() {
  return useQuery({ queryKey: DEV_KEY, queryFn: () => callNative<DevKeyStatus>("dev_key_status"), enabled: isDesktop(), staleTime: Number.POSITIVE_INFINITY });
}

/** Whether NOVA AI is held to Claude Haiku here: in the desktop app without the developer key. */
export function useAiLocked(): boolean {
  const { data } = useDevKey();
  return isDesktop() && data?.unlocked !== true;
}

/** Settings → Über NOVA: the developer key, which lifts the model lock and the Discord cooldowns. */
export function DevKeyCard() {
  const client = useQueryClient();
  const { data } = useDevKey();
  const [key, setKey] = useState("");
  const save = useMutation({
    mutationFn: (value: string) => callNative<DevKeyStatus>("dev_key_set", { key: value }),
    onSuccess: (status) => {
      client.setQueryData(DEV_KEY, status);
      // Model lists and the relay's cooldowns depend on it.
      void client.invalidateQueries({ queryKey: ["ai"] });
      void client.invalidateQueries({ queryKey: ["relay"] });
      setKey("");
    },
  });

  if (!isDesktop()) return null;
  const unlocked = data?.unlocked ?? false;
  return (
    <SettingCard title="Entwickler" icon={unlocked ? LockOpen : KeyRound}>
      {unlocked ? (
        <SettingLine label="Entwickler-Schlüssel" description="Aktiv: alle Modelle und Anbieter, keine Discord-Pausen.">
          <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate("")}>
            Entfernen
          </Button>
        </SettingLine>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (key.trim()) save.mutate(key);
          }}
        >
          <SettingLine label="Entwickler-Schlüssel" htmlFor="dev-key" description={save.isError ? <span className="text-warning">{String(save.error)}</span> : "Hebt die Grenzen auf: andere KI-Modelle als Claude Haiku und die Pausen bei Discord."}>
            <span className="flex items-center gap-2">
              <input
                id="dev-key"
                type="password"
                autoComplete="off"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="novadev_…"
                className="h-9 w-56 rounded-lg border border-line bg-white/[0.04] px-3 text-[13px] text-fg outline-none placeholder:text-fg-subtle focus:border-accent/60"
              />
              <Button size="sm" variant="secondary" type="submit" disabled={!key.trim() || save.isPending}>
                Prüfen
              </Button>
            </span>
          </SettingLine>
        </form>
      )}
    </SettingCard>
  );
}
