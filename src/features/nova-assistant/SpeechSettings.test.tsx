import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as native from "@/lib/native";
import { renderWithQuery } from "@/test/render";
import type { SpeechStatus } from "./speech/api";
import { SpeechSettings } from "./SpeechSettings";
import type { AgentStatus } from "./types";
import * as voice from "./voice";

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
  prefs: { provider: null, models: {}, effort: "medium", monthlyLimitUsd: null, speakReplies: false, voice: "", speechRate: 1, speechVolume: 1, language: "de-DE", keepListening: true, autoMode: false, memory: true },
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
  let geminiKey: boolean;

  beforeEach(() => {
    geminiKey = false;
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
      if (command === "online_voice_keys") return { gemini: geminiKey, elevenlabs: false };
      if (command === "ai_key_set") {
        geminiKey = true;
        return undefined;
      }
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
    const cpu = await screen.findByText(/i3-6006U CPU @ 2.00GHz/);
    expect(cpu.parentElement).toHaveTextContent(/i3-6006U CPU @ 2.00GHz · 2 Kerne, 4 Threads · AVX2/);
    expect(screen.getByText("Intel(R) HD Graphics 520").parentElement).toHaveTextContent(/HD Graphics 520 · 128 MB Grafikspeicher · Treiber 24.20.100.6286/);
    expect(screen.getByText(/Außerdem gefunden: Vulkan \(braucht NOVA nicht\)/)).toBeInTheDocument();
    expect(screen.getByText(/Processor is faster here/)).toBeInTheDocument();
    expect(screen.getByText(/Zuletzt gesprochen mit Thorsten · CPU · 2 threads/)).toBeInTheDocument();
    // A failed GPU run shows as such, not as a number.
    expect(screen.getAllByText("ging nicht")).toHaveLength(1);
    expect(screen.getByText("0.16")).toBeInTheDocument();
  });

  it("lists online voices, usable once their key is saved", async () => {
    const user = userEvent.setup();
    renderWithQuery(<SpeechSettings />);
    const row = (await screen.findByText("Sulafat, warm")).closest("li")!;
    const use = within(row).getByRole("button", { name: "Nehmen" });
    expect(use).toBeDisabled();
    expect(within(row).getByRole("button", { name: "Sulafat, warm anhören" })).toBeDisabled();

    const key = screen.getByLabelText("API-Schlüssel für Google Gemini");
    await user.type(key, "AIza-test-key");
    await user.click(within(key.closest("form")!).getByRole("button", { name: "Speichern" }));
    expect(call).toHaveBeenCalledWith("ai_key_set", { provider: "gemini", key: "AIza-test-key" });
    await waitFor(() => expect(use).toBeEnabled());

    await user.click(use);
    expect(call).toHaveBeenCalledWith("assistant_agent_configure", { prefs: expect.objectContaining({ voice: "online:gemini:Sulafat" }) });
    expect(await within(row).findByText("NOVAs Stimme")).toBeInTheDocument();
  });

  it("plays a voice's sample, one at a time, and stops it on a second click", async () => {
    const samples: (() => void)[] = [];
    const speak = vi.spyOn(voice, "speak").mockImplementation(() => new Promise<void>((resolve) => samples.push(resolve)));
    // A new sample, or the stop, ends the one that plays.
    const stop = vi.spyOn(voice, "stopSpeaking").mockImplementation(() => samples.splice(0).forEach((end) => end()));
    const user = userEvent.setup();
    const view = renderWithQuery(<SpeechSettings />);
    await user.click(await screen.findByRole("button", { name: "Eva anhören" }));
    // With that voice, whatever NOVA's own voice is right now.
    expect(speak).toHaveBeenLastCalledWith(expect.stringMatching(/^Hallo, ich bin NOVA/), { ...AGENT.prefs, voice: "nova:eva" }, "test");
    expect(screen.getByRole("button", { name: "Eva stoppen" })).toBeInTheDocument();
    expect(agent.prefs.voice).toBe("");

    await user.click(screen.getByRole("button", { name: "Thorsten anhören" }));
    expect(speak).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ voice: "nova:thorsten" }), "test");
    await user.click(screen.getByRole("button", { name: "Thorsten stoppen" }));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Thorsten anhören" })).toBeInTheDocument();

    // Leaving the page ends a sample that still plays, and only then.
    view.unmount();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("switches the performance mode and the device", async () => {
    const user = userEvent.setup();
    renderWithQuery(<SpeechSettings />);
    await user.click(await screen.findByRole("radio", { name: /^Sparsam/ }));
    expect(call).toHaveBeenCalledWith("speech_configure", { prefs: { ...STATUS.prefs, mode: "low" } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Läuft auf" })).toBeDisabled());
    await user.click(screen.getByRole("radio", { name: /^Auto\s*Schnell/ }));
    const select = await screen.findByRole("combobox", { name: "Läuft auf" });
    await waitFor(() => expect(select).toBeEnabled());
    await user.selectOptions(select, "gpu:0");
    expect(call).toHaveBeenLastCalledWith("speech_configure", { prefs: { mode: "auto", backend: "directMl", adapter: 0, stt: "windows" } });
  });

  it("downloads, chooses and measures", async () => {
    const user = userEvent.setup();
    renderWithQuery(<SpeechSettings />);
    const martin = (await screen.findByText("Martin (Kokoro)")).closest("li")!;
    expect(within(martin).getByText("experimentell")).toBeInTheDocument();
    // Not downloaded yet: nothing to listen to or to choose.
    expect(within(martin).getByRole("button", { name: "Martin (Kokoro) anhören" })).toBeDisabled();
    await user.click(within(martin).getByRole("button", { name: "Laden" }));
    expect(call).toHaveBeenCalledWith("speech_install", { id: "martin" });
    const eva = screen.getAllByText("Eva").map((e) => e.closest("li")).find(Boolean)!;
    await user.click(within(eva).getByRole("button", { name: "Nehmen" }));
    expect(call).toHaveBeenCalledWith("assistant_agent_configure", { prefs: { ...AGENT.prefs, voice: "nova:eva" } });
    expect(screen.getByText(/Wird geladen … 42 %/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Neu messen" }));
    expect(call).toHaveBeenCalledWith("speech_benchmark");
  });
});
