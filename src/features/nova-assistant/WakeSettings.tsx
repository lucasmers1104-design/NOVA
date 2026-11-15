import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { CircleCheck, Ear, Eraser, Gamepad2, Hand, MessageCircle, Minus, Play, Square, TriangleAlert, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PreviewStage, SegmentedControl, SettingCard, SettingLine } from "@/components/settings-kit";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { MoreOptions, PrivacyNote, SettingsNotice, SettingsSection } from "@/features/settings/SettingsLayout";
import { cn } from "@/lib/cn";
import { isDesktop } from "@/lib/native";
import { ASSISTANT_STATUS_KEY, assistantStatus } from "./api";
import { NovaDot } from "./components/NovaDot";
import { ASSISTANT_EVENTS, DEFAULT_DOT_LOOK, type DotLook } from "./types";
import { openVoiceSettings } from "./voice";
import { type AfterWake, configureWake, describeHeard, type Heard, listenerLabel, testWake, type WakeListener, type WakePrefs, type WakeSensitivity, type WakeStatus, wakeStatus } from "./wake";

export const WAKE_STATUS_KEY = ["wake", "status"] as const;

const TITLE = "Hey NOVA & Klatschen";
const DESCRIPTION = "Weck NOVA AI, ohne etwas anzufassen: Sag „Hey NOVA“ oder klatsch zweimal.";

const PHRASE_SENSITIVITY = [
  { value: "strict", label: "Nur wenn eindeutig" },
  { value: "normal", label: "Großzügiger" },
] as const satisfies readonly { value: WakeSensitivity; label: string }[];

const CLAP_SENSITIVITY = [
  { value: "strict", label: "Sehr genau" },
  { value: "normal", label: "Großzügiger" },
] as const satisfies readonly { value: WakeSensitivity; label: string }[];

const AFTER_WAKE = [
  { value: "listen", label: "Gleich zuhören" },
  { value: "open", label: "Nur NOVA AI öffnen" },
] as const satisfies readonly { value: AfterWake; label: string }[];

