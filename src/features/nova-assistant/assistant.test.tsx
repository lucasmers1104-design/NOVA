import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "@/components/ui/Markdown";
import * as native from "@/lib/native";
import { renderWithQuery } from "@/test/render";
import * as api from "./api";
import { sanitizeAppearance } from "./appearance";
import { AssistantSettings } from "./AssistantSettings";
import { WakeSettings } from "./WakeSettings";
import { usageLine } from "./components/NovaConversation";
import { BREATH_MS, NovaDot, REST_MS } from "./components/NovaDot";
import { NovaPanel } from "./components/NovaPanel";
import { reduceReply, replyText, useConversation } from "./conversation";
import { displayedState } from "./panel/PanelApp";
import { captureShortcut, shortcutLabels } from "./shortcut";
import { type AgentEvent, type AgentStatus, type AssistantStatus, DEFAULT_DOT_LOOK, type FinderStatus } from "./types";
import { NOVA_VOICE, speakableText, speaksGerman, speechChunks, usesNovaVoice, voiceLine } from "./voice";
import { voiceDescription } from "./AgentSettings";
import { NovaVoiceLine } from "./components/NovaVoiceLine";
import { describeHeard, listenerLabel, type WakeStatus } from "./wake";

// The assistant windows talk over Tauri events, which need the native bridge.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}), emitTo: vi.fn(async () => {}) }));
// Conversations stream over a Tauri channel; the tests drive the events directly.
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), sendMessage: vi.fn(), answerConfirmation: vi.fn() }));

