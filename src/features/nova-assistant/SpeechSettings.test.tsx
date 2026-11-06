import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as native from "@/lib/native";
import { renderWithQuery } from "@/test/render";
import type { SpeechStatus } from "./speech/api";
import { SpeechSettings } from "./SpeechSettings";
import type { AgentStatus } from "./types";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(), emitTo: vi.fn() }));

const STATUS: SpeechStatus = {
  prefs: { mode: "auto", backend: "auto", adapter: null, stt: "windows" },
  hardware: {
    cpu: "Intel(R) Core(TM) i3-6006U CPU @ 2.00GHz",
    physicalCores: 2,
    logicalCores: 4,
    avx2: true,
    avx512: false,
    memoryTotal: 8 * 2 ** 30,
    memoryAvailable: 2 * 2 ** 30,
    adapters: [{ index: 0, name: "Intel(R) HD Graphics 520", vendor: "Intel", vendorId: 0x8086, deviceId: 0x1916, dedicatedMemory: 128 * 2 ** 20, sharedMemory: 4 * 2 ** 30, driver: "24.20.100.6286" }],
    cuda: false,
    rocm: false,
    vulkan: true,
  },
  runtime: { label: "ONNX Runtime 1.24.4 · DirectML 1.15.4", loaded: true, error: null, directml: "C:\\…\\DirectML.dll", phonemizer: true },
  items: [
    { id: "runtime", label: "ONNX Runtime + DirectML", kind: "runtime", engine: "onnx", size: 35_877_968, license: "MIT", gender: "", quality: "", experimental: false, install: { state: "ready" } },
    { id: "thorsten", label: "Thorsten", kind: "voice", engine: "piper", size: 0, license: "CC0", gender: "male", quality: "medium", experimental: false, install: { state: "ready" } },
    { id: "eva", label: "Eva", kind: "voice", engine: "piper", size: 20_633_000, license: "M-AILABS", gender: "female", quality: "x_low", experimental: false, install: { state: "ready" } },
    { id: "martin", label: "Martin (Kokoro)", kind: "voice", engine: "kokoro", size: 326_000_000, license: "Apache-2.0", gender: "male", quality: "high", experimental: true, install: { state: "missing" } },
    { id: "parakeet", label: "Parakeet", kind: "recognizer", engine: "parakeet", size: 672_000_000, license: "CC-BY-4.0", gender: "", quality: "", experimental: false, install: { state: "downloading", percent: 42 } },
  ],
  bench: {
    key: "k",
    at: Date.UTC(2026, 10, 5, 19, 0),
    runs: [
      { item: "thorsten", device: { kind: "cpu", threads: 2 }, ok: true, error: null, loadMs: 2700, firstMs: 276, rtf: 0.157, peakMb: 210 },
      { item: "thorsten", device: { kind: "directMl", adapter: 0, name: "Intel(R) HD Graphics 520" }, ok: true, error: null, loadMs: 3700, firstMs: 8600, rtf: 0.32, peakMb: 380 },
      { item: "eva", device: { kind: "directMl", adapter: 0, name: "Intel(R) HD Graphics 520" }, ok: false, error: "boom", loadMs: 0, firstMs: 0, rtf: 0, peakMb: 0 },
    ],
  },
  benchStale: false,
  benchmarking: false,
  directmlBlocked: null,
  placements: [{ item: "thorsten", device: { kind: "cpu", threads: 2 }, reason: "Processor is faster here (0.16 vs 0.32 s per second of speech)" }],
  lastVoice: "Thorsten · CPU · 2 threads",
  recognizer: null,
};

const AGENT = {
  prefs: { provider: null, models: {}, effort: "medium", monthlyLimitUsd: null, speakReplies: false, voice: "", speechRate: 1, speechVolume: 1, language: "de-DE", keepListening: true, autoMode: false },
  activeProvider: null,
  activeModel: null,
  keys: { anthropic: false, openai: false, gemini: false },
  usageThisMonth: { requests: 0, inputTokens: 0, outputTokens: 0, costMicros: 0, unpricedRequests: 0 },
  running: false,
} satisfies AgentStatus;

describe("SpeechSettings", () => {
  let status: SpeechStatus;
  let agent: AgentStatus;
  let call: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    status = structuredClone(STATUS);
    agent = structuredClone(AGENT);
    vi.spyOn(native, "isDesktop").mockReturnValue(true);
    call = vi.spyOn(native, "callNative").mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "speech_status") return status;
      if (command === "speech_configure") {
        status = { ...status, prefs: args?.prefs as SpeechStatus["prefs"] };
        return status;
      }
      if (command === "speech_install") return status;
      if (command === "speech_benchmark") return undefined;
      if (command === "assistant_agent_status") return agent;
      if (command === "assistant_agent_configure") {
        agent = { ...agent, prefs: args?.prefs as AgentStatus["prefs"] };
        return agent;
      }
      throw new Error(`unexpected ${command}`);
    });
  });

  it("shows the real hardware, what runs where and why", async () => {
    renderWithQuery(<SpeechSettings />);
    expect(await screen.findByText(/i3-6006U CPU @ 2.00GHz · 2 cores, 4 threads · AVX2/)).toBeInTheDocument();
    expect(screen.getByText(/HD Graphics 520 · 128 MB video memory · driver 24.20.100.6286/)).toBeInTheDocument();
    expect(screen.getByText(/Also found: Vulkan \(not needed by NOVA\)/)).toBeInTheDocument();
    expect(screen.getByText(/Processor is faster here/)).toBeInTheDocument();
    expect(screen.getByText(/Last spoke with Thorsten · CPU · 2 threads/)).toBeInTheDocument();
    // A failed GPU run shows as such, not as a number.
    expect(screen.getAllByText("didn't work")).toHaveLength(1);
    expect(screen.getByText("0.16")).toBeInTheDocument();
  });

  it("switches the performance mode and the device", async () => {
    const user = userEvent.setup();
    renderWithQuery(<SpeechSettings />);
    await user.click(await screen.findByRole("radio", { name: "Low resource" }));
    expect(call).toHaveBeenCalledWith("speech_configure", { prefs: { ...STATUS.prefs, mode: "low" } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Runs on" })).toBeDisabled());
    await user.click(screen.getByRole("radio", { name: "Auto" }));
    const select = await screen.findByRole("combobox", { name: "Runs on" });
    await waitFor(() => expect(select).toBeEnabled());
    await user.selectOptions(select, "gpu:0");
    expect(call).toHaveBeenLastCalledWith("speech_configure", { prefs: { mode: "auto", backend: "directMl", adapter: 0, stt: "windows" } });
  });

  it("downloads, chooses and measures", async () => {
    const user = userEvent.setup();
    renderWithQuery(<SpeechSettings />);
    const martin = (await screen.findByText("Martin (Kokoro)")).closest("li")!;
    expect(within(martin).getByText("experimental")).toBeInTheDocument();
    await user.click(within(martin).getByRole("button", { name: "Download" }));
    expect(call).toHaveBeenCalledWith("speech_install", { id: "martin" });
    const eva = screen.getAllByText("Eva").map((e) => e.closest("li")).find(Boolean)!;
    await user.click(within(eva).getByRole("button", { name: "Use" }));
    expect(call).toHaveBeenCalledWith("assistant_agent_configure", { prefs: { ...AGENT.prefs, voice: "nova:eva" } });
    expect(screen.getByText(/Downloading … 42 %/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Measure again" }));
    expect(call).toHaveBeenCalledWith("speech_benchmark");
  });
});
