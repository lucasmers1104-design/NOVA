import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { notifyError } from "@/features/notifications/store";
import { callNative, isDesktop } from "@/lib/native";

/** Mirrors `Device` in src-tauri/src/speech/runtime.rs. */
export type Device = { kind: "cpu"; threads: number } | { kind: "directMl"; adapter: number; name: string };

export type SpeechMode = "auto" | "max" | "low";
export type BackendPref = "auto" | "cpu" | "directMl";
export type SttPref = "windows" | "local" | "auto";

export interface SpeechPrefs {
  mode: SpeechMode;
  backend: BackendPref;
  adapter: number | null;
  stt: SttPref;
}

export interface Adapter {
  index: number;
  name: string;
  vendor: string;
  vendorId: number;
  deviceId: number;
  dedicatedMemory: number;
  sharedMemory: number;
  driver: string | null;
}

export interface Hardware {
  cpu: string;
  physicalCores: number;
  logicalCores: number;
  avx2: boolean;
  avx512: boolean;
  memoryTotal: number;
  memoryAvailable: number;
  adapters: Adapter[];
  cuda: boolean;
  rocm: boolean;
  vulkan: boolean;
}

export type Install = { state: "missing" } | { state: "downloading"; percent: number } | { state: "ready" } | { state: "failed"; message: string };

export interface SpeechItem {
  id: string;
  label: string;
  kind: "runtime" | "voice" | "recognizer";
  engine: "piper" | "kokoro" | "parakeet" | "onnx";
  size: number;
  license: string;
  gender: string;
  quality: string;
  experimental: boolean;
  install: Install;
}

export interface BenchRun {
  item: string;
  device: Device;
  ok: boolean;
  error: string | null;
  loadMs: number;
  firstMs: number;
  rtf: number;
  peakMb: number;
}

export interface SpeechStatus {
  prefs: SpeechPrefs;
  hardware: Hardware;
  runtime: { label: string; loaded: boolean; error: string | null; directml: string | null; phonemizer: boolean };
  items: SpeechItem[];
  bench: { key: string; at: number; runs: BenchRun[] } | null;
  benchStale: boolean;
  benchmarking: boolean;
  directmlBlocked: string | null;
  placements: { item: string; device: Device; reason: string }[];
  lastVoice: string | null;
  recognizer: string | null;
}

export interface BenchProgress {
  item?: string;
  device?: string;
  done: number;
  total: number;
}

export const SPEECH_EVENTS = { status: "speech://status", bench: "speech://bench" } as const;

export const speechStatus = () => callNative<SpeechStatus>("speech_status");
export const configureSpeech = (prefs: SpeechPrefs) => callNative<SpeechStatus>("speech_configure", { prefs });
export const installSpeech = (id: string) => callNative<SpeechStatus>("speech_install", { id });
export const removeSpeech = (id: string) => callNative<SpeechStatus>("speech_remove", { id });
export const benchmarkSpeech = () => callNative<void>("speech_benchmark");

export function deviceLabel(device: Device): string {
  if (device.kind === "directMl") return `Graphics card · ${device.name}`;
  return `Processor · ${device.threads} ${device.threads === 1 ? "thread" : "threads"}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${Math.round(bytes / (1 << 20))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const SPEECH_KEY = ["speech", "status"] as const;

/** NOVA's speech engines: status (kept current by events) and actions. */
export function useSpeech() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: SPEECH_KEY, queryFn: speechStatus, enabled: isDesktop() });
  const [progress, setProgress] = useState<BenchProgress | null>(null);
  useEffect(() => {
    if (!isDesktop()) return;
    const stops = [
      listen<SpeechStatus>(SPEECH_EVENTS.status, (event) => {
        client.setQueryData(SPEECH_KEY, event.payload);
        if (!event.payload.benchmarking) setProgress(null);
      }),
      listen<BenchProgress>(SPEECH_EVENTS.bench, (event) => setProgress(event.payload)),
    ];
    return () => stops.forEach((stop) => void stop.then((unlisten) => unlisten()));
  }, [client]);
  const apply = (next: SpeechStatus) => client.setQueryData(SPEECH_KEY, next);
  const configure = useMutation({ mutationFn: configureSpeech, onSuccess: apply, onError: (error) => notifyError("Couldn't save the speech settings", error) });
  const install = useMutation({ mutationFn: installSpeech, onSuccess: apply, onError: (error) => notifyError("Couldn't start the download", error) });
  const remove = useMutation({ mutationFn: removeSpeech, onSuccess: apply, onError: (error) => notifyError("Couldn't remove it", error) });
  const benchmark = useMutation({ mutationFn: benchmarkSpeech, onError: (error) => notifyError("Couldn't start the measurement", error) });
  const update = (patch: Partial<SpeechPrefs>) => {
    const current = query.data?.prefs;
    if (current) configure.mutate({ ...current, ...patch });
  };
  return { status: query.data, update, install: install.mutate, remove: remove.mutate, benchmark: () => benchmark.mutate(), progress };
}