/** Settings → Hey NOVA & Klatschen. Off until turned on; the listener runs in Rust. */
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

  if (!desktop) {
    return (
      <SettingsSection id="wake" title={TITLE} description={DESCRIPTION} icon={Ear}>
        <SettingsNotice>Das gibt es in der NOVA-Desktop-App.</SettingsNotice>
      </SettingsSection>
    );
  }

  const prefs = status?.prefs;
  const busy = !status || configure.isPending;
  return (
    <SettingsSection id="wake" title={TITLE} description={DESCRIPTION} icon={Ear}>
      <WakeTest testing={status?.testing ?? false} clap={prefs?.clap ?? false} />

      <SettingCard title="„Hey NOVA“" description="Windows erkennt die zwei Wörter offline, auf diesem PC." icon={MessageCircle}>
        <SettingLine label="Mit „Hey NOVA“ wecken" description={<ListenerLine listener={status?.phrase} on={prefs?.phrase} onResume={() => update({ muted: false })} />}>
          <Switch label="Mit „Hey NOVA“ wecken" checked={prefs?.phrase ?? false} disabled={busy} onChange={(phrase) => update({ phrase })} />
        </SettingLine>
        {prefs?.phrase && (
          <SettingLine label="Wie sicher NOVA sein muss" description="„Nur wenn eindeutig“ überhört alles, bei dem Windows sich nicht sicher ist.">
            <SegmentedControl label="Wie sicher NOVA sein muss" value={prefs.phraseSensitivity} options={PHRASE_SENSITIVITY} onChange={(phraseSensitivity) => update({ phraseSensitivity })} />
          </SettingLine>
        )}
      </SettingCard>

      <SettingCard title="Doppelklatschen" description="Zweimal kurz und scharf klatschen, etwa eine halbe Sekunde auseinander und gleich laut, dann einen Moment still sein." icon={Hand}>
        <SettingLine label="Mit Doppelklatschen wecken" description={<ListenerLine listener={status?.clap} on={prefs?.clap} onResume={() => update({ muted: false })} />}>
          <Switch label="Mit Doppelklatschen wecken" checked={prefs?.clap ?? false} disabled={busy} onChange={(clap) => update({ clap })} />
        </SettingLine>
        {prefs?.clap && (
          <SettingLine label="Klatsch-Erkennung" description="„Sehr genau“ braucht zwei saubere Klatscher im Abstand einer Viertel- bis halben Sekunde, gleich laut und mit Ruhe drumherum. Reden, Musik, Tippen, Klopfen und einzelnes Klatschen zählen nie.">
            <SegmentedControl label="Klatsch-Erkennung" value={prefs.clapSensitivity} options={CLAP_SENSITIVITY} onChange={(clapSensitivity) => update({ clapSensitivity })} />
          </SettingLine>
        )}
      </SettingCard>

      <SettingCard title="Danach" icon={Zap}>
        <SettingLine
          label="Nach dem Wecken"
          description={
            prefs?.afterWake === "listen" && status && !status.dictation ? (
              <span>
                Zuhören braucht die Online-Spracherkennung von Windows, und die ist aus. Bis dahin öffnet sich NOVA AI bereit zum Tippen.{" "}
                <button type="button" className="font-medium text-accent-text hover:underline" onClick={() => openVoiceSettings("privacy-speech")}>
                  Einschalten
                </button>
              </span>
            ) : (
              "NOVA AI öffnet sich neben dem Punkt."
            )
          }
        >
          <SegmentedControl label="Nach dem Wecken" value={prefs?.afterWake ?? "listen"} options={AFTER_WAKE} onChange={(afterWake) => update({ afterWake })} />
        </SettingLine>
      </SettingCard>

      <MoreOptions title="Ton und Spiele" description="Der Ton beim Wecken, und ob NOVA auch im Spiel zuhört." icon={Gamepad2}>
        <SettingLine label="Ton beim Wecken" description="Ein kurzer Zweiklang, sobald NOVA wach ist.">
          <Switch label="Ton beim Wecken" checked={prefs?.chime ?? true} disabled={busy} onChange={(chime) => update({ chime })} />
        </SettingLine>
        <SettingLine label="Auch in Spielen" description="NOVA reagiert auch, während ein Spiel oder eine andere Vollbild-App läuft, und antwortet dann nur mit der Stimme, ohne Fenster. Kommt der Spielton aus Lautsprechern, kann es versehentlich aufwachen, und es kostet etwas Leistung. Präsentationen pausieren es immer.">
          <Switch label="Auch in Spielen" checked={prefs?.inGames ?? true} disabled={busy} onChange={(inGames) => update({ inGames })} />
        </SettingLine>
      </MoreOptions>

      <PrivacyNote>
        Solange eins von beiden an ist, bleibt das Mikrofon offen, und Windows zeigt sein Mikrofon-Symbol. Der Ton wird auf diesem PC geprüft, während er ankommt, und nie aufgenommen, gespeichert oder gesendet. „Hey NOVA“ erkennt Windows offline. Ist der PC gesperrt, pausiert das Zuhören.
      </PrivacyNote>
    </SettingsSection>
  );
}

function ListenerLine({ listener, on, onResume }: { listener: WakeListener | undefined; on: boolean | undefined; onResume: () => void }) {
  if (!listener || !on) return <>Aus</>;
  const tone = listener.state === "listening" ? "text-success" : listener.state === "unavailable" ? "text-danger" : "text-fg-muted";
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-1.5", tone)} role="status">
      {listener.state === "listening" && <span className="size-1.5 animate-[nova-pulse_2s_ease-in-out_3] rounded-full bg-success" aria-hidden />}
      {listenerLabel(listener)}
      {listener.state === "paused" && listener.reason === "muted" && (
        <button type="button" data-records className="font-medium text-accent-text hover:underline" onClick={onResume}>
          Fortsetzen
        </button>
      )}
      {listener.state === "unavailable" && listener.settings && (
        <button type="button" className="font-medium text-accent-text hover:underline" onClick={() => openVoiceSettings(listener.settings!)}>
          Einstellungen öffnen
        </button>
      )}
    </span>
  );
}

/** How long a test runs; the listener ends it on the Rust side. */
const TEST_MS = 120_000;
/** How long the dot shows that it would have woken. */
const WOKEN_MS = 1300;

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

/** The user's own dot, large enough to watch from across the desk, with its ring always shown. */
function stageLook(look: DotLook | undefined): DotLook {
  return { ...(look ?? DEFAULT_DOT_LOOK), diameter: 56, idleOpacity: 100, activity: true };
}

/**
 * Two minutes of "what NOVA hears", on a stage: the dot follows the microphone and
 * shows when it would have woken, and nothing opens meanwhile.
 */
