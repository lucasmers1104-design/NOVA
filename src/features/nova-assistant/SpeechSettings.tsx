import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Cpu, Download, Gauge, HardDrive, Mic, Trash, Zap } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { ChoiceCards, SegmentedControl, SettingCard, SettingLine } from "@/components/settings-kit";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { notifyError } from "@/features/notifications/store";
import { FIELD, SettingsNotice, SettingsSection } from "@/features/settings/SettingsLayout";
import { cn } from "@/lib/cn";
import { isDesktop } from "@/lib/native";
import { agentStatus, configureAgent } from "./api";
import { OnlineVoiceList, VoiceRow } from "./OnlineVoiceSettings";
import { type BackendPref, type BenchRun, deviceLabel, formatBytes, type SpeechItem, type SpeechMode, type SpeechStatus, type SttPref, useSpeech } from "./speech/api";
import type { AgentPrefs, AgentStatus } from "./types";
import { speak, stopSpeaking } from "./voice";

const TITLE = "Sprache auf diesem PC";
const DESCRIPTION = "NOVAs eigene Stimmen und die Offline-Spracherkennung, und wo auf diesem PC sie laufen.";

const MODES: readonly { value: SpeechMode; label: string; description: string }[] = [
  { value: "auto", label: "Auto", description: "Schnell, ohne den PC zu bremsen" },
  { value: "max", label: "Volle Leistung", description: "Das Schnellste, was hier geht" },
  { value: "low", label: "Sparsam", description: "So wenig Speicher wie möglich" },
];

const MODE_HELP: Record<SpeechMode, string> = {
  auto: "Die schnellste Einstellung, bei der der PC flüssig bleibt. Die Grafikkarte kommt nur dort zum Einsatz, wo sie hier nachweislich deutlich schneller war.",
  max: "Die schnellste Einstellung, die auf diesem PC gemessen wurde. Stimmen und Erkennung bleiben geladen und sind bereit, sobald NOVA aufwacht.",
  low: "So wenig Arbeitsspeicher und Prozessorzeit wie möglich: der Prozessor mit einem Thread, und Modelle werden bald nach dem Benutzen entladen.",
};

const RECOGNITION = [
  { value: "windows", label: "Windows" },
  { value: "local", label: "Offline" },
  { value: "auto", label: "Automatisch" },
] as const satisfies readonly { value: SttPref; label: string }[];

const AGENT_KEY = ["assistant", "agent"] as const;
/** What a voice says to introduce itself. */
const SAMPLE = "Hallo, ich bin NOVA. So klinge ich mit dieser Stimme.";

function useAgentVoice() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: AGENT_KEY, queryFn: agentStatus, enabled: isDesktop() });
  const save = useMutation({
    mutationFn: configureAgent,
    onSuccess: (next: AgentStatus) => client.setQueryData(AGENT_KEY, next),
    onError: (error) => notifyError("Die Stimme ließ sich nicht ändern", error),
  });
  const prefs = query.data?.prefs;
  return { prefs, choose: (voice: string) => prefs && save.mutate({ ...prefs, voice }) };
}

/** Plays a voice's sample; a second click on the same voice stops it. */
function useAudition(prefs: AgentPrefs | undefined) {
  const [playing, setPlaying] = useState<string | null>(null);
  const current = useRef<string | null>(null);
  current.current = playing;
  // Leaving the page ends a sample that is still playing (and nothing else NOVA may be saying).
  useEffect(
    () => () => {
      if (current.current) stopSpeaking();
    },
    [],
  );
  const listen = (voice: string) => {
    if (!prefs) return;
    if (playing === voice) {
      stopSpeaking();
      setPlaying(null);
      return;
    }
    setPlaying(voice);
    void speak(SAMPLE, { ...prefs, voice }, "test").finally(() => setPlaying((now) => (now === voice ? null : now)));
  };
  return { playing, listen };
}

function installLabel(item: SpeechItem): string {
  switch (item.install.state) {
    case "downloading":
      return `Wird geladen … ${item.install.percent} %`;
    case "failed":
      return item.install.message;
    case "ready":
      return "Geladen";
    default:
      return `${formatBytes(item.size)} zum Laden`;
  }
}

function DownloadButton({ item, onInstall, onRemove, removable = true }: { item: SpeechItem; onInstall: () => void; onRemove: () => void; removable?: boolean }) {
  if (item.install.state === "ready") {
    return removable ? (
      <IconButton size="sm" label={`${item.label} entfernen`} onClick={onRemove}>
        <Trash size={14} aria-hidden />
      </IconButton>
    ) : null;
  }
  return (
    <Button size="sm" variant="ghost" icon={<Download size={14} aria-hidden />} disabled={item.install.state === "downloading"} onClick={onInstall}>
      {item.install.state === "failed" ? "Noch mal" : "Laden"}
    </Button>
  );
}