const key = (code: string, mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe("assistant shortcuts", () => {
  it("captures key combinations in the format Rust registers", () => {
    expect(captureShortcut(key("Space", { ctrlKey: true, altKey: true }))).toEqual({ kind: "shortcut", shortcut: "Ctrl+Alt+Space" });
    expect(captureShortcut(key("KeyN", { metaKey: true, shiftKey: true }))).toEqual({ kind: "shortcut", shortcut: "Shift+Super+N" });
    expect(captureShortcut(key("Digit4", { altKey: true }))).toEqual({ kind: "shortcut", shortcut: "Alt+4" });
    expect(captureShortcut(key("ControlLeft", { ctrlKey: true }))).toEqual({ kind: "pending" });
    expect(captureShortcut(key("KeyA", { shiftKey: true })).kind).toBe("invalid");
  });

  it("labels shortcuts for display", () => {
    expect(shortcutLabels("Super+Shift+N")).toEqual(["Win", "Shift", "N"]);
    expect(shortcutLabels("Ctrl+Alt+Space")).toEqual(["Ctrl", "Alt", "Space"]);
    expect(shortcutLabels("Ctrl+KeyK")).toEqual(["Ctrl", "K"]);
    expect(shortcutLabels("")).toEqual([]);
  });

  it("validates appearance from settings", () => {
    expect(sanitizeAppearance({ accent: { kind: "preset", id: "cyan" }, transparency: false, motion: "reduced", displayName: "Luca" })).toEqual({
      accent: { kind: "preset", id: "cyan" },
      transparency: false,
      motion: "reduced",
      displayName: "Luca",
    });
    expect(sanitizeAppearance({ accent: "red", motion: "fast" })).toMatchObject({ accent: { kind: "preset", id: "purple" }, motion: "system" });
    expect(sanitizeAppearance(null).transparency).toBe(true);
  });
});

describe("NovaDot", () => {
  const handlers = () => ({ onToggle: vi.fn(), onMenu: vi.fn(), onDragStart: vi.fn() });

  it("toggles on click and announces its state", () => {
    const h = handlers();
    const { rerender } = render(<NovaDot look={DEFAULT_DOT_LOOK} open={false} {...h} />);
    const dot = screen.getByRole("button", { name: "Talk to NOVA" });
    expect(dot).toHaveAttribute("aria-expanded", "false");
    expect(dot).toHaveAttribute("title", "Talk to NOVA");

    fireEvent.pointerDown(dot, { button: 0, buttons: 1, screenX: 100, screenY: 100 });
    fireEvent.pointerMove(dot, { buttons: 1, screenX: 102, screenY: 101 });
    fireEvent.pointerUp(dot, { button: 0, screenX: 102, screenY: 101 });
    expect(h.onToggle).toHaveBeenCalledTimes(1);
    expect(h.onDragStart).not.toHaveBeenCalled();

    rerender(<NovaDot look={DEFAULT_DOT_LOOK} open {...h} />);
    expect(screen.getByRole("button", { name: "Close NOVA AI" })).toHaveAttribute("aria-expanded", "true");
  });

  it("hands longer pointer travel to a window drag instead of toggling", () => {
    const h = handlers();
    render(<NovaDot look={DEFAULT_DOT_LOOK} open={false} {...h} />);
    const dot = screen.getByRole("button", { name: "Talk to NOVA" });
    fireEvent.pointerDown(dot, { button: 0, buttons: 1, screenX: 100, screenY: 100 });
    fireEvent.pointerMove(dot, { buttons: 1, screenX: 110, screenY: 100 });
    fireEvent.pointerUp(dot, { button: 0, screenX: 110, screenY: 100 });
    expect(h.onDragStart).toHaveBeenCalledTimes(1);
    expect(h.onToggle).not.toHaveBeenCalled();
  });

  it("breathes in short bursts and rests in between", () => {
    vi.useFakeTimers();
    const breathing = { ...DEFAULT_DOT_LOOK, glow: true, breathe: true };
    const { rerender } = render(<NovaDot look={breathing} open={false} {...handlers()} />);
    const dot = screen.getByRole("button", { name: "Talk to NOVA" });
    expect(dot).toHaveAttribute("data-breathing", "true");
    act(() => vi.advanceTimersByTime(2 * BREATH_MS));
    expect(dot).toHaveAttribute("data-breathing", "false");
    act(() => vi.advanceTimersByTime(REST_MS));
    expect(dot).toHaveAttribute("data-breathing", "true");
    act(() => vi.advanceTimersByTime(BREATH_MS));
    expect(dot).toHaveAttribute("data-breathing", "false");
    // While the panel is open the ring shows instead.
    rerender(<NovaDot look={breathing} open {...handlers()} />);
    act(() => vi.advanceTimersByTime(REST_MS));
    expect(screen.getByRole("button", { name: "Close NOVA AI" })).toHaveAttribute("data-breathing", "false");
    vi.useRealTimers();
  });

  it("stays still unless it glows and may breathe", () => {
    render(<NovaDot look={DEFAULT_DOT_LOOK} open={false} {...handlers()} />);
    expect(screen.getByRole("button", { name: "Talk to NOVA" })).toHaveAttribute("data-breathing", "false");
  });

  it("draws the chosen look", () => {
    const look = { ...DEFAULT_DOT_LOOK, style: "ring" as const, diameter: 30, idleOpacity: 40, color: "white", icon: false, activity: false };
    const { container } = render(<NovaDot look={look} open={false} state="thinking" {...handlers()} />);
    const dot = screen.getByRole("button", { name: "Talk to NOVA" });
    expect(dot).toHaveAttribute("data-style", "ring");
    expect(dot).toHaveAttribute("data-light", "true");
    expect(dot).toHaveAttribute("data-activity", "false");
    expect(dot).toHaveAttribute("data-busy", "true");
    expect(dot.style.getPropertyValue("--dot")).toBe("30px");
    expect(dot.style.getPropertyValue("--idle")).toBe("0.4");
    expect(container.querySelector(".nova-dot__glow")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("opens its menu on right-click and works from the keyboard", () => {
    const h = handlers();
    render(<NovaDot look={DEFAULT_DOT_LOOK} open={false} {...h} />);
    const dot = screen.getByRole("button", { name: "Talk to NOVA" });
    fireEvent.contextMenu(dot);
    expect(h.onMenu).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(dot, { key: "Enter" });
    expect(h.onToggle).toHaveBeenCalledTimes(1);
  });

  it("can be drawn as pointed at for the preview", () => {
    const { rerender } = render(<NovaDot look={DEFAULT_DOT_LOOK} open={false} {...handlers()} />);
    expect(screen.getByRole("button", { name: "Talk to NOVA" })).not.toHaveAttribute("data-hover");
    rerender(<NovaDot look={DEFAULT_DOT_LOOK} open={false} hovered {...handlers()} />);
    expect(screen.getByRole("button", { name: "Talk to NOVA" })).toHaveAttribute("data-hover", "true");
  });
});

const AGENT: AgentStatus = {
  prefs: { provider: null, models: {}, effort: "medium", monthlyLimitUsd: null, speakReplies: false, voice: "", speechRate: 1, speechVolume: 1, language: "auto" },
  activeProvider: "Anthropic",
  activeModel: "claude-opus-5-5",
  keys: { anthropic: true, openai: false, gemini: false },
  usageThisMonth: { requests: 0, inputTokens: 0, outputTokens: 0, costMicros: 0, unpricedRequests: 0 },
  running: false,
};

const NO_FOLDERS: FinderStatus = {
  folders: [],
  content: true,
  progress: { running: false, scanned: 0, indexed: 0, current: null, lastFinished: null, error: null },
};

function renderPanel(overrides: Partial<Parameters<typeof NovaPanel>[0]> = {}) {
  const props = {
    origin: "bottomRight" as const,
    name: "Luca",
    agent: AGENT,
    finder: NO_FOLDERS,
    state: "idle" as const,
    onCollapse: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenProviders: vi.fn(),
    onIndexFolders: vi.fn(),
    onToggleSpeech: vi.fn(),
    onVoiceTurn: vi.fn(),
    ...overrides,
  };
  render(<NovaPanel {...props} />);
  return props;
}

const HITS = [
  { path: "C:\\Users\\me\\Documents\\LEGO_v2.xlsx", name: "LEGO_v2.xlsx", ext: "xlsx", folder: "C:\\Users\\me\\Documents", kind: "spreadsheet", size: 20480, modified: Date.now(), snippet: null },
  { path: "C:\\Users\\me\\Documents\\Old\\LEGO_v1.xlsx", name: "LEGO_v1.xlsx", ext: "xlsx", folder: "C:\\Users\\me\\Documents\\Old", kind: "spreadsheet", size: 10240, modified: 0, snippet: null },
];

describe("NovaPanel", () => {
  beforeEach(() => {
    useConversation.setState({ items: [], state: "idle", detail: null, busy: false, attachments: [], lastPrompt: null });
  });

  it("greets quietly and keeps everything else in one menu", async () => {
    const user = userEvent.setup();
    const props = renderPanel();
    expect(screen.getByRole("dialog", { name: "NOVA AI" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/, Luca$/);
    expect(screen.getByText("How can I help?")).toBeInTheDocument();
    // No footer, no row of header buttons.
    expect(screen.queryByText("Microphone off")).toBeNull();
    expect(screen.queryByRole("button", { name: "New conversation" })).toBeNull();
    expect(screen.getAllByRole("button").filter((b) => b.closest("header"))).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Index my folders for smarter file search" }));
    expect(props.onIndexFolders).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(props.onCollapse).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitemradio", { name: "Read replies aloud" })).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("menuitem", { name: "Assistant settings" }));
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Anthropic · claude-opus-5-5" }));
    expect(props.onOpenProviders).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Read replies aloud" }));
    expect(props.onToggleSpeech).toHaveBeenCalledOnce();
  });

  it("explains local mode without a provider", async () => {
    const user = userEvent.setup();
    const props = renderPanel({ agent: { ...AGENT, activeProvider: null, activeModel: null } });
    expect(screen.getByText("I can find files and open apps for you.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect an AI provider for conversations and documents" }));
    expect(props.onOpenProviders).toHaveBeenCalledOnce();
  });

  it("puts files and screenshots behind one add button", async () => {
    const user = userEvent.setup();
    const targets = vi.spyOn(api, "captureTargets").mockResolvedValue({
      screens: [{ index: 0, label: "Display 1", primary: true, width: 1920, height: 1080, current: true }],
      window: "Untitled - Notepad",
    });
    renderPanel();
    await user.click(screen.getByRole("button", { name: "Add a file or a screenshot" }));
    const menu = await screen.findByRole("menu", { name: "Add" });
    expect(menu).toHaveTextContent("Attach a file…");
    expect(await screen.findByRole("menuitem", { name: /My screen/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Untitled - Notepad" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Add" })).toBeNull();
    targets.mockRestore();
  });

  it("streams a reply with tool results, asks before changes and shows usage", async () => {
    const user = userEvent.setup();
    let emit: (event: AgentEvent) => void = () => {};
    let finish: () => void = () => {};
    vi.mocked(api.sendMessage).mockImplementation((_text, onEvent) => {
      emit = onEvent;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    vi.mocked(api.answerConfirmation).mockResolvedValue();
    renderPanel();

    await user.type(screen.getByRole("textbox", { name: "Message NOVA" }), "Finde meine LEGO-Berechnung{Enter}");
    expect(api.sendMessage).toHaveBeenCalledWith("Finde meine LEGO-Berechnung", expect.any(Function));
    expect(screen.getByText("Finde meine LEGO-Berechnung")).toBeInTheDocument();

    act(() => {
      emit({ type: "status", state: "searching", detail: "Search files for “lego berechnung”" });
      emit({ type: "text", text: "Ich suche " });
      emit({ type: "text", text: "danach." });
      emit({ type: "toolStarted", id: "t1", name: "search_files", title: "Search files for “lego berechnung”", risk: "safe" });
      emit({ type: "toolFinished", id: "t1", ok: true, summary: "2 matches", card: { kind: "files", hits: HITS, source: "index" } });
      emit({ type: "toolStarted", id: "t2", name: "delete_item", title: "Delete LEGO_v1.xlsx", risk: "high" });
      emit({ type: "confirmRequired", id: "t2", title: "Delete LEGO_v1.xlsx", detail: "Moves this file to the Recycle Bin.", risk: "high" });
    });
    expect(screen.getByText("Ich suche danach.")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Search results" })).toHaveTextContent("LEGO_v2.xlsx");
    const confirmation = screen.getByRole("alertdialog", { name: /Delete LEGO_v1.xlsx/ });
    expect(confirmation).toHaveTextContent("Moves this file to the Recycle Bin.");

    await user.click(screen.getByRole("button", { name: "Yes, do it" }));
    expect(api.answerConfirmation).toHaveBeenCalledWith("t2", true);

    act(() => {
      emit({ type: "toolFinished", id: "t2", ok: true, summary: "Moved LEGO_v1.xlsx to the Recycle Bin", card: null });
      emit({ type: "usage", provider: "Anthropic", model: "claude-opus-5-5", inputTokens: 1200, outputTokens: 300, costUsd: 0.0108 });
      emit({ type: "status", state: "completed", detail: null });
      emit({ type: "done" });
      finish();
    });
    await waitFor(() => expect(screen.getByText("claude-opus-5-5 · 1.2k in · 300 out · ≈ $0.0108")).toBeInTheDocument());
    expect(screen.getByText("Moved LEGO_v1.xlsx to the Recycle Bin")).toBeInTheDocument();
    // A conversation can be started over from the header.
    expect(screen.getByRole("button", { name: "New conversation" })).toBeInTheDocument();
  });

  it("shows errors with a retry", async () => {
    const user = userEvent.setup();
    vi.mocked(api.sendMessage).mockImplementation(async (_text, onEvent) => onEvent({ type: "failed", error: "The API key was rejected" }));
    renderPanel();
    await user.type(screen.getByRole("textbox", { name: "Message NOVA" }), "Hallo{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("The API key was rejected");
    await user.click(screen.getByRole("button", { name: /Retry/ }));
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("copies a reply and brings the last message back with Up", async () => {
    const user = userEvent.setup();
    vi.mocked(api.sendMessage).mockImplementation(async (_text, onEvent) => {
      onEvent({ type: "text", text: "Hier ist die Antwort." });
      onEvent({ type: "done" });
    });
    renderPanel();
    const box = screen.getByRole("textbox", { name: "Message NOVA" });
    await user.type(box, "Wie spät ist es?{Enter}");
    await user.click(await screen.findByRole("button", { name: "Copy reply" }));
    expect(await navigator.clipboard.readText()).toBe("Hier ist die Antwort.");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

    await waitFor(() => expect(box).toHaveValue(""));
    box.focus();
    await user.keyboard("{ArrowUp}");
    expect(box).toHaveValue("Wie spät ist es?");
  });

  it("starts a new conversation with Ctrl+N and copies the last reply with Ctrl+Shift+C", async () => {
    const user = userEvent.setup();
    vi.mocked(api.sendMessage).mockImplementation(async (_text, onEvent) => {
      onEvent({ type: "text", text: "Erledigt." });
      onEvent({ type: "done" });
    });
    const resetConversation = vi.spyOn(api, "resetConversation").mockResolvedValue();
    renderPanel();
    // Nothing to start over from yet.
    fireEvent.keyDown(window, { key: "n", code: "KeyN", ctrlKey: true });
    expect(screen.getByText("How can I help?")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Message NOVA" }), "Öffne den Rechner{Enter}");
    expect(await screen.findByText("Erledigt.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New conversation" })).toHaveAttribute("title", "New conversation (Ctrl+N)");
    // Plain typing is left alone.
    fireEvent.keyDown(window, { key: "n", code: "KeyN" });
    expect(screen.getByText("Erledigt.")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "C", code: "KeyC", ctrlKey: true, shiftKey: true });
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe("Erledigt."));

    fireEvent.keyDown(window, { key: "n", code: "KeyN", ctrlKey: true });
    expect(await screen.findByText("How can I help?")).toBeInTheDocument();
    expect(screen.queryByText("Erledigt.")).toBeNull();
    expect(resetConversation).toHaveBeenCalledOnce();
    resetConversation.mockRestore();
  });

  it("shows the action history under the header title", async () => {
    const user = userEvent.setup();
    const history = vi.spyOn(api, "actionHistory").mockResolvedValue([]);
    renderPanel();
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Action history" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("What NOVA did");
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(await screen.findByText(/Nothing yet/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to the conversation" }));
    expect(screen.getByText("How can I help?")).toBeInTheDocument();
    history.mockRestore();
  });
});

describe("conversation helpers", () => {
  const empty = { kind: "assistant" as const, id: "a", segments: [], streaming: true, usage: [], error: null };

  it("interleaves text and tools in order", () => {
    let reply = reduceReply(empty, { type: "text", text: "A" });
    reply = reduceReply(reply, { type: "toolStarted", id: "t", name: "open_app", title: "Open Spotify", risk: "safe" });
    reply = reduceReply(reply, { type: "text", text: "B" });
    reply = reduceReply(reply, { type: "toolFinished", id: "t", ok: true, summary: "Opened Spotify", card: { kind: "app", name: "Spotify" } });
    expect(reply.segments.map((s) => s.type)).toEqual(["text", "tool", "text"]);
    expect(replyText(reply)).toBe("A\n\nB");
    const declined = reduceReply(
      reduceReply(reduceReply(empty, { type: "toolStarted", id: "d", name: "delete_item", title: "Delete x", risk: "high" }), { type: "confirmRequired", id: "d", title: "Delete x", detail: null, risk: "high" }),
      { type: "toolFinished", id: "d", ok: false, summary: "Not allowed", card: null },
    );
    expect(declined.segments[0]).toMatchObject({ type: "tool", tool: { state: "declined" } });
  });

  it("summarizes usage across rounds, with cost only when every round is priced", () => {
    const round = { provider: "Anthropic", model: "claude-opus-5-5", inputTokens: 900, outputTokens: 100, costUsd: 0.0056 };
    expect(usageLine([round, round])).toBe("claude-opus-5-5 · 1.8k in · 200 out · ≈ $0.0112");
    expect(usageLine([{ ...round, costUsd: null }])).toBe("claude-opus-5-5 · 900 in · 100 out");
    expect(usageLine([])).toBeNull();
  });

  it("prepares replies for reading aloud", () => {
    expect(speakableText("## Ergebnis\n\n- **LEGO_v2.xlsx** in `C:\\Users\\me`\n- [Link](https://x.y)")).toBe("Ergebnis LEGO_v2.xlsx in Link");
    expect(speakableText("```js\nlet x\n```Fertig")).toBe("Fertig");
  });

  it("keeps underscores in file names out of Markdown emphasis", () => {
    const { container } = render(<Markdown source="Gefunden: LEGO_Berechnung_v2.xlsx und _wichtig_ und __fett__" />);
    expect(container).toHaveTextContent("Gefunden: LEGO_Berechnung_v2.xlsx und wichtig und fett");
    expect(container.querySelectorAll("em")).toHaveLength(1);
    expect(container.querySelectorAll("strong")).toHaveLength(1);
  });

  it("greets and acknowledges in the language NOVA listens in", () => {
    expect(speaksGerman("de-DE")).toBe(true);
    expect(speaksGerman("auto", "de-AT")).toBe(true);
    expect(speaksGerman("en-US", "de-DE")).toBe(false);
    expect(voiceLine("greet", "de-DE", () => 0)).toBe("Hey! Was kann ich für dich tun?");
    expect(voiceLine("ack", "de-DE", () => 0)).toMatch(/Einen Moment/);
    expect(voiceLine("ack", "en-US", () => 0.99)).toBe("Alright, let me look into that.");
  });

  it("shows what was understood with a voice line to finish or cancel", async () => {
    const user = userEvent.setup();
    const done = vi.fn();
    const cancel = vi.fn();
    const { rerender } = render(<NovaVoiceLine level={0.4} active ready={false} transcript="" german onDone={done} onCancel={cancel} />);
    // The microphone isn't open yet: don't invite speaking.
    expect(screen.getByRole("group", { name: "NOVA is listening" })).toHaveTextContent("Einen Moment");
    rerender(<NovaVoiceLine level={0.4} active ready transcript="" german onDone={done} onCancel={cancel} />);
    expect(screen.getByRole("group", { name: "NOVA is listening" })).toHaveTextContent("Ich höre zu");
    rerender(<NovaVoiceLine level={0.4} active ready transcript="Öffne meine Downloads" german onDone={done} onCancel={cancel} />);
    expect(screen.getByText("Öffne meine Downloads")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Done, send it" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(done).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    rerender(<NovaVoiceLine level={0} active={false} ready transcript="" german={false} onDone={done} onCancel={cancel} />);
    expect(screen.getByText("One moment …")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done, send it" })).toBeDisabled();
  });

  it("speaks German with NOVA's own voice unless a Windows voice is chosen", () => {
    expect(usesNovaVoice("Ich habe drei Dateien gefunden.", "")).toBe(true);
    expect(usesNovaVoice("I found three files.", "")).toBe(false);
    expect(usesNovaVoice("I found three files.", NOVA_VOICE)).toBe(true);
    expect(usesNovaVoice("Ich habe drei Dateien gefunden.", "Microsoft Katja")).toBe(false);
    expect(voiceDescription("", { state: "downloading", percent: 42 })).toMatch(/42 %/);
    expect(voiceDescription("Microsoft Katja", { state: "ready" })).toMatch(/Windows voice/);
  });

  it("cuts replies into sentences NOVA's voice says one after another", () => {
    expect(speechChunks("Hey! Was kann ich für dich tun? Alles klar. Gut. Ich hab drei Rechnungen gefunden.")).toEqual([
      "Hey!",
      "Was kann ich für dich tun? Alles klar. Gut.",
      "Ich hab drei Rechnungen gefunden.",
    ]);
    const long = "Das ist ein sehr langer Satz, der immer weiter geht, ".repeat(8).trim();
    const chunks = speechChunks(long, 120);
    expect(chunks.every((c) => c.length <= 120)).toBe(true);
    expect(chunks.join(" ")).toBe(long);
    expect(speechChunks("   ")).toEqual([]);
  });

  it("prefers voice states in the header", () => {
    expect(displayedState("thinking", "idle")).toBe("thinking");
    expect(displayedState("idle", "listening")).toBe("listening");
  });
});

describe("AssistantSettings", () => {
  const STATUS: AssistantStatus = {
    enabled: true,
    placement: "taskbar",
    corner: "bottomRight",
    look: DEFAULT_DOT_LOOK,
    taskbarAvailable: true,
    shortcut: "Ctrl+Alt+Space",
    background: false,
    hideInFullscreen: false,
    customPosition: false,
    shortcutError: null,
    defaultShortcut: "Ctrl+Alt+Space",
    panelOpen: false,
  };
  let status: AssistantStatus;
  let autostart: boolean;
  let call: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    status = { ...STATUS };
    autostart = false;
    vi.spyOn(native, "isDesktop").mockReturnValue(true);
    call = vi.spyOn(native, "callNative").mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "assistant_status") return status;
      if (command === "assistant_configure") {
        const update = args?.update as Partial<AssistantStatus>;
        if (update.shortcut === "Ctrl+Alt+J") throw new Error("This shortcut is already used by another app. Choose a different one.");
        status = { ...status, ...update };
        return status;
      }
      if (command === "assistant_reset_position") {
        status = { ...status, customPosition: false };
        return status;
      }
      if (command === "autostart_get") return autostart;
      if (command === "autostart_set") {
        autostart = args?.enabled as boolean;
        return autostart;
      }
      throw new Error(`unexpected ${command}`);
    });
  });

  it("turns Start with Windows on and off", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AssistantSettings />);
    const toggle = await screen.findByRole("switch", { name: "Start with Windows" });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/starts in the background with just the dot/)).toBeInTheDocument();
    await user.click(toggle);
    expect(call).toHaveBeenCalledWith("autostart_set", { enabled: true });
    await waitFor(() => expect(toggle).toBeChecked());
    await user.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(autostart).toBe(false);
  });

  it("sends complete preferences when one setting changes", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AssistantSettings />);
    // While the dot is shown, NOVA always stays available after the window closes.
    expect(await screen.findByRole("switch", { name: "Keep NOVA AI available when the window is closed" })).toBeDisabled();
    await user.click(screen.getByRole("switch", { name: "Show the NOVA dot" }));
    expect(call).toHaveBeenCalledWith("assistant_configure", {
      update: { enabled: false, placement: "taskbar", corner: "bottomRight", look: DEFAULT_DOT_LOOK, shortcut: "Ctrl+Alt+Space", background: false, hideInFullscreen: false },
    });
    await user.click(screen.getByRole("switch", { name: "Keep NOVA AI available when the window is closed" }));
    await user.click(screen.getByRole("switch", { name: "Show the NOVA dot" }));
    // Corners appear once the dot leaves the taskbar.
    expect(screen.queryByRole("radio", { name: "Top left" })).toBeNull();
    await user.click(screen.getByRole("radio", { name: "In a corner" }));
    await user.click(await screen.findByRole("radio", { name: "Top left" }));
    await waitFor(() => expect(call).toHaveBeenLastCalledWith("assistant_configure", { update: expect.objectContaining({ enabled: true, placement: "corner", corner: "topLeft", background: true }) }));
  });

  it("records a new shortcut and shows why one was rejected", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AssistantSettings />);
    await user.click(await screen.findByRole("button", { name: "Change keyboard shortcut" }));
    fireEvent.keyDown(window, { code: "KeyA", key: "a" });
    expect(screen.getByText("Add Ctrl, Alt or Win")).toBeInTheDocument();
    fireEvent.keyDown(window, { code: "KeyN", key: "n", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(call).toHaveBeenCalledWith("assistant_configure", { update: expect.objectContaining({ shortcut: "Ctrl+Shift+N" }) }));

    await user.click(screen.getByRole("button", { name: "Change keyboard shortcut" }));
    fireEvent.keyDown(window, { code: "KeyJ", key: "j", ctrlKey: true, altKey: true });
    expect(await screen.findByText(/already used by another app/)).toBeInTheDocument();
    expect(status.shortcut).toBe("Ctrl+Shift+N");
  });

  it("offers to move a dragged dot back", async () => {
    status.customPosition = true;
    const user = userEvent.setup();
    renderWithQuery(<AssistantSettings />);
    await user.click(await screen.findByRole("button", { name: "Put it back" }));
    expect(call).toHaveBeenCalledWith("assistant_reset_position");
    expect(await screen.findByText(/In the taskbar, right after your app buttons/)).toBeInTheDocument();
  });

  it("previews look changes at once and saves them", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithQuery(<AssistantSettings />);
    await user.click(await screen.findByRole("radio", { name: "Ring" }));
    expect(screen.getByRole("button", { name: "Talk to NOVA" })).toHaveAttribute("data-style", "ring");
    await waitFor(() => expect(call).toHaveBeenLastCalledWith("assistant_configure", { update: expect.objectContaining({ look: expect.objectContaining({ style: "ring" }) }) }));

    fireEvent.change(screen.getByRole("slider", { name: "Dot size" }), { target: { value: "40" } });
    expect(screen.getByRole("button", { name: "Talk to NOVA" }).style.getPropertyValue("--dot")).toBe("40px");
    act(() => vi.advanceTimersByTime(300));
    await waitFor(() => expect(call).toHaveBeenLastCalledWith("assistant_configure", { update: expect.objectContaining({ look: expect.objectContaining({ style: "ring", diameter: 40 }) }) }));

    await user.click(screen.getByRole("radio", { name: "White" }));
    await waitFor(() => expect(status.look.color).toBe("white"));
    await user.click(screen.getByRole("button", { name: "Back to the default look" }));
    await waitFor(() => expect(status.look).toEqual(DEFAULT_DOT_LOOK));
    vi.useRealTimers();
  });

  it("previews the dot as pointed at", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AssistantSettings />);
    const preview = await screen.findByRole("group", { name: "Dot preview" });
    expect(screen.getByRole("button", { name: "Talk to NOVA" })).not.toHaveAttribute("data-hover");
    await user.click(screen.getByRole("radio", { name: "Hover" }));
    expect(preview.querySelector(".nova-dot")).toHaveAttribute("data-hover", "true");
    expect(preview.querySelector(".nova-dot")).toHaveAttribute("data-state", "idle");
  });
});