function WakeTest({ testing, clap }: { testing: boolean; clap: boolean }) {
  const client = useQueryClient();
  const { data: assistant } = useQuery({ queryKey: ASSISTANT_STATUS_KEY, queryFn: assistantStatus });
  const [level, setLevel] = useState(0);
  const [log, setLog] = useState<LogLine[]>([]);
  const [now, setNow] = useState(0);
  const [woken, setWoken] = useState(false);
  const next = useRef(0);
  const started = useRef(0);
  const start = useMutation({ mutationFn: testWake, onSuccess: (status) => client.setQueryData(WAKE_STATUS_KEY, status) });

  useEffect(() => {
    if (!testing) {
      setLevel(0);
      setNow(0);
      setWoken(false);
      started.current = 0;
      return;
    }
    started.current = Date.now();
    setNow(started.current);
    let calm: ReturnType<typeof setTimeout> | undefined;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const unlisten = listen<Heard>(ASSISTANT_EVENTS.wakeHeard, (event) => {
      if (event.payload.kind === "level") {
        setLevel(event.payload.value);
        return;
      }
      const line = describeHeard(event.payload);
      if (!line) return;
      setLog((lines) => [{ id: next.current++, at: Date.now() - started.current, ...line }, ...lines].slice(0, 8));
      if (line.tone === "good") {
        setWoken(true);
        clearTimeout(calm);
        calm = setTimeout(() => setWoken(false), WOKEN_MS);
      }
    });
    return () => {
      clearInterval(tick);
      clearTimeout(calm);
      void unlisten.then((stop) => stop());
    };
  }, [testing]);

  // Leaving the page ends the test.
  useEffect(() => () => void testWake(false).catch(() => {}), []);

  const left = TEST_MS - (now - started.current);
  const latest = log[0];
  return (
    <div className="space-y-3">
      <PreviewStage
        label="Probelauf: was NOVA hört"
        backdrop="dusk"
        height={236}
        corner={
          <span className="flex items-center gap-2.5">
            <Button
              size="sm"
              variant={testing ? "secondary" : "primary"}
              icon={testing ? <Square size={11} aria-hidden /> : <Play size={13} aria-hidden />}
              onClick={() => {
                if (!testing) setLog([]);
                start.mutate(!testing);
              }}
            >
              {testing ? "Stopp" : "Probelauf starten"}
            </Button>
            {testing && <span className="rounded-full bg-black/45 px-2 py-0.5 text-[12px] text-white/80 tabular-nums backdrop-blur-md">noch {clock(left)}</span>}
          </span>
        }
      >
        <div className="flex h-full flex-col items-center justify-center gap-4 px-6 pb-8 text-center">
          {/* A picture of the dot at work: nothing to click, so it is no stop for the keyboard. */}
          <div inert className="flex">
            <NovaDot look={stageLook(assistant?.look)} open={false} state={woken ? "completed" : testing ? "listening" : "idle"} level={Math.min(1, Math.sqrt(level))} onToggle={() => {}} onMenu={() => {}} onDragStart={() => {}} />
          </div>
          <p className={cn("max-w-md text-[13px] leading-relaxed", testing && latest ? TONE_CLASS[latest.tone] : "text-white/75")}>
            {testing ? (latest?.text ?? "Sag „Hey NOVA“ oder klatsch zweimal. Oder rede und tipp, um zu sehen, was überhört wird.") : "Zwei Minuten lang siehst du hier, was NOVA hört. Dabei öffnet sich nichts."}
          </p>
        </div>
        {testing && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-white/[0.08]" role="meter" aria-label="Mikrofonpegel" aria-valuemin={0} aria-valuemax={1} aria-valuenow={level}>
            <div className="h-full bg-accent transition-[width] duration-100 ease-out" style={{ width: `${Math.min(100, Math.sqrt(level) * 100)}%` }} />
          </div>
        )}
      </PreviewStage>

      {clap && (
        <p className="flex items-start gap-1.5 px-1 text-[12px] leading-relaxed text-fg-subtle">
          <Hand size={13} className="mt-0.5 shrink-0" aria-hidden />
          So klatschst du: zweimal kurz und scharf mit flachen Händen, etwa eine halbe Sekunde auseinander und gleich laut. Dann einen Moment still sein.
        </p>
      )}

      {(testing || log.length > 0) && (
        <SettingCard
          title="Was NOVA gehört hat"
          description="Das Neueste steht oben."
          actions={
            log.length > 0 && (
              <Button size="sm" variant="ghost" icon={<Eraser size={12} aria-hidden />} onClick={() => setLog([])}>
                Leeren
              </Button>
            )
          }
        >
          <ol className="space-y-1" aria-live="polite" aria-label="Was NOVA gehört hat">
            {log.length === 0 && <li className="text-[12.5px] text-fg-subtle">NOVA hört zu …</li>}
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
        </SettingCard>
      )}
    </div>
  );
}