const QUALITY: Record<string, string> = { x_low: "einfach", low: "gut", medium: "natürlich", high: "am natürlichsten" };

/** Settings → Sprache auf diesem PC: NOVA's own voices and recognizer, and where they run. */
export function SpeechSettings() {
  const { status, update, install, remove, benchmark, progress } = useSpeech();
  const agent = useAgentVoice();
  const audition = useAudition(agent.prefs);
  const backendId = useId();

  if (!isDesktop()) {
    return (
      <SettingsSection id="local-ai" title={TITLE} description={DESCRIPTION} icon={Cpu}>
        <SettingsNotice>Das gibt es in der NOVA-Desktop-App.</SettingsNotice>
      </SettingsSection>
    );
  }
  if (!status) {
    return (
      <SettingsSection id="local-ai" title={TITLE} description={DESCRIPTION} icon={Cpu}>
        <SettingsNotice>NOVA sieht sich diesen PC an …</SettingsNotice>
      </SettingsSection>
    );
  }

  const runtime = status.items.find((i) => i.kind === "runtime");
  const recognizer = status.items.find((i) => i.kind === "recognizer");
  const voices = status.items.filter((i) => i.kind === "voice");
  const runtimeReady = runtime?.install.state === "ready";
  const hw = status.hardware;
  const measuredGpu = (adapter: number) => status.bench?.runs.some((r) => r.ok && r.device.kind === "directMl" && r.device.adapter === adapter) ?? false;
  const backendValue = status.prefs.backend === "directMl" ? `gpu:${status.prefs.adapter ?? hw.adapters[0]?.index ?? 0}` : status.prefs.backend;

  return (
    <SettingsSection id="local-ai" title={TITLE} description={DESCRIPTION} icon={Cpu}>
      <SettingCard title="Stimmen auf diesem PC" description="Deutsche Stimmen, die hier laufen, ganz ohne Internet. Hör sie dir an und nimm die, die dir gefällt." icon={Mic}>
        <ul data-setting="Stimmen auf diesem PC" className="space-y-1.5">
          {voices.map((voice) => {
            const value = `nova:${voice.id}`;
            return (
              <VoiceRow
                key={voice.id}
                name={voice.label}
                badges={voice.experimental && <Badge tone="warning">experimentell</Badge>}
                detail={
                  <>
                    {voice.gender === "female" ? "Weiblich" : "Männlich"} · {QUALITY[voice.quality] ?? voice.quality} · {voice.license} · {installLabel(voice)}
                    <SpeedNote status={status} item={voice.id} />
                  </>
                }
                chosen={agent.prefs?.voice === value || (voice.id === "thorsten" && agent.prefs?.voice === "")}
                playing={audition.playing === value}
                usable={voice.install.state === "ready"}
                onListen={() => audition.listen(value)}
                onChoose={() => agent.choose(value)}
              >
                <DownloadButton item={voice} removable={voice.id !== "thorsten"} onInstall={() => install(voice.id)} onRemove={() => remove(voice.id)} />
              </VoiceRow>
            );
          })}
        </ul>
        {!runtimeReady && <p className="pt-3 text-[12px] leading-relaxed text-fg-subtle">Ohne die Sprach-Laufzeit laufen Piper-Stimmen mit piper.exe auf dem Prozessor. Martin (Kokoro) braucht die Laufzeit.</p>}
      </SettingCard>

      <OnlineVoiceList current={agent.prefs?.voice ?? ""} playing={audition.playing} onChoose={agent.choose} onListen={audition.listen} />

      {recognizer && (
        <SettingCard title="Spracherkennung" icon={Activity}>
          <SettingLine
            label="Spracherkennung"
            description={
              <>
                „Windows“ nutzt dessen Online-Diktat. „Offline“ nutzt NVIDIA Parakeet auf diesem PC ({formatBytes(recognizer.size)}, {recognizer.license}), braucht die Sprach-Laufzeit und springt auch ein, wenn Windows nicht zuhören kann. {installLabel(recognizer)}
              </>
            }
          >
            <div className="flex items-center gap-1.5">
              <SegmentedControl label="Spracherkennung" value={status.prefs.stt} options={RECOGNITION} onChange={(stt) => update({ stt })} />
              <DownloadButton item={recognizer} onInstall={() => install(recognizer.id)} onRemove={() => remove(recognizer.id)} />
            </div>
          </SettingLine>
        </SettingCard>
      )}

      <SettingCard title="Leistung" description="Wie viel von diesem PC NOVAs Sprache nutzen darf." icon={Zap}>
        <div data-setting="Leistungsmodus" className="pb-3.5">
          <ChoiceCards label="Leistungsmodus" value={status.prefs.mode} options={MODES} onChange={(mode) => update({ mode })} />
          <p className="mt-2.5 text-[12px] leading-relaxed text-fg-muted">{MODE_HELP[status.prefs.mode]}</p>
        </div>
        <SettingLine
          label="Läuft auf"
          htmlFor={backendId}
          description={
            status.directmlBlocked
              ? `Die Grafikkarte ist aus: ${status.directmlBlocked}.`
              : status.bench
                ? "„Automatisch“ nimmt, was auf diesem PC als schneller gemessen wurde."
                : "Miss einmal, damit NOVA wählen kann. Bis dahin läuft alles auf dem Prozessor."
          }
          disabled={status.prefs.mode === "low"}
        >
          <select
            id={backendId}
            className={cn(FIELD, "max-w-72")}
            value={backendValue}
            disabled={status.prefs.mode === "low"}
            onChange={(event) => {
              const value = event.target.value;
              if (value.startsWith("gpu:")) update({ backend: "directMl" satisfies BackendPref, adapter: Number(value.slice(4)) });
              else update({ backend: value as BackendPref, adapter: null });
            }}
          >
            <option value="auto">Automatisch</option>
            <option value="cpu">Prozessor</option>
            {hw.adapters.map((a) => (
              <option key={a.index} value={`gpu:${a.index}`} disabled={!measuredGpu(a.index) || status.directmlBlocked !== null}>
                {a.name} (DirectML){measuredGpu(a.index) ? "" : " – erst messen"}
              </option>
            ))}
          </select>
        </SettingLine>
        {runtime && (
          <SettingLine
            label="Sprach-Laufzeit"
            description={
              <>
                {status.runtime.label}: Lässt NOVAs Stimmen und die Offline-Erkennung auf dem Prozessor oder auf jeder DirectX-12-Grafikkarte laufen (NVIDIA, AMD, Intel). {installLabel(runtime)}
                {status.runtime.loaded && " · in Benutzung"}
                {status.runtime.error && <span className="block text-danger">{status.runtime.error}</span>}
                {runtimeReady && !status.runtime.phonemizer && <span className="block text-warning">nova-phonemize.exe fehlt. NOVA nutzt piper.exe für seine Stimmen.</span>}
              </>
            }
          >
            <DownloadButton item={runtime} onInstall={() => install(runtime.id)} onRemove={() => remove(runtime.id)} />
          </SettingLine>
        )}
      </SettingCard>

      <SettingCard
        title="Messungen"
        description={
          status.benchmarking
            ? progress?.item
              ? `${progress.item} wird auf ${progress.device} gemessen (${progress.done + 1} von ${progress.total}) …`
              : "Wird gemessen …"
            : status.bench
              ? `Gemessen am ${new Date(status.bench.at).toLocaleString("de-DE")}${status.benchStale ? ". Seitdem haben sich Hardware oder Modelle geändert: Miss noch einmal." : "."}`
              : "Wie schnell jedes geladene Modell auf dem Prozessor und auf jeder Grafikkarte läuft. Gemessen wird in einem eigenen Prozess, damit ein fehlerhafter Treiber NOVA nichts anhaben kann."
        }
        icon={Gauge}
        actions={
          <Button size="sm" icon={<Gauge size={14} aria-hidden />} disabled={!runtimeReady || status.benchmarking} onClick={benchmark}>
            {status.bench ? "Neu messen" : "Messen"}
          </Button>
        }
      >
        <div data-setting="Messungen">{status.bench ? <BenchTable runs={status.bench.runs} items={status.items} /> : <p className="text-[12.5px] text-fg-muted">Noch nichts gemessen.</p>}</div>
        <SettingLine label="Gerade jetzt" description={<Placements status={status} />} stacked>
          {null}
        </SettingLine>
      </SettingCard>

      <SettingCard title="Dieser PC" icon={HardDrive}>
        <HardwareSummary status={status} />
      </SettingCard>
    </SettingsSection>
  );
}

