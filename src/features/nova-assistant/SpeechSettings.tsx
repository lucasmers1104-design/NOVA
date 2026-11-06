import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, Download, Gauge, Play, Trash } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { notifyError } from "@/features/notifications/store";
import { SettingRow, SettingsSection } from "@/features/settings/SettingsLayout";
import { isDesktop } from "@/lib/native";
import { agentStatus, configureAgent } from "./api";
import { OnlineVoiceList } from "./OnlineVoiceSettings";
import { type BackendPref, type BenchRun, deviceLabel, formatBytes, type SpeechItem, type SpeechMode, type SpeechStatus, type SttPref, useSpeech } from "./speech/api";
import type { AgentStatus } from "./types";
import { speak } from "./voice";

const MODES = [
  { value: "auto", label: "Auto" },
  { value: "max", label: "Max performance" },
  { value: "low", label: "Low resource" },
] as const satisfies readonly { value: SpeechMode; label: string }[];

const MODE_HELP: Record<SpeechMode, string> = {
  auto: "The fastest setup that keeps the PC responsive. The graphics card is used only where it was measured to be clearly faster.",
  max: "The fastest setup measured on this PC. Voices and the recognizer stay loaded and are made ready when NOVA wakes.",
  low: "As little memory and processor time as possible: the processor with one thread, models unloaded soon after use.",
};

const RECOGNITION = [
  { value: "windows", label: "Windows" },
  { value: "local", label: "Offline" },
  { value: "auto", label: "Automatic" },
] as const satisfies readonly { value: SttPref; label: string }[];

const selectClass = "h-9 max-w-72 rounded-control border border-line bg-black/25 px-2.5 text-[13px] text-fg outline-none focus:border-line-strong disabled:opacity-50";

const AGENT_KEY = ["assistant", "agent"] as const;

function useAgentVoice() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: AGENT_KEY, queryFn: agentStatus, enabled: isDesktop() });
  const save = useMutation({
    mutationFn: configureAgent,
    onSuccess: (next: AgentStatus) => client.setQueryData(AGENT_KEY, next),
    onError: (error) => notifyError("Couldn't change the voice", error),
  });
  const prefs = query.data?.prefs;
  return { prefs, choose: (voice: string) => prefs && save.mutate({ ...prefs, voice }) };
}

function installLabel(item: SpeechItem): string {
  switch (item.install.state) {
    case "downloading":
      return `Downloading … ${item.install.percent} %`;
    case "failed":
      return item.install.message;
    case "ready":
      return "Downloaded";
    default:
      return `${formatBytes(item.size)} download`;
  }
}

function DownloadButton({ item, onInstall, onRemove, removable = true }: { item: SpeechItem; onInstall: () => void; onRemove: () => void; removable?: boolean }) {
  if (item.install.state === "ready") {
    return removable ? (
      <IconButton size="sm" label={`Remove ${item.label}`} onClick={onRemove}>
        <Trash size={14} aria-hidden />
      </IconButton>
    ) : null;
  }
  return (
    <Button size="sm" variant="ghost" icon={<Download size={14} aria-hidden />} disabled={item.install.state === "downloading"} onClick={onInstall}>
      {item.install.state === "failed" ? "Retry" : "Download"}
    </Button>
  );
}

const QUALITY: Record<string, string> = { x_low: "basic", low: "good", medium: "natural", high: "most natural" };