describe("WakeSettings", () => {
  const OFF: WakeStatus = {
    prefs: { phrase: false, phraseSensitivity: "strict", clap: false, clapSensitivity: "strict", afterWake: "listen", chime: true, pauseInFullscreen: true, muted: false },
    phrase: { state: "off" },
    clap: { state: "off" },
    dictation: false,
    testing: false,
  };
  let status: WakeStatus;
  let call: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    status = structuredClone(OFF);
    vi.spyOn(native, "isDesktop").mockReturnValue(true);
    call = vi.spyOn(native, "callNative").mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "wake_status") return status;
      if (command === "wake_configure") {
        const prefs = args?.prefs as WakeStatus["prefs"];
        status = { ...status, prefs, clap: prefs.clap ? { state: "listening" } : { state: "off" } };
        return status;
      }
      if (command === "wake_test") {
        status = { ...status, testing: Boolean(args?.on) };
        return status;
      }
      if (command === "voice_open_settings") return undefined;
      throw new Error(`unexpected ${command}`);
    });
  });

  it("turns on the double clap and shows that NOVA listens", async () => {
    const user = userEvent.setup();
    renderWithQuery(<WakeSettings />);
    await user.click(await screen.findByRole("switch", { name: "Wake with a double clap" }));
    expect(call).toHaveBeenCalledWith("wake_configure", { prefs: { ...OFF.prefs, clap: true } });
    expect(await screen.findByRole("status")).toHaveTextContent("Listening");
    expect(screen.getByRole("radio", { name: "Very precise" })).toHaveAttribute("aria-checked", "true");
  });

  it("offers to resume listening paused from the dot's menu", async () => {
    status = { ...status, prefs: { ...status.prefs, clap: true, muted: true }, clap: { state: "paused", reason: "muted" } };
    const user = userEvent.setup();
    renderWithQuery(<WakeSettings />);
    expect(await screen.findByText(/Paused from the dot's menu/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resume" }));
    expect(call).toHaveBeenCalledWith("wake_configure", { prefs: expect.objectContaining({ clap: true, muted: false }) });
  });

  it("explains that listening after waking needs online speech recognition", async () => {
    const user = userEvent.setup();
    renderWithQuery(<WakeSettings />);
    await user.click(await screen.findByRole("button", { name: "Turn it on" }));
    expect(call).toHaveBeenCalledWith("voice_open_settings", { page: "privacy-speech" });
  });

  it("runs a test that opens nothing", async () => {
    const user = userEvent.setup();
    renderWithQuery(<WakeSettings />);
    await user.click(await screen.findByRole("button", { name: "Start test" }));
    expect(call).toHaveBeenCalledWith("wake_test", { on: true });
    expect(await screen.findByRole("meter", { name: "Microphone level" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(call).toHaveBeenLastCalledWith("wake_test", { on: false });
  });

  it("logs what the test heard with times and clears the log", async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const { ASSISTANT_EVENTS } = await import("./types");
    status.prefs.clap = true;
    const user = userEvent.setup();
    renderWithQuery(<WakeSettings />);
    expect(await screen.findByText(/How to clap/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start test" }));
    expect(await screen.findByText(/left$/)).toHaveTextContent("2:00 left");
    const heard = await waitFor(() => {
      const found = [...vi.mocked(listen).mock.calls].reverse().find(([event]) => event === ASSISTANT_EVENTS.wakeHeard);
      expect(found).toBeDefined();
      return found![1] as (event: { payload: unknown }) => void;
    });
    act(() => heard({ payload: { kind: "double", veto: null } }));
    const log = screen.getByRole("list", { name: "What NOVA heard" });
    expect(log).toHaveTextContent("0:00");
    expect(log).toHaveTextContent("Double clap — NOVA would open");
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(log).not.toHaveTextContent("Double clap");
    expect(log).toHaveTextContent("Listening…");
  });

  it("describes what it heard", () => {
    expect(describeHeard({ kind: "double", veto: null })).toEqual({ text: "Double clap — NOVA would open", tone: "good" });
    expect(describeHeard({ kind: "double", veto: "typing" })?.tone).toBe("warn");
    expect(describeHeard({ kind: "notAClap", levelDb: -20, reason: "tonal" })?.text).toMatch(/tone or a glass/);
    expect(describeHeard({ kind: "phrase", text: "hey noah", confidence: "high", accepted: false })?.text).toBe("Heard “hey noah” (high) — ignored");
    expect(describeHeard({ kind: "level", value: 0.4 })).toBeNull();
    expect(listenerLabel({ state: "paused", reason: "dictation" })).toBe("Paused while you dictate");
    expect(listenerLabel({ state: "unavailable", message: "No microphone was found.", settings: null })).toBe("No microphone was found.");
  });
});
