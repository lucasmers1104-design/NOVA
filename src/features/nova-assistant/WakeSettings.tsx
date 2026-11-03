import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { Ear, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { SettingRow, SettingsSection } from "@/features/settings/SettingsLayout";
import { cn } from "@/lib/cn";
import { isDesktop } from "@/lib/native";
import { ASSISTANT_EVENTS } from "./types";
import { openVoiceSettings } from "./voice";
import { type AfterWake, configureWake, describeHeard, type Heard, listenerLabel, testWake, type WakeListener, type WakePrefs, type WakeSensitivity, type WakeStatus, wakeStatus } from "./wake";

export const WAKE_STATUS_KEY = ["wake", "status"] as const;

const PHRASE_SENSITIVITY = [
  { value: "strict", label: "Only when clear" },
  { value: "normal", label: "More forgiving" },
] as const satisfies readonly { value: WakeSensitivity; label: string }[];

const CLAP_SENSITIVITY = [
  { value: "strict", label: "Very precise" },
  { value: "normal", label: "More forgiving" },
] as const satisfies readonly { value: WakeSensitivity; label: string }[];

const AFTER_WAKE = [
  { value: "listen", label: "Listen for my request" },
  { value: "open", label: "Just open NOVA AI" },
] as const satisfies readonly { value: AfterWake; label: string }[];

/** Settings → Hey NOVA & double clap. Off until turned on; the listener runs in Rust. */
export function WakeSettings() {
  const desktop = isDesktop();
  const client = useQueryClient();
  const { data: status } = useQuery({ queryKey: WAKE_STATUS_KEY, queryFn: wakeStatus, enabled: desktop });
  const configure = useMutation({
    mutationFn: configureWake,
    onSuccess: (next) => client.setQueryData(WAKE_STATUS_KEY, next),
  });

  useEffect(() => {
    if (!desktop) return;
    const unlisten = listen<WakeStatus>(ASSISTANT_EVENTS.wakeStatus, (event) => client.setQueryData(WAKE_STATUS_KEY, event.payload));
    return () => void unlisten.then((stop) => stop());
  }, [client, desktop]);

  const update = (patch: Partial<WakePrefs>) => {
    if (status) configure.mutate({ ...status.prefs, ...patch });
  };

  const description = "Wake NOVA AI hands-free: say “Hey NOVA” or clap twice.";
  if (!desktop) {
    return (
      <SettingsSection id="wake" title="Hey NOVA & double clap" description={description} icon={Ear}>
        <p className="text-[13px] text-fg-muted">Available in the NOVA desktop app.</p>
      </SettingsSection>
    );
  }

  const prefs = status?.prefs;
  const busy = !status || configure.isPending;
  return (
    <SettingsSection id="wake" title="Hey NOVA & double clap" description={description} icon={Ear}>
      <SettingRow label="Wake with “Hey NOVA”" description={<ListenerLine listener={status?.phrase} on={prefs?.phrase} />}>
        <Switch label="Wake with Hey NOVA" checked={prefs?.phrase ?? false} disabled={busy} onChange={(phrase) => update({ phrase })} />
      </SettingRow>
      {prefs?.phrase && (
        <SettingRow label="How sure NOVA must be" description="“Only when clear” ignores anything Windows isn't confident about.">
          <SegmentedControl label="Hey NOVA sensitivity" value={prefs.phraseSensitivity} options={PHRASE_SENSITIVITY} onChange={(phraseSensitivity) => update({ phraseSensitivity })} />
        </SettingRow>
      )}
      <SettingRow label="Wake with a double clap" description={<ListenerLine listener={status?.clap} on={prefs?.clap} />}>
        <Switch label="Wake with a double clap" checked={prefs?.clap ?? false} disabled={busy} onChange={(clap) => update({ clap })} />
      </SettingRow>
      {prefs?.clap && (
        <SettingRow
          label="Clap detection"
          description="“Very precise” needs two crisp claps a quarter to half a second apart, equally loud, with quiet around them. Talking, music, typing, knocks and single claps never count."
        >
          <SegmentedControl label="Clap sensitivity" value={prefs.clapSensitivity} options={CLAP_SENSITIVITY} onChange={(clapSensitivity) => update({ clapSensitivity })} />
        </SettingRow>
      )}
      <SettingRow
        label="After waking"
        description={
          prefs?.afterWake === "listen" && status && !status.dictation ? (
            <span>
              Listening needs Windows' online speech recognition, which is off — until then NOVA AI opens ready to type.{" "}
              <button type="button" className="font-medium text-accent-text hover:underline" onClick={() => openVoiceSettings("privacy-speech")}>
                Turn it on
              </button>
            </span>
          ) : (
            "NOVA AI opens next to the dot."
          )
        }
      >
        <SegmentedControl label="After waking" value={prefs?.afterWake ?? "listen"} options={AFTER_WAKE} onChange={(afterWake) => update({ afterWake })} />
      </SettingRow>
      <SettingRow label="Play a sound when NOVA wakes">
        <Switch label="Play a sound when NOVA wakes" checked={prefs?.chime ?? true} disabled={busy} onChange={(chime) => update({ chime })} />
      </SettingRow>
      <SettingRow label="Pause in fullscreen apps and games" description="Films and games are full of voices and claps.">
        <Switch label="Pause in fullscreen apps and games" checked={prefs?.pauseInFullscreen ?? true} disabled={busy} onChange={(pauseInFullscreen) => update({ pauseInFullscreen })} />
      </SettingRow>
      <WakeTest testing={status?.testing ?? false} />
      <p className="flex items-start gap-2 pt-4 text-[12.5px] leading-relaxed text-fg-muted">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-success" aria-hidden />
        While one of these is on, the microphone stays open and Windows shows its microphone icon. The sound is checked on this PC as it comes in and is never
        recorded, saved or sent. “Hey NOVA” is recognized offline by Windows. Listening pauses while the PC is locked.
      </p>
    </SettingsSection>
  );
}

function ListenerLine({ listener, on }: { listener: WakeListener | undefined; on: boolean | undefined }) {
  if (!listener || !on) return <>Off</>;
  const tone = listener.state === "listening" ? "text-success" : listener.state === "unavailable" ? "text-danger" : "text-fg-muted";
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-1.5", tone)} role="status">
      {listener.state === "listening" && <span className="size-1.5 animate-[nova-pulse_2s_ease-in-out_3] rounded-full bg-success" aria-hidden />}
      {listenerLabel(listener)}
      {listener.state === "unavailable" && listener.settings && (
        <button type="button" className="font-medium text-accent-text hover:underline" onClick={() => openVoiceSettings(listener.settings!)}>
          Open settings
        </button>
      )}
    </span>
  );
}

