import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "@/components/ui/Markdown";
import * as native from "@/lib/native";
import { renderWithQuery } from "@/test/render";
import * as api from "./api";
import { sanitizeAppearance } from "./appearance";
import { AssistantSettings } from "./AssistantSettings";
import { usageLine } from "./components/NovaConversation";
import { BREATH_MS, NovaDot, REST_MS } from "./components/NovaDot";
import { NovaPanel } from "./components/NovaPanel";
import { reduceReply, replyText, useConversation } from "./conversation";
import { displayedState } from "./panel/PanelApp";
import { captureShortcut, shortcutLabels } from "./shortcut";
import type { AgentEvent, AgentStatus, AssistantStatus, FinderStatus } from "./types";
import { speakableText } from "./voice";

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
    const { rerender } = render(<NovaDot size="medium" open={false} {...h} />);
    const dot = screen.getByRole("button", { name: "Talk to NOVA" });
    expect(dot).toHaveAttribute("aria-expanded", "false");
    expect(dot).toHaveAttribute("title", "Talk to NOVA");

    fireEvent.pointerDown(dot, { button: 0, buttons: 1, screenX: 100, screenY: 100 });
    fireEvent.pointerMove(dot, { buttons: 1, screenX: 102, screenY: 101 });
    fireEvent.pointerUp(dot, { button: 0, screenX: 102, screenY: 101 });
    expect(h.onToggle).toHaveBeenCalledTimes(1);
    expect(h.onDragStart).not.toHaveBeenCalled();

    rerender(<NovaDot size="large" open {...h} />);
    expect(screen.getByRole("button", { name: "Close NOVA AI" })).toHaveAttribute("aria-expanded", "true");
  });

  it("hands longer pointer travel to a window drag instead of toggling", () => {
    const h = handlers();
    render(<NovaDot size="small" open={false} {...h} />);
    const dot = screen.getByRole("button", { name: "Talk to NOVA" });
    fireEvent.pointerDown(dot, { button: 0, buttons: 1, screenX: 100, screenY: 100 });
    fireEvent.pointerMove(dot, { buttons: 1, screenX: 110, screenY: 100 });
    fireEvent.pointerUp(dot, { button: 0, screenX: 110, screenY: 100 });
    expect(h.onDragStart).toHaveBeenCalledTimes(1);
    expect(h.onToggle).not.toHaveBeenCalled();
  });

  it("breathes in short bursts and rests in between", () => {
    vi.useFakeTimers();
    const { rerender } = render(<NovaDot size="medium" open={false} {...handlers()} />);
    const dot = screen.getByRole("button", { name: "Talk to NOVA" });
    expect(dot).toHaveAttribute("data-breathing", "true");
    act(() => vi.advanceTimersByTime(2 * BREATH_MS));
    expect(dot).toHaveAttribute("data-breathing", "false");
    act(() => vi.advanceTimersByTime(REST_MS));
    expect(dot).toHaveAttribute("data-breathing", "true");
    act(() => vi.advanceTimersByTime(BREATH_MS));
    expect(dot).toHaveAttribute("data-breathing", "false");
    // While the panel is open the ring shows instead.
    rerender(<NovaDot size="medium" open {...handlers()} />);
    act(() => vi.advanceTimersByTime(REST_MS));
    expect(screen.getByRole("button", { name: "Close NOVA AI" })).toHaveAttribute("data-breathing", "false");
    vi.useRealTimers();
  });

  it("opens its menu on right-click and works from the keyboard", () => {
    const h = handlers();
    render(<NovaDot size="medium" open={false} {...h} />);
    const dot = screen.getByRole("button", { name: "Talk to NOVA" });
    fireEvent.contextMenu(dot);
    expect(h.onMenu).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(dot, { key: "Enter" });
    expect(h.onToggle).toHaveBeenCalledTimes(1);
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
    shortcut: "Ctrl+Alt+N",
    shortcutError: null,
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

  it("greets, offers setup and wires its header and footer", async () => {
    const user = userEvent.setup();
    const props = renderPanel();
    expect(screen.getByRole("dialog", { name: "NOVA AI" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/, Luca$/);
    expect(screen.getByText(/anywhere to open NOVA AI/)).toHaveTextContent("Press CtrlAltN anywhere");
    expect(screen.getByText("Microphone off")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Index my folders" }));
    expect(props.onIndexFolders).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Minimize to the dot" }));
    await user.click(screen.getByRole("button", { name: "Close (keeps the conversation)" }));
    expect(props.onCollapse).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Assistant settings" }));
    expect(props.onOpenSettings).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Anthropic · claude-opus-5-5" }));
    expect(props.onOpenProviders).toHaveBeenCalledOnce();
  });

  it("explains local mode without a provider", async () => {
    const user = userEvent.setup();
    const props = renderPanel({ agent: { ...AGENT, activeProvider: null, activeModel: null } });
    expect(screen.getByText(/Local mode: I can find files and open apps/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect an AI provider" }));
    expect(props.onOpenProviders).toHaveBeenCalledOnce();
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

  it("prefers voice states in the header", () => {
    expect(displayedState("thinking", "idle")).toBe("thinking");
    expect(displayedState("idle", "listening")).toBe("listening");
  });
});

describe("AssistantSettings", () => {
  const STATUS: AssistantStatus = {
    enabled: true,
    corner: "bottomRight",
    size: "medium",
    shortcut: "Ctrl+Alt+Space",
    background: false,
    hideInFullscreen: false,
    customPosition: false,
    shortcutError: null,
    defaultShortcut: "Ctrl+Alt+Space",
    panelOpen: false,
  };
  let status: AssistantStatus;
  let call: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    status = { ...STATUS };
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
      throw new Error(`unexpected ${command}`);
    });
  });

  it("sends complete preferences when one setting changes", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AssistantSettings />);
    await user.click(await screen.findByRole("switch", { name: "Keep NOVA AI available when the window is closed" }));
    expect(call).toHaveBeenCalledWith("assistant_configure", {
      update: { enabled: true, corner: "bottomRight", size: "medium", shortcut: "Ctrl+Alt+Space", background: true, hideInFullscreen: false },
    });
    await user.click(screen.getByRole("radio", { name: "Top left" }));
    await waitFor(() => expect(call).toHaveBeenLastCalledWith("assistant_configure", { update: expect.objectContaining({ corner: "topLeft", background: true }) }));
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
    await user.click(await screen.findByRole("button", { name: "Move it back to the corner" }));
    expect(call).toHaveBeenCalledWith("assistant_reset_position");
    expect(await screen.findByText(/A corner of your main display/)).toBeInTheDocument();
  });
});