/** A voice slower than this (seconds of work per second of speech) makes listeners wait. */
const SLOW = 0.6;

/** How fast a model ran here at best, from the measurements. */
export function bestSpeed(status: SpeechStatus, item: string): number | null {
  const runs = status.bench?.runs.filter((r) => r.ok && r.item === item && r.rtf > 0) ?? [];
  return runs.length ? Math.min(...runs.map((r) => r.rtf)) : null;
}

function SpeedNote({ status, item }: { status: SpeechStatus; item: string }) {
  const rtf = bestSpeed(status, item);
  if (rtf === null) return null;
  return rtf > SLOW ? (
    <span className="text-warning"> · auf diesem PC zu langsam ({rtf.toFixed(2)} s pro Sekunde Sprache)</span>
  ) : (
    <span> · hier {(1 / rtf).toFixed(1)}× schneller als Echtzeit</span>
  );
}

function HardwareSummary({ status }: { status: SpeechStatus }) {
  const hw = status.hardware;
  const extras = [hw.vulkan && "Vulkan", hw.cuda && "CUDA", hw.rocm && "ROCm"].filter(Boolean).join(", ");
  return (
    <div className="space-y-1 text-[12.5px] leading-relaxed text-fg-muted select-text">
      <p>
        <span className="text-fg">{hw.cpu}</span> · {hw.physicalCores} Kerne, {hw.logicalCores} Threads{hw.avx512 ? " · AVX-512" : hw.avx2 ? " · AVX2" : ""} · {formatBytes(hw.memoryTotal)} Arbeitsspeicher ({formatBytes(hw.memoryAvailable)} frei)
      </p>
      {hw.adapters.map((a) => (
        <p key={a.index}>
          <span className="text-fg">{a.name}</span> · {a.dedicatedMemory > 0 ? `${formatBytes(a.dedicatedMemory)} Grafikspeicher` : `${formatBytes(a.sharedMemory)} geteilter Speicher`}
          {a.driver && ` · Treiber ${a.driver}`}
        </p>
      ))}
      {hw.adapters.length === 0 && <p>Keine Grafikkarte für DirectML: Alles läuft auf dem Prozessor.</p>}
      <p className="text-fg-subtle">DirectML deckt Grafik von NVIDIA, AMD und Intel ab.{extras ? ` Außerdem gefunden: ${extras} (braucht NOVA nicht).` : ""}</p>
    </div>
  );
}