interface LogLine {
  id: number;
  text: string;
  tone: "good" | "muted" | "warn";
}

/** Two minutes of "what NOVA hears", without opening anything. */
function WakeTest({ testing }: { testing: boolean }) {
  const client = useQueryClient();
  const [level, setLevel] = useState(0);
  const [log, setLog] = useState<LogLine[]>([]);
  const next = useRef(0);
  const start = useMutation({ mutationFn: testWake, onSuccess: (status) => client.setQueryData(WAKE_STATUS_KEY, status) });

  useEffect(() => {
    if (!testing) {
      setLevel(0);
      return;
    }
    const unlisten = listen<Heard>(ASSISTANT_EVENTS.wakeHeard, (event) => {
      if (event.payload.kind === "level") {
        setLevel(event.payload.value);
        return;
      }
      const line = describeHeard(event.payload);
      if (line) setLog((lines) => [{ id: next.current++, ...line }, ...lines].slice(0, 8));
    });
    return () => void unlisten.then((stop) => stop());
  }, [testing]);

  // Leaving the page ends the test.
  useEffect(() => () => void testWake(false).catch(() => {}), []);

  return (
    <div className="mt-3 rounded-[16px] border border-line bg-white/[0.025] p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[13.5px] font-medium text-fg">Try it</p>
          <p className="mt-0.5 text-[12.5px] text-fg-muted">
            {testing ? "Say “Hey NOVA”, clap twice — or talk and type to see what's ignored. Nothing opens during the test." : "Shows what NOVA hears for two minutes."}
          </p>
        </div>
        <Button
          size="sm"
          variant={testing ? "secondary" : "primary"}
          onClick={() => {
            if (!testing) setLog([]);
            start.mutate(!testing);
          }}
        >
          {testing ? "Stop" : "Start test"}
        </Button>
      </div>
      {testing && (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={level}>
            <div className="h-full rounded-full bg-accent transition-[width] duration-100 ease-out" style={{ width: `${Math.min(100, Math.sqrt(level) * 100)}%` }} />
          </div>
          <ol className="mt-3 space-y-1" aria-live="polite" aria-label="What NOVA heard">
            {log.length === 0 && <li className="text-[12px] text-fg-subtle">Listening…</li>}
            {log.map((line) => (
              <li key={line.id} className={cn("text-[12.5px]", line.tone === "good" ? "font-medium text-success" : line.tone === "warn" ? "text-warning" : "text-fg-muted")}>
                {line.text}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
