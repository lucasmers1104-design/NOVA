import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { CircleCheck, Ear, Eraser, Hand, Minus, ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { MoreOptions, SettingRow, SettingsSection } from "@/features/settings/SettingsLayout";
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
      <SettingRow label="Wake with “Hey NOVA”" description={<ListenerLine listener={status?.phrase} on={prefs?.phrase} onResume={() => update({ muted: false })} />}>
        <Switch label="Wake with Hey NOVA" checked={prefs?.phrase ?? false} disabled={busy} onChange={(phrase) => update({ phrase })} />
      </SettingRow>
      {prefs?.phrase && (
        <SettingRow label="How sure NOVA must be" description="“Only when clear” ignores anything Windows isn't confident about.">
          <SegmentedControl label="Hey NOVA sensitivity" value={prefs.phraseSensitivity} options={PHRASE_SENSITIVITY} onChange={(phraseSensitivity) => update({ phraseSensitivity })} />
        </SettingRow>
      )}
      <SettingRow label="Wake with a double clap" description={<ListenerLine listener={status?.clap} on={prefs?.clap} onResume={() => update({ muted: false })} />}>
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
      <MoreOptions label="Sound and games">
      <SettingRow label="Play a sound when NOVA wakes">
        <Switch label="Play a sound when NOVA wakes" checked={prefs?.chime ?? true} disabled={busy} onChange={(chime) => update({ chime })} />
      </SettingRow>
      <SettingRow label="Also in games" description="NOVA also reacts while a game or another fullscreen app runs. It answers by voice, without its window. With a game's sound on loudspeakers it can wake by mistake, and it costs a little performance. Presentations always pause it.">
        <Switch label="Also in games" checked={prefs?.inGames ?? true} disabled={busy} onChange={(inGames) => update({ inGames })} />
      </SettingRow>
      </MoreOptions>
      <WakeTest testing={status?.testing ?? false} clap={prefs?.clap ?? false} />
      <p className="flex items-start gap-2 pt-4 text-[12.5px] leading-relaxed text-fg-muted">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-success" aria-hidden />
        While one of these is on, the microphone stays open and Windows shows its microphone icon. The sound is checked on this PC as it comes in and is never
        recorded, saved or sent. “Hey NOVA” is recognized offline by Windows. Listening pauses while the PC is locked.
      </p>
    </SettingsSection>
  );
}

function ListenerLine({ listener, on, onResume }: { listener: WakeListener | undefined; on: boolean | undefined; onResume: () => void }) {
  if (!listener || !on) return <>Off</>;
  const tone = listener.state === "listening" ? "text-success" : listener.state === "unavailable" ? "text-danger" : "text-fg-muted";
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-1.5", tone)} role="status">
      {listener.state === "listening" && <span className="size-1.5 animate-[nova-pulse_2s_ease-in-out_3] rounded-full bg-success" aria-hidden />}
      {listenerLabel(listener)}
      {listener.state === "paused" && listener.reason === "muted" && (
        <button type="button" className="font-medium text-accent-text hover:underline" onClick={onResume}>
          Resume
        </button>
      )}
      {listener.state === "unavailable" && listener.settings && (
        <button type="button" className="font-medium text-accent-text hover:underline" onClick={() => openVoiceSettings(listener.settings!)}>
          Open settings
        </button>
      )}
    </span>
  );
}

/** How long a test runs; the listener ends it on the Rust side. */
const TEST_MS = 120_000;

/** "1:05" for 65 seconds. */
function clock(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

interface LogLine {
  id: number;
  /** Time since the test started. */
  at: number;
  text: string;
  tone: "good" | "muted" | "warn";
}

const TONE_ICON = { good: CircleCheck, muted: Minus, warn: TriangleAlert } as const;
const TONE_CLASS = { good: "font-medium text-success", muted: "text-fg-muted", warn: "text-warning" } as const;

/** Two minutes of "what NOVA hears", without opening anything. */
function WakeTest({ testing, clap }: { testing: boolean; clap: boolean }) {
  const client = useQueryClient();
  const [level, setLevel] = useState(0);
  const [log, setLog] = useState<LogLine[]>([]);
  const [now, setNow] = useState(0);
  const next = useRef(0);
  const started = useRef(0);
  const start = useMutation({ mutationFn: testWake, onSuccess: (status) => client.setQueryData(WAKE_STATUS_KEY, status) });

  useEffect(() => {
    if (!testing) {
      setLevel(0);
      setNow(0);
      started.current = 0;
      return;
    }
    started.current = Date.now();
    setNow(started.current);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const unlisten = listen<Heard>(ASSISTANT_EVENTS.wakeHeard, (event) => {
      if (event.payload.kind === "level") {
        setLevel(event.payload.value);
        return;
      }
      const line = describeHeard(event.payload);
      if (line) setLog((lines) => [{ id: next.current++, at: Date.now() - started.current, ...line }, ...lines].slice(0, 8));
    });
    return () => {
      clearInterval(tick);
      void unlisten.then((stop) => stop());
    };
  }, [testing]);

  // Leaving the page ends the test.
  useEffect(() => () => void testWake(false).catch(() => {}), []);

  const left = TEST_MS - (now - started.current);
  return (
    <div className="mt-3 rounded-[16px] border border-line bg-white/[0.025] p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <p className="text-[13.5px] font-medium text-fg">
            Try it
            {testing && (
              <span className="ml-2 text-[12px] font-normal text-fg-subtle tabular-nums">
                {clock(left)} left
              </span>
            )}
          </p>
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
      {clap && (
        <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed text-fg-subtle">
          <Hand size={13} className="mt-0.5 shrink-0" aria-hidden />
          How to clap: two short, sharp claps with flat hands, about half a second apart and equally loud — then stay quiet for a moment.
        </p>
      )}
      {testing && (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={level}>
            <div className="h-full rounded-full bg-accent transition-[width] duration-100 ease-out" style={{ width: `${Math.min(100, Math.sqrt(level) * 100)}%` }} />
          </div>
        </div>
      )}
      {(testing || log.length > 0) && (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11.5px] font-medium tracking-wide text-fg-subtle uppercase">What NOVA heard</p>
            {log.length > 0 && (
              <button type="button" className="flex items-center gap-1 text-[12px] font-medium text-fg-muted hover:text-fg" onClick={() => setLog([])}>
                <Eraser size={12} aria-hidden /> Clear
              </button>
            )}
          </div>
          <ol className="mt-1.5 space-y-1" aria-live="polite" aria-label="What NOVA heard">
            {log.length === 0 && <li className="text-[12px] text-fg-subtle">Listening…</li>}
            {log.map((line) => {
              const Icon = TONE_ICON[line.tone];
              return (
                <li key={line.id} className={cn("flex items-start gap-2 text-[12.5px]", TONE_CLASS[line.tone])}>
                  <span className="w-9 shrink-0 text-right text-[11.5px] font-normal text-fg-subtle tabular-nums">{clock(line.at)}</span>
                  <Icon size={13} className="mt-[3px] shrink-0" aria-hidden />
                  <span className="min-w-0">{line.text}</span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