function BenchTable({ runs, items }: { runs: BenchRun[]; items: SpeechItem[] }) {
  const label = (id: string) => items.find((i) => i.id === id)?.label ?? id;
  return (
    <table className="w-full text-left text-[12px] text-fg-muted">
      <thead className="text-fg-subtle">
        <tr>
          <th scope="col" className="py-1 font-medium">Modell</th>
          <th scope="col" className="py-1 font-medium">Läuft auf</th>
          <th scope="col" className="py-1 text-right font-medium">Laden</th>
          <th scope="col" className="py-1 text-right font-medium">Erster Ton</th>
          <th scope="col" className="py-1 text-right font-medium" title="Sekunden Arbeit pro Sekunde Sprache (weniger ist schneller)">
            Tempo
          </th>
          <th scope="col" className="py-1 text-right font-medium">Speicher</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run, i) => (
          <tr key={i} className="border-t border-line">
            <td className="py-1 text-fg">{label(run.item)}</td>
            <td className="py-1">{deviceLabel(run.device)}</td>
            {run.ok ? (
              <>
                <td className="py-1 text-right tabular-nums">{(run.loadMs / 1000).toFixed(1)} s</td>
                <td className="py-1 text-right tabular-nums">{run.firstMs} ms</td>
                <td className="py-1 text-right text-fg tabular-nums">{run.rtf.toFixed(2)}</td>
                <td className="py-1 text-right tabular-nums">{run.peakMb} MB</td>
              </>
            ) : (
              <td colSpan={4} className="py-1 text-right text-danger" title={run.error ?? undefined}>
                ging nicht
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Placements({ status }: { status: SpeechStatus }) {
  const label = (id: string) => status.items.find((i) => i.id === id)?.label ?? id;
  if (status.placements.length === 0) return <>Von NOVAs Eigenem ist noch nichts geladen. NOVA spricht mit einer Windows-Stimme.</>;
  return (
    <span className="block space-y-0.5">
      {status.placements.map((p) => (
        <span key={p.item} className="block">
          <span className="text-fg">{label(p.item)}</span>: {deviceLabel(p.device)} – {p.reason}
        </span>
      ))}
      {status.lastVoice && <span className="block text-fg-subtle">Zuletzt gesprochen mit {status.lastVoice}.</span>}
      {status.recognizer && <span className="block text-fg-subtle">Erkennung geladen: {status.recognizer}.</span>}
    </span>
  );
}
