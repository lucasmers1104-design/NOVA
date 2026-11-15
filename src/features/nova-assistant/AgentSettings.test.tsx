import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRecentSettings } from "@/features/settings/recent";
import * as native from "@/lib/native";
import { renderWithQuery } from "@/test/render";
import { AgentSettings, FinderSettings } from "./AgentSettings";
import { type AgentStatus, type AssistantStatus, DEFAULT_DOT_LOOK, type FinderStatus } from "./types";
import * as voice from "./voice";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}), emitTo: vi.fn(async () => {}) }));

const AGENT: AgentStatus = {
  prefs: { provider: null, models: {}, effort: "medium", monthlyLimitUsd: null, speakReplies: false, voice: "online:gemini:Kore", speechRate: 1, speechVolume: 1, language: "de-DE", keepListening: true, autoMode: false, memory: true },
  activeProvider: null,
  activeModel: null,
  keys: { anthropic: false, openai: false, gemini: true },
  usageThisMonth: { requests: 3, inputTokens: 1200, outputTokens: 800, costMicros: 0, unpricedRequests: 0 },
  running: false,
};

const DOT: AssistantStatus = {
  enabled: true,
  placement: "taskbar",
  corner: "bottomRight",
  look: { ...DEFAULT_DOT_LOOK, style: "ring" },
  taskbarAvailable: true,
  shortcut: "Ctrl+Alt+Space",
  background: false,
  hideInFullscreen: false,
  customPosition: false,
  docked: true,
  shortcutError: null,
  defaultShortcut: "Ctrl+Alt+Space",
  panelOpen: false,
  panelPinned: false,
};

describe("Modell & Stimme", () => {
  let agent: AgentStatus;
  let call: ReturnType<typeof vi.spyOn>;
  let speak: ReturnType<typeof vi.spyOn>;
  /** Ends the sample that is playing, as the voice does when it has said its sentence. */
  let finish: () => void;

  beforeEach(() => {
    agent = structuredClone(AGENT);
    useRecentSettings.setState({ recent: [] });
    voice.useVoice.setState({ mode: "idle", level: 0, novaVoice: null, onlineVoiceProblem: null });
    vi.spyOn(native, "isDesktop").mockReturnValue(true);
    call = vi.spyOn(native, "callNative").mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "assistant_agent_status") return agent;
      if (command === "assistant_agent_configure") {
        agent = { ...agent, prefs: args?.prefs as AgentStatus["prefs"] };
        return agent;
      }
      if (command === "assistant_status") return DOT;
      if (command === "online_voice_keys") return { gemini: true, elevenlabs: false };
      if (command === "tts_status") return { state: "ready" };
      throw new Error(`unexpected ${command}`);
    });
    speak = vi.spyOn(voice, "speak").mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    vi.spyOn(voice, "stopSpeaking").mockImplementation(() => finish?.());
  });

  const stage = () => screen.getByRole("group", { name: "Probe: so klingt NOVA" });
  const dot = () => stage().querySelector(".nova-dot")!;
  /** What the stage says about the voice (the sliders below have status lines of their own). */
  const said = () => within(stage()).getByRole("status");

  it("lets the chosen voice say a sentence, with the dot thinking and then speaking along", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AgentSettings />);
    // The stage shows the dot as it looks on the desktop, and names the voice.
    await waitFor(() => expect(dot()).toHaveAttribute("data-style", "ring"));
    expect(said()).toHaveTextContent("Kore, bestimmt");
    expect(dot()).toHaveAttribute("data-state", "idle");

    await user.type(screen.getByRole("textbox", { name: "Was NOVA sagen soll" }), "Guten Morgen, Luca");
    await user.click(screen.getByRole("button", { name: "Anhören" }));
    expect(speak).toHaveBeenCalledWith("Guten Morgen, Luca", expect.objectContaining({ voice: "online:gemini:Kore", speechRate: 1 }), "test", expect.any(Boolean));
    // Until the first sound the voice is being made.
    expect(dot()).toHaveAttribute("data-state", "thinking");
    expect(said()).toHaveTextContent("holt Luft");

    // The real voice reports that it speaks, and how loud: the dot follows that level.
    act(() => voice.useVoice.setState({ mode: "speaking", level: 0.7 }));
    expect(dot()).toHaveAttribute("data-state", "speaking");
    expect((dot() as HTMLElement).style.getPropertyValue("--level")).toBe("0.7");
    expect(said()).toHaveTextContent("Kore, bestimmt spricht");

    // The button stops it again.
    await user.click(screen.getByRole("button", { name: "Stopp" }));
    expect(voice.stopSpeaking).toHaveBeenCalled();
    act(() => voice.useVoice.setState({ mode: "idle", level: 0 }));
    await waitFor(() => expect(dot()).toHaveAttribute("data-state", "idle"));
    expect(screen.getByRole("button", { name: "Anhören" })).toBeInTheDocument();
  });

  it("says a German sentence by default, and applies speed and volume at once", async () => {
    const user = userEvent.setup();
    agent.prefs.voice = "nova:thorsten";
    renderWithQuery(<AgentSettings />);
    await waitFor(() => expect(said()).toHaveTextContent("Thorsten"));
    fireEvent.change(screen.getByRole("slider", { name: "Tempo" }), { target: { value: "1.4" } });
    await waitFor(() => expect(agent.prefs.speechRate).toBe(1.4));
    expect(await screen.findByText("1.4×")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("slider", { name: "Lautstärke" }), { target: { value: "0.5" } });
    await waitFor(() => expect(agent.prefs.speechVolume).toBe(0.5));
    expect(await screen.findByText("50 %")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Anhören" }));
    expect(speak).toHaveBeenLastCalledWith("Hallo, ich bin NOVA. So klinge ich.", expect.objectContaining({ voice: "nova:thorsten", speechRate: 1.4, speechVolume: 0.5 }), "test", true);
    // When the sentence is said, the stage rests again by itself.
    act(() => finish());
    await waitFor(() => expect(screen.getByRole("button", { name: "Anhören" })).toBeInTheDocument());
  });

  it("asks before auto mode goes on, and notes the change only once it is made", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AgentSettings />);
    await user.click(await screen.findByRole("switch", { name: "Auto-Modus" }));
    expect(call).not.toHaveBeenCalledWith("assistant_agent_configure", expect.anything());
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(useRecentSettings.getState().recent).toEqual([]);

    await user.click(screen.getByRole("switch", { name: "Auto-Modus" }));
    await user.click(screen.getByRole("button", { name: "Auf eigene Gefahr einschalten" }));
    await waitFor(() => expect(agent.prefs.autoMode).toBe(true));
    expect(useRecentSettings.getState().recent[0]).toMatchObject({ section: "assistant-brain", label: "Auto-Modus" });
    // Off again needs no question.
    await waitFor(() => expect(screen.getByRole("switch", { name: "Auto-Modus" })).toBeChecked());
    await user.click(screen.getByRole("switch", { name: "Auto-Modus" }));
    await waitFor(() => expect(agent.prefs.autoMode).toBe(false));
  });

  it("keeps the models, the limit and the language folded away, and saves a limit on leaving the field", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AgentSettings />);
    const fold = await screen.findByRole("button", { name: /Modelle, Kostenlimit und Sprache/ });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    await user.click(fold);
    expect(screen.getByText(/Diesen Monat: 3 Anfragen · 1.2k rein · 0.8k raus/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Monatslimit"), "7,5");
    await user.tab();
    await waitFor(() => expect(agent.prefs.monthlyLimitUsd).toBe(7.5));
    await user.selectOptions(screen.getByLabelText("Sprache der Spracherkennung"), "en-US");
    await waitFor(() => expect(agent.prefs.language).toBe("en-US"));
    await user.click(screen.getByRole("radio", { name: "Gründlich" }));
    await waitFor(() => expect(agent.prefs.effort).toBe("high"));
  });
});