/** Settings → Local AI & performance: NOVA's own voices and recognizer, and where they run. */
export function SpeechSettings() {
  const { status, update, install, remove, benchmark, progress } = useSpeech();
  const agent = useAgentVoice();

  if (!isDesktop()) {
    return (
      <SettingsSection id="local-ai" title="Local AI & performance" description="NOVA's own voices and speech recognition on this PC." icon={Cpu}>
        <p className="text-[13px] text-fg-muted">Available in the NOVA desktop app.</p>
      </SettingsSection>
    );
  }
  if (!status) {
    return (
      <SettingsSection id="local-ai" title="Local AI & performance" description="NOVA's own voices and speech recognition on this PC." icon={Cpu}>
        <p className="text-[13px] text-fg-muted">Looking at this PC …</p>
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
    <SettingsSection id="local-ai" title="Local AI & performance" description="NOVA's own voices and offline speech recognition, and where on this PC they run." icon={Cpu}>
      <SettingRow label="This PC" description={<HardwareSummary status={status} />}>
        <span />
      </SettingRow>

      {runtime && (
        <SettingRow
          label="Speech runtime"
          description={
            <>
              {status.runtime.label}: runs NOVA's voices and offline recognition on the processor or on any DirectX 12 graphics card (NVIDIA, AMD, Intel). {installLabel(runtime)}
              {status.runtime.loaded && " · in use"}
              {status.runtime.error && <span className="block text-danger">{status.runtime.error}</span>}
              {runtimeReady && !status.runtime.phonemizer && <span className="block text-warning">nova-phonemize.exe is missing; NOVA uses piper.exe for its voices.</span>}
            </>
          }
        >
          <DownloadButton item={runtime} onInstall={() => install(runtime.id)} onRemove={() => remove(runtime.id)} />
        </SettingRow>
      )}

      <SettingRow label="Performance mode" description={MODE_HELP[status.prefs.mode]}>
        <SegmentedControl label="Performance mode" value={status.prefs.mode} options={MODES} onChange={(mode) => update({ mode })} />
      </SettingRow>

      <SettingRow
        label="Runs on"
        description={
          status.directmlBlocked
            ? `The graphics card is off: ${status.directmlBlocked}.`
            : status.bench
              ? "Automatic picks what was measured to be faster on this PC."
              : "Measure once to let NOVA choose; until then everything runs on the processor."
        }
      >
        <select
          aria-label="Runs on"
          className={selectClass}
          value={backendValue}
          disabled={status.prefs.mode === "low"}
          onChange={(e) => {
            const value = e.target.value;
            if (value.startsWith("gpu:")) update({ backend: "directMl" satisfies BackendPref, adapter: Number(value.slice(4)) });
            else update({ backend: value as BackendPref, adapter: null });
          }}
        >
          <option value="auto">Automatic</option>
          <option value="cpu">Processor</option>
          {hw.adapters.map((a) => (
            <option key={a.index} value={`gpu:${a.index}`} disabled={!measuredGpu(a.index) || status.directmlBlocked !== null}>
              {a.name} (DirectML){measuredGpu(a.index) ? "" : " — measure first"}
            </option>
          ))}
        </select>
      </SettingRow>

      <OnlineVoiceList
        current={agent.prefs?.voice ?? ""}
        onChoose={agent.choose}
        onListen={(voice) => agent.prefs && void speak("Hallo, ich bin NOVA. So klinge ich mit dieser Stimme.", { ...agent.prefs, voice }, "test")}
      />

      <div className="py-4">
        <div className="text-[13.5px] font-medium text-fg">Voices on this PC</div>
        <p className="mt-0.5 text-[12.5px] text-fg-muted">German voices that run on this PC, offline. Pick one to make it NOVA's voice.</p>
        <ul className="mt-3 space-y-1.5">
          {voices.map((voice) => {
            const value = `nova:${voice.id}`;
            const chosen = agent.prefs?.voice === value || (voice.id === "thorsten" && agent.prefs?.voice === "");
            return (
              <li key={voice.id} className="flex items-center justify-between gap-3 rounded-[12px] border border-line bg-white/[0.02] px-3 py-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-fg">
                    {voice.label}
                    {chosen && <Badge tone="accent">NOVA's voice</Badge>}
                    {voice.experimental && <Badge tone="warning">experimental</Badge>}
                  </div>
                  <div className="text-[12px] text-fg-muted">
                    {voice.gender === "female" ? "Female" : "Male"} · {QUALITY[voice.quality] ?? voice.quality} · {voice.license} · {installLabel(voice)}
                    <SpeedNote status={status} item={voice.id} />
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {voice.install.state === "ready" && (
                    <>
                      <IconButton
                        size="sm"
                        label={`Listen to ${voice.label}`}
                        onClick={() => agent.prefs && void speak("Hallo, ich bin NOVA. So klinge ich mit dieser Stimme.", { ...agent.prefs, voice: value }, "test")}
                      >
                        <Play size={14} aria-hidden />
                      </IconButton>
                      {!chosen && (
                        <Button size="sm" variant="ghost" onClick={() => agent.choose(value)}>
                          Use
                        </Button>
                      )}
                    </>
                  )}
                  <DownloadButton item={voice} removable={voice.id !== "thorsten"} onInstall={() => install(voice.id)} onRemove={() => remove(voice.id)} />
                </div>
              </li>
            );
          })}
        </ul>
        {!runtimeReady && <p className="mt-2 text-[12px] text-fg-subtle">Without the speech runtime, Piper voices run with piper.exe on the processor; Martin (Kokoro) needs the runtime.</p>}
      </div>

      {recognizer && (
        <SettingRow
          label="Speech recognition"
          description={
            <>
              Windows uses its online dictation. Offline uses NVIDIA Parakeet on this PC ({formatBytes(recognizer.size)}, {recognizer.license}) and needs the speech runtime; it also steps in when Windows can't listen. {installLabel(recognizer)}
            </>
          }
        >
          <div className="flex items-center gap-1.5">
            <SegmentedControl label="Speech recognition" value={status.prefs.stt} options={RECOGNITION} onChange={(stt) => update({ stt })} />
            <DownloadButton item={recognizer} onInstall={() => install(recognizer.id)} onRemove={() => remove(recognizer.id)} />
          </div>
        </SettingRow>
      )}

      <div className="py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[13.5px] font-medium text-fg">Measurements</div>
            <p className="mt-0.5 text-[12.5px] text-fg-muted">
              {status.benchmarking
                ? progress?.item
                  ? `Measuring ${progress.item} on ${progress.device} (${progress.done + 1} of ${progress.total}) …`
                  : "Measuring …"
                : status.bench
                  ? `Measured ${new Date(status.bench.at).toLocaleString()}${status.benchStale ? " — the hardware or the models changed since; measure again." : "."}`
                  : "How fast each downloaded model runs on the processor and on each graphics card. Runs in a separate process, so a faulty driver can't affect NOVA."}
            </p>
          </div>
          <Button size="sm" icon={<Gauge size={14} aria-hidden />} disabled={!runtimeReady || status.benchmarking} onClick={benchmark}>
            {status.bench ? "Measure again" : "Measure"}
          </Button>
        </div>
        {status.bench && <BenchTable runs={status.bench.runs} items={status.items} />}
      </div>

      <SettingRow label="Now" description={<Placements status={status} />}>
        <span />
      </SettingRow>
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
    <span className="text-warning"> · too slow on this PC ({rtf.toFixed(2)} s per second of speech)</span>
  ) : (
    <span> · {(1 / rtf).toFixed(1)}× faster than real time here</span>
  );
}

function HardwareSummary({ status }: { status: SpeechStatus }) {
  const hw = status.hardware;
  const extras = [hw.vulkan && "Vulkan", hw.cuda && "CUDA", hw.rocm && "ROCm"].filter(Boolean).join(", ");
  return (
    <span className="block space-y-0.5">
      <span className="block">
        {hw.cpu} · {hw.physicalCores} cores, {hw.logicalCores} threads{hw.avx512 ? " · AVX-512" : hw.avx2 ? " · AVX2" : ""} · {formatBytes(hw.memoryTotal)} memory ({formatBytes(hw.memoryAvailable)} free)
      </span>
      {hw.adapters.map((a) => (
        <span key={a.index} className="block">
          {a.name} · {a.dedicatedMemory > 0 ? `${formatBytes(a.dedicatedMemory)} video memory` : `${formatBytes(a.sharedMemory)} shared memory`}
          {a.driver && ` · driver ${a.driver}`}
        </span>
      ))}
      {hw.adapters.length === 0 && <span className="block">No graphics card for DirectML: everything runs on the processor.</span>}
      <span className="block text-fg-subtle">
        DirectML covers NVIDIA, AMD and Intel graphics.{extras ? ` Also found: ${extras} (not needed by NOVA).` : ""}
      </span>
    </span>
  );
}

function BenchTable({ runs, items }: { runs: BenchRun[]; items: SpeechItem[] }) {
  const label = (id: string) => items.find((i) => i.id === id)?.label ?? id;
  return (
    <table className="mt-3 w-full text-left text-[12px] text-fg-muted">
      <thead className="text-fg-subtle">
        <tr>
          <th className="py-1 font-medium">Model</th>
          <th className="py-1 font-medium">Runs on</th>
          <th className="py-1 text-right font-medium">Load</th>
          <th className="py-1 text-right font-medium">First</th>
          <th className="py-1 text-right font-medium" title="Seconds of work per second of speech (lower is faster)">
            Speed
          </th>
          <th className="py-1 text-right font-medium">Memory</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run, i) => (
          <tr key={i} className="border-t border-line">
            <td className="py-1 text-fg">{label(run.item)}</td>
            <td className="py-1">{deviceLabel(run.device)}</td>
            {run.ok ? (
              <>
                <td className="py-1 text-right">{(run.loadMs / 1000).toFixed(1)} s</td>
                <td className="py-1 text-right">{run.firstMs} ms</td>
                <td className="py-1 text-right text-fg">{run.rtf.toFixed(2)}</td>
                <td className="py-1 text-right">{run.peakMb} MB</td>
              </>
            ) : (
              <td colSpan={4} className="py-1 text-right text-danger" title={run.error ?? undefined}>
                didn't work
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
  if (status.placements.length === 0) return <>Nothing of NOVA's own is downloaded yet; NOVA speaks with a Windows voice.</>;
  return (
    <span className="block space-y-0.5">
      {status.placements.map((p) => (
        <span key={p.item} className="block">
          <span className="text-fg">{label(p.item)}</span>: {deviceLabel(p.device)} — {p.reason}
        </span>
      ))}
      {status.lastVoice && <span className="block text-fg-subtle">Last spoke with {status.lastVoice}.</span>}
      {status.recognizer && <span className="block text-fg-subtle">Recognizer loaded: {status.recognizer}.</span>}
    </span>
  );
}
