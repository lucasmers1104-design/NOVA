import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeechStatus } from "@/features/nova-assistant/speech/api";
import { type AgentStatus, type AssistantStatus, DEFAULT_DOT_LOOK, type FinderStatus } from "@/features/nova-assistant/types";
import type { WakeStatus } from "@/features/nova-assistant/wake";
import type { TelemetryStatus } from "@/features/telemetry/api";
import * as native from "@/lib/native";
import { defaultSettings, useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { renderWithQuery } from "@/test/render";
import type { ReplayStatus } from "./GamesSettings";
import { useRecentSettings } from "./recent";
import { MoreOptions, REVEAL_SETTINGS_EVENT } from "./SettingsLayout";
import SettingsPage, { SEARCHABLE } from "./SettingsPage";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}), emitTo: vi.fn(async () => {}) }));

const row = (label: string) => [...document.querySelectorAll<HTMLElement>("[data-setting]")].find((element) => element.dataset.setting === label);

beforeEach(() => {
  useSettings.setState(defaultSettings());
  useRecentSettings.setState({ recent: [] });
  useUi.setState({ settingsSection: null });
  // jsdom lays nothing out, so it has no scrolling either.
  Element.prototype.scrollIntoView = vi.fn();
});

describe("the Settings home", () => {
  it("finds a setting, jumps to its row and lights it up", async () => {
    const user = userEvent.setup();
    renderWithQuery(<SettingsPage />);
    const search = screen.getByRole("combobox", { name: "Einstellungen durchsuchen" });
    // The home is where a search starts: the field is ready to type into.
    expect(search).toHaveFocus();
    await user.type(search, "ecken");
    const results = within(screen.getByRole("listbox", { name: "Gefundene Einstellungen" })).getAllByRole("option");
    // Each result says where it lives. What merely contains the word ("wecken") comes after what starts with it.
    // (The island's corners moved to the NOVA Island tab.)
    expect(results.slice(0, 2).map((option) => option.textContent)).toEqual(["EckenDarstellung", "Mit „Hey NOVA“ weckenHey NOVA & Klatschen"]);
    expect(results[0]).toHaveAttribute("aria-selected", "true");
    // The arrow keys move through the results, and around the ends.
    await user.keyboard("{ArrowDown}");
    expect(results[1]).toHaveAttribute("aria-selected", "true");
    expect(search).toHaveAttribute("aria-activedescendant", results[1]!.id);
    await user.keyboard("{ArrowUp}{Enter}");

    expect(await screen.findByRole("heading", { name: "Darstellung" })).toBeInTheDocument();
    await waitFor(() => expect(row("Ecken")).toHaveClass("setting-found"));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    // The keyboard lands on the setting's own control.
    expect(screen.getByRole("slider", { name: "Ecken" })).toHaveFocus();
    // Inside a section the search sits beside the list of sections, empty again.
    expect(screen.getByRole("combobox", { name: "Einstellungen durchsuchen" })).toHaveValue("");
  });

  it("says so when nothing matches, and Escape starts over", async () => {
    const user = userEvent.setup();
    renderWithQuery(<SettingsPage />);
    const search = screen.getByRole("combobox", { name: "Einstellungen durchsuchen" });
    await user.type(search, "gibt es nicht");
    expect(screen.getByText(/Nichts gefunden/)).toBeInTheDocument();
    // While something is typed, the results stand in for the rest of the home.
    expect(screen.queryByRole("navigation", { name: "Alle Bereiche" })).toBeNull();
    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(screen.getByRole("navigation", { name: "Alle Bereiche" })).toBeInTheDocument();
  });

  it("searches from inside a section too", async () => {
    const user = userEvent.setup();
    useUi.setState({ settingsSection: "system" });
    renderWithQuery(<SettingsPage />);
    const beside = within(screen.getByRole("navigation", { name: "Bereiche der Einstellungen" }));
    await user.type(beside.getByRole("combobox", { name: "Einstellungen durchsuchen" }), "titelleiste");
    // The results take the place of the list of sections.
    expect(beside.queryByRole("button", { name: "Dashboard" })).toBeNull();
    await user.click(beside.getByRole("option", { name: /Uhr in der Titelleiste/ }));
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    await waitFor(() => expect(row("Uhr in der Titelleiste")).toHaveClass("setting-found"));
    expect(beside.getByRole("button", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
  });

  it("shows every section as a tile", async () => {
    const user = userEvent.setup();
    renderWithQuery(<SettingsPage />);
    const tiles = within(screen.getByRole("navigation", { name: "Alle Bereiche" }));
    const beside = within(screen.getByRole("navigation", { name: "Bereiche der Einstellungen" }));
    // One tile for each section in the list beside the page ("Übersicht" there is the home itself).
    expect(tiles.getAllByRole("button")).toHaveLength(beside.getAllByRole("button").length - 1);
    await user.click(tiles.getByRole("button", { name: /^Navigation/ }));
    expect(await screen.findByRole("heading", { name: "Navigation" })).toBeInTheDocument();
    expect(beside.getByRole("button", { name: "Navigation" })).toHaveAttribute("aria-current", "page");
  });

  it("remembers what was changed and leads back to it", async () => {
    const user = userEvent.setup();
    renderWithQuery(<SettingsPage />);
    expect(screen.getByText(/Was du änderst, steht danach hier/)).toBeInTheDocument();
    const beside = within(screen.getByRole("navigation", { name: "Bereiche der Einstellungen" }));

    await user.click(beside.getByRole("button", { name: "Dashboard" }));
    await user.click(await screen.findByRole("switch", { name: "24-Stunden-Uhr" }));
    await user.click(screen.getByRole("radio", { name: "Uhrzeit & Datum" }));
    expect(useSettings.getState().titleBarClock).toBe("time-date");

    await user.click(beside.getByRole("button", { name: "Übersicht" }));
    const recent = within(screen.getByRole("region", { name: "Zuletzt geändert" }));
    // The newest change first, each with its section and how long ago it was.
    expect(recent.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Uhr in der TitelleisteDashboard · gerade eben", "24-Stunden-UhrDashboard · gerade eben"]);
    await user.click(recent.getByRole("button", { name: /24-Stunden-Uhr/ }));
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    await waitFor(() => expect(row("24-Stunden-Uhr")).toHaveClass("setting-found"));

    await user.click(beside.getByRole("button", { name: "Übersicht" }));
    await user.click(within(screen.getByRole("region", { name: "Zuletzt geändert" })).getByRole("button", { name: "Liste leeren" }));
    expect(useRecentSettings.getState().recent).toEqual([]);
  });

  it("notes a change made on the home under the section it belongs to", async () => {
    const user = userEvent.setup();
    renderWithQuery(<SettingsPage />);
    await user.click(screen.getByRole("switch", { name: "Glas-Effekte" }));
    expect(useSettings.getState().transparency).toBe(false);
    await user.click(screen.getByRole("radio", { name: "Smaragd" }));
    expect(useSettings.getState().accent).toEqual({ kind: "preset", id: "emerald" });
    expect(useRecentSettings.getState().recent.map(({ section, label }) => `${section}/${label}`)).toEqual(["appearance/Akzentfarbe", "appearance/Transparenz"]);
  });

  it("opens at the section another page asked for", async () => {
    useUi.setState({ settingsSection: "shortcuts" });
    renderWithQuery(<SettingsPage />);
    expect(await screen.findByRole("heading", { name: "Tastenkürzel" })).toBeInTheDocument();
    expect(screen.getByText("Befehlspalette öffnen")).toBeInTheDocument();
    expect(useUi.getState().settingsSection).toBeNull();
  });
});

describe("what the search can find", () => {
  const ASSISTANT: AssistantStatus = {
    enabled: true,
    placement: "corner",
    corner: "bottomRight",
    look: DEFAULT_DOT_LOOK,
    taskbarAvailable: true,
    shortcut: "Ctrl+Alt+Space",
    background: false,
    hideInFullscreen: false,
    customPosition: false,
    docked: false,
    shortcutError: null,
    defaultShortcut: "Ctrl+Alt+Space",
    panelOpen: false,
    panelPinned: false,
  };
  const AGENT: AgentStatus = {
    prefs: { provider: null, models: {}, effort: "medium", monthlyLimitUsd: null, speakReplies: false, voice: "", speechRate: 1, speechVolume: 1, language: "de-DE", keepListening: true, autoMode: false, memory: true },
    activeProvider: null,
    activeModel: null,
    keys: { anthropic: false, openai: false, gemini: false },
    usageThisMonth: { requests: 0, inputTokens: 0, outputTokens: 0, costMicros: 0, unpricedRequests: 0 },
    running: false,
  };
  const WAKE: WakeStatus = {
    prefs: { phrase: true, phraseSensitivity: "strict", clap: true, clapSensitivity: "strict", afterWake: "listen", chime: true, inGames: true, muted: false },
    phrase: { state: "listening" },
    clap: { state: "listening" },
    dictation: true,
    testing: false,
  };
  const SPEECH: SpeechStatus = {
    prefs: { mode: "auto", backend: "auto", adapter: null, stt: "windows" },
    hardware: { cpu: "CPU", physicalCores: 2, logicalCores: 4, avx2: true, avx512: false, memoryTotal: 8 * 2 ** 30, memoryAvailable: 2 * 2 ** 30, adapters: [], cuda: false, rocm: false, vulkan: false },
    runtime: { label: "ONNX Runtime", loaded: false, error: null, directml: null, phonemizer: true },
    items: [
      { id: "runtime", label: "ONNX Runtime + DirectML", kind: "runtime", engine: "onnx", size: 1, license: "MIT", gender: "", quality: "", experimental: false, install: { state: "ready" } },
      { id: "thorsten", label: "Thorsten", kind: "voice", engine: "piper", size: 0, license: "CC0", gender: "male", quality: "medium", experimental: false, install: { state: "ready" } },
      { id: "parakeet", label: "Parakeet", kind: "recognizer", engine: "parakeet", size: 1, license: "CC-BY-4.0", gender: "", quality: "", experimental: false, install: { state: "missing" } },
    ],
    bench: null,
    benchStale: false,
    benchmarking: false,
    directmlBlocked: null,
    placements: [],
    lastVoice: null,
    recognizer: null,
  };
  const REPLAY: ReplayStatus = { enabled: false, installed: false, downloading: null, downloadSize: 1, recording: false, encoder: null, error: null, folder: "C:\\Clips", discordName: "", discordSet: false };
  const FINDER: FinderStatus = { folders: [], content: true, progress: { running: false, scanned: 0, indexed: 0, current: null, lastFinished: null, error: null } };
  const TELEMETRY: TelemetryStatus = { needsDecision: false, accepted: false, decidedAt: null, installId: null, displayName: null, lastSent: null, lastError: null, waiting: 0, privacyUrl: "https://example.test/privacy", host: "example.test" };

  /** What Rust would answer, as far as these pages ask. */
  const ANSWERS: Record<string, unknown> = {
    assistant_status: ASSISTANT,
    assistant_agent_status: AGENT,
    autostart_get: false,
    wake_status: WAKE,
    speech_status: SPEECH,
    online_voice_keys: { gemini: false, elevenlabs: false },
    tts_status: { state: "ready" },
    replay_status: REPLAY,
    relay_status: { configured: false, address: null, aliases: [] },
    discord_bot_status: { configured: false, chat: false, bot: false, label: null },
    finder_status: FINDER,
    ai_key_status: { anthropic: false, openai: false, gemini: false },
    telemetry_status: TELEMETRY,
    // Leaving the wake page ends its test run.
    wake_test: WAKE,
  };

  /** The sections Phase C rebuilt. The island's and the performance page's rows belong to their own tests. */
  const SECTIONS = ["you", "appearance", "profiles", "navigation", "dashboard", "assistant-brain", "wake", "games", "assistant", "finder", "ai", "local-ai", "startup", "updates", "integrations", "system", "shortcuts", "privacy", "about"];

  it.each(SECTIONS)("has a row for every searchable name in “%s”", async (section) => {
    vi.spyOn(native, "isDesktop").mockReturnValue(true);
    vi.spyOn(native, "callNative").mockImplementation(async (command: string) => {
      if (command in ANSWERS) return ANSWERS[command];
      throw new Error(`unexpected ${command}`);
    });
    useUi.setState({ settingsSection: section });
    renderWithQuery(<SettingsPage />);
    const names = SEARCHABLE.filter((setting) => setting.section === section).map((setting) => setting.label);
    expect(names.length).toBeGreaterThan(0);
    // A row may sit in a folded card: it is there all the same, which is what the jump needs.
    await waitFor(() => expect(names.filter((name) => !row(name))).toEqual([]));
  });

  it("names no section that doesn't exist", () => {
    renderWithQuery(<SettingsPage />);
    for (const section of new Set(SEARCHABLE.map((setting) => setting.section))) {
      act(() => useUi.getState().openSettings(section));
      expect(document.getElementById(`settings-${section}`), section).not.toBeNull();
    }
  });
});

describe("a folded card of settings", () => {
  it("opens when asked, and by itself when the search leads into it", () => {
    renderWithQuery(
      <MoreOptions title="Ton und Spiele">
        <div data-setting="Ton beim Wecken">Ton</div>
      </MoreOptions>,
    );
    const toggle = screen.getByRole("button", { name: /Ton und Spiele/ });
    const body = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // Folded, but there: the search finds the row before the card has opened.
    expect(body).not.toBeVisible();
    expect(row("Ton beim Wecken")).toBeDefined();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(body).not.toBeVisible();
    act(() => void window.dispatchEvent(new Event(REVEAL_SETTINGS_EVENT)));
    expect(body).toBeVisible();
  });
});
