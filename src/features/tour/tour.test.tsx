import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { ASSISTANT_EVENTS } from "@/features/nova-assistant/types";
import { useVoice } from "@/features/nova-assistant/voice";
import { useConsentPrompt } from "@/features/telemetry/api";
import { showWhatsNew, WhatsNewDialog } from "@/features/updates/WhatsNew";
import { callNative } from "@/lib/native";
import { defaultSettings, useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { renderWithQuery } from "@/test/render";
import { useTour, useTourPending } from "./store";
import { Tour } from "./Tour";
import { TourCard } from "./TourCard";
import { TOUR_STEPS } from "./steps";

vi.mock("@/lib/native", async (original) => ({ ...(await original<typeof import("@/lib/native")>()), isDesktop: () => true, callNative: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const native = vi.mocked(callNative);

const WAKE = { prefs: { phrase: false, phraseSensitivity: "normal", clap: false, clapSensitivity: "normal", afterWake: "listen", chime: true, inGames: true, muted: false }, phrase: { state: "off" }, clap: { state: "off" }, dictation: true, testing: false };

let needsDecision = false;

function backend() {
  native.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "telemetry_status":
        return { needsDecision, accepted: false, decidedAt: null, installId: null, displayName: null, lastSent: null, lastError: null, waiting: 0, privacyUrl: "", host: "" };
      case "tts_status":
        return { state: "missing" };
      case "tts_install":
        return { state: "downloading", percent: 0 };
      case "wake_status":
      case "wake_test":
        return WAKE;
      case "wake_configure":
        return { ...WAKE, prefs: args?.prefs };
      case "ai_key_status":
        return { openai: false, anthropic: false, gemini: false };
      case "agent_status":
      case "assistant_agent_status":
        return { prefs: { voice: "", speechRate: 1, speechVolume: 1, language: "auto" }, keys: {} };
      default:
        return null;
    }
  });
}

const calls = (name: string) => native.mock.calls.filter(([command]) => command === name);

function goToStep(id: string) {
  act(() => useTour.getState().goTo(TOUR_STEPS.findIndex((step) => step.id === id)));
}

function show() {
  act(() => useTour.getState().start());
  renderWithQuery(<TourCard />);
}

describe("the tour", () => {
  beforeEach(() => {
    native.mockReset();
    needsDecision = false;
    backend();
    useSettings.setState({ ...defaultSettings() });
    useUi.setState({ route: "home", paletteOpen: false });
    useConsentPrompt.setState({ open: false });
    useTour.setState({ open: false, step: 0, missions: [], explored: [] });
    useVoice.setState({ novaVoice: null, mode: "idle" });
  });
  afterEach(cleanup);

  it("starts by itself the first time", async () => {
    renderWithQuery(<Tour />);
    await waitFor(() => expect(useTour.getState().open).toBe(true));
  });

  it("doesn't start again once seen", async () => {
    useSettings.setState({ tourSeen: true });
    renderWithQuery(<Tour />);
    await waitFor(() => expect(calls("telemetry_status").length).toBeGreaterThan(0));
    await act(async () => {});
    expect(useTour.getState().open).toBe(false);
  });

  it("waits for the consent popup, also when it is closed without an answer", async () => {
    needsDecision = true;
    renderWithQuery(<Tour />);
    await waitFor(() => expect(calls("telemetry_status").length).toBeGreaterThan(0));
    await act(async () => {});
    expect(useTour.getState().open).toBe(false);
    act(() => useConsentPrompt.setState({ open: true }));
    expect(useTour.getState().open).toBe(false);
    act(() => useConsentPrompt.setState({ open: false }));
    await waitFor(() => expect(useTour.getState().open).toBe(true));
  });

  it("keeps What's New and an update waiting until it is over", () => {
    const Probe = () => <p>{useTourPending() ? "waiting" : "free"}</p>;
    renderWithQuery(<Probe />);
    expect(screen.getByText("waiting")).toBeTruthy();
    act(() => {
      useSettings.setState({ tourSeen: true });
    });
    expect(screen.getByText("free")).toBeTruthy();
    act(() => useTour.getState().start());
    expect(screen.getByText("waiting")).toBeTruthy();
    act(() => useTour.getState().close());
    expect(screen.getByText("free")).toBeTruthy();
  });

  it("shows What's New once it is over", async () => {
    renderWithQuery(<WhatsNewDialog />);
    act(() => showWhatsNew());
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => {
      useSettings.setState({ tourSeen: true });
    });
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("skipping ends it for good and goes home", async () => {
    useUi.setState({ route: "system" });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Überspringen" }));
    expect(useTour.getState().open).toBe(false);
    expect(useSettings.getState().tourSeen).toBe(true);
    expect(useUi.getState().route).toBe("home");
  });

  it("isn't marked as seen before it ended", async () => {
    show();
    await screen.findByRole("dialog");
    expect(useSettings.getState().tourSeen).toBe(false);
  });

  it("saves the name as you type it and greets you with it", async () => {
    show();
    fireEvent.change(await screen.findByLabelText(/Wie soll ich dich nennen/), { target: { value: "Luca" } });
    expect(useSettings.getState().displayName).toBe("Luca");
    expect(screen.getByRole("heading", { name: /Hi Luca/ })).toBeTruthy();
  });

  it("wears the color you click", async () => {
    show();
    goToStep("look");
    fireEvent.click(await screen.findByRole("radio", { name: /Emerald/ }));
    expect(useSettings.getState().accent).toEqual({ kind: "preset", id: "emerald" });
    expect(useTour.getState().missions).toContain("look");
  });

  it("downloads the voice only on a click, and shows how far it is", async () => {
    show();
    goToStep("voice");
    const download = await screen.findByRole("button", { name: "Thorsten herunterladen" });
    expect(calls("tts_install")).toEqual([]);
    expect(screen.getByText(/etwa 85 MB/)).toBeTruthy();
    fireEvent.click(download);
    await waitFor(() => expect(calls("tts_install").length).toBe(1));
    act(() => useVoice.setState({ novaVoice: { state: "downloading", percent: 42 } }));
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");
    act(() => useVoice.setState({ novaVoice: { state: "failed", message: "Kein Netz" } }));
    expect(screen.getByText("Kein Netz")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Nochmal versuchen" })).toBeTruthy();
  });

  it("leaves the microphone alone until you turn it on, and ends a test when you leave", async () => {
    show();
    goToStep("call");
    const phrase = await screen.findByRole("switch", { name: "Hey NOVA" });
    await waitFor(() => expect(phrase.hasAttribute("disabled")).toBe(false));
    expect(calls("wake_configure")).toEqual([]);
    expect(calls("wake_test")).toEqual([]);
    fireEvent.click(phrase);
    await waitFor(() => expect(calls("wake_configure").length).toBe(1));
    expect(calls("wake_configure")[0]![1]).toMatchObject({ prefs: { phrase: true, clap: false } });
    goToStep("look");
    await waitFor(() => expect(calls("wake_test").at(-1)?.[1]).toEqual({ on: false }));
  });

  it("checks off the shortcuts you press and puts the sidebar back", async () => {
    show();
    goToStep("keys");
    await screen.findByRole("heading", { name: /Drei Kürzel/ });
    act(() => useUi.getState().setPaletteOpen(true));
    act(() => useUi.getState().setPaletteOpen(false));
    act(() => {
      useSettings.getState().toggleSidebar();
    });
    expect(useTour.getState().missions).not.toContain("keys");
    act(() => useUi.getState().navigate("settings"));
    await waitFor(() => expect(useTour.getState().missions).toContain("keys"));
    goToStep("done");
    await screen.findByRole("heading", { name: /Fertig/ });
    expect(useSettings.getState().sidebarCollapsed).toBe(false);
  });

  it("makes the next sidebar button glow during the walk", async () => {
    const nav = document.createElement("button");
    nav.dataset.nav = "system";
    document.body.append(nav);
    show();
    goToStep("explore");
    await screen.findByRole("heading", { name: /Schau dich um/ });
    await waitFor(() => expect(nav.hasAttribute("data-tour-glow")).toBe(true));
    act(() => useUi.getState().navigate("system"));
    await waitFor(() => expect(nav.hasAttribute("data-tour-glow")).toBe(false));
    nav.remove();
  });

  it("saves a pasted AI key and forgets it in the form", async () => {
    show();
    goToStep("ai");
    fireEvent.click(await screen.findByRole("radio", { name: /OpenAI/ }));
    const input = await screen.findByLabelText("Schlüssel für OpenAI");
    expect(input.getAttribute("type")).toBe("password");
    fireEvent.change(input, { target: { value: "  test-key  " } });
    fireEvent.click(screen.getByRole("button", { name: "Verbinden" }));
    await waitFor(() => expect(calls("ai_key_set")[0]?.[1]).toEqual({ provider: "openai", key: "test-key" }));
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
  });

  it("celebrates when it hears you, and only then", async () => {
    const heard: { current?: (event: { payload: unknown }) => void } = {};
    vi.mocked(listen).mockImplementation(async (name, handler) => {
      if (name === ASSISTANT_EVENTS.wakeHeard) heard.current = handler as typeof heard.current;
      return () => {};
    });
    native.mockImplementation(async (command: string) => (command === "wake_status" || command === "wake_test" ? { ...WAKE, prefs: { ...WAKE.prefs, phrase: true }, phrase: { state: "listening" }, testing: true } : null));
    show();
    goToStep("call");
    await screen.findByText("Na los, ruf mich!");
    await waitFor(() => expect(heard.current).toBeDefined());
    act(() => heard.current!({ payload: { kind: "phrase", text: "hallo", confidence: "low", accepted: false } }));
    expect(useTour.getState().missions).not.toContain("wake");
    expect(screen.getByText(/Verstanden: „hallo“/)).toBeTruthy();
    act(() => heard.current!({ payload: { kind: "phrase", text: "hey nova", confidence: "high", accepted: true } }));
    expect(useTour.getState().missions).toContain("wake");
    expect(screen.getByText(/Gehört!/)).toBeTruthy();
  });

  it("offers what's still missing at the end, leading to Settings", async () => {
    show();
    goToStep("done");
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Hey NOVA" }));
    expect(useTour.getState().open).toBe(false);
    expect(useUi.getState().route).toBe("settings");
    expect(useUi.getState().settingsSection).toBe("wake");
  });
});