describe("NOVA Finder", () => {
  const EMPTY: FinderStatus = { folders: [], content: true, progress: { running: false, scanned: 0, indexed: 0, current: null, lastFinished: null, error: null } };

  it("adds folders, asks before the whole PC, and removes a folder again", async () => {
    let finder = structuredClone(EMPTY);
    vi.spyOn(native, "isDesktop").mockReturnValue(true);
    const call = vi.spyOn(native, "callNative").mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "finder_pick_folder") finder = { ...finder, folders: [{ path: "D:\\Fotos", files: 1234, exists: true }] };
      else if (command === "finder_add_all_drives") finder = { ...finder, folders: [...finder.folders, { path: "C:\\", files: 99000, exists: true }] };
      else if (command === "finder_remove_folder") finder = { ...finder, folders: finder.folders.filter((folder) => folder.path !== args?.path) };
      else if (command === "finder_set_content") finder = { ...finder, content: args?.enabled as boolean };
      else if (command !== "finder_status") throw new Error(`unexpected ${command}`);
      return finder;
    });
    const user = userEvent.setup();
    renderWithQuery(<FinderSettings />);
    expect(await screen.findByText(/Noch keine Ordner/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ordner hinzufügen …" }));
    expect(await screen.findByText("D:\\Fotos")).toBeInTheDocument();
    expect(screen.getByText("1.234 Einträge im Index")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ganzen PC hinzufügen" }));
    expect(call).not.toHaveBeenCalledWith("finder_add_all_drives");
    expect(screen.getByText(/bleiben tabu/)).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Ganzen PC hinzufügen" }).at(-1)!);
    expect(await screen.findByText("C:\\")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "D:\\Fotos nicht mehr durchsuchen" }));
    await waitFor(() => expect(screen.queryByText("D:\\Fotos")).toBeNull());
    await user.click(screen.getByRole("switch", { name: "In Textdateien suchen" }));
    expect(call).toHaveBeenCalledWith("finder_set_content", { enabled: false });
  });
});
