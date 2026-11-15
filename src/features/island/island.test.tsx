import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { CSSProperties } from "react";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_DATA, type IslandActions, type IslandData, layoutOf } from "./data";
import defaults from "./default-prefs.json";
import { IslandView } from "./IslandView";
import { islandTone, islandVariables, motionTiming, paneTone } from "./look";
import { applyPreset, cleanLook, CURATED_PRESETS, decodePreset, encodePreset, matchingPreset, presetFrom } from "./presets";
import { sceneById, SCENES } from "./scenes";
import { commit, redo, startHistory, undo } from "./studio/history";
import { IslandStudio } from "./studio/IslandStudio";
import { materialOf } from "./studio/LookPanels";
import { clampCenter, magnet, restCenter, settle, SIDE_GAP, SNAP } from "./studio/position";
import { DEFAULT_ISLAND_PREFS, DEFAULT_LOOK, type IslandPrefs, LIMITS } from "./types";

const variable = (style: CSSProperties, name: string) => (style as Record<string, string>)[name];

describe("the island's defaults", () => {
  it("are the ones Rust has (island/prefs.rs tests against the same file)", () => {
    expect(DEFAULT_ISLAND_PREFS).toEqual(defaults);
  });
});

describe("looks as CSS variables", () => {
  it("draws form and motion from the preferences", () => {
    const style = islandVariables({ ...DEFAULT_ISLAND_PREFS, look: { ...DEFAULT_LOOK, scale: 114, radius: 12 } });
    expect(variable(style, "--island-scale")).toBe("1.14");
    expect(variable(style, "--island-radius")).toBe("12px");
    expect(variable(style, "--island-radius-open")).toBe("20px");
    expect(variable(style, "--island-morph")).toBe("520ms");
    // The ready-made designs keep their own material and NOVA's accent.
    expect(variable(style, "--island-bg")).toBeUndefined();
    expect(variable(style, "--nova-accent")).toBeUndefined();
  });

  it("makes every duration shorter with a higher tempo, and minimal the quickest", () => {
    const normal = motionTiming({ style: "springy", speed: 100 });
    const fast = motionTiming({ style: "springy", speed: 200 });
    expect(fast).toMatchObject({ morph: normal.morph / 2, enter: normal.enter / 2, leave: normal.leave / 2 });
    expect(motionTiming({ style: "minimal", speed: 100 }).morph).toBeLessThan(motionTiming({ style: "soft", speed: 100 }).morph);
    // A tempo from anywhere stays inside the limits.
    expect(motionTiming({ style: "soft", speed: 9000 }).morph).toBe(motionTiming({ style: "soft", speed: LIMITS.speed.max }).morph);
  });

  it("builds a material of one's own, with ink that can be read on it", () => {
    const custom: IslandPrefs = { ...DEFAULT_ISLAND_PREFS, theme: "custom", look: { ...DEFAULT_LOOK, background: "#f4f4f7", opacity: 50, border: "glow", shadow: 0, accent: "#22d3ee" } };
    const style = islandVariables(custom);
    expect(variable(style, "--island-bg")).toBe("rgb(244 244 247 / 0.500)");
    expect(variable(style, "--island-rim")).toContain("--nova-accent");
    expect(variable(style, "--island-shadow")).toContain("rgb(0 0 0 / 0.000)");
    expect(variable(style, "--nova-accent")).toBe("#22d3ee");
    expect(islandTone(custom)).toBe("light");
    expect(paneTone("#12283a")).toBe("dark");
    expect(islandTone({ theme: "white", look: DEFAULT_LOOK })).toBe("light");
    // Not a color: never reaches CSS.
    expect(variable(islandVariables({ ...custom, look: { ...custom.look, background: "red;}" } }), "--island-bg")).toBe("rgb(0 0 0 / 0.500)");
  });

  it("starts a material of one's own from the design on screen", () => {
    expect(materialOf({ theme: "glass", look: DEFAULT_LOOK })).toMatchObject({ background: "#14141e", opacity: 58 });
    expect(materialOf({ theme: "custom", look: { ...DEFAULT_LOOK, background: "#101010", opacity: 80 } })).toMatchObject({ background: "#101010", opacity: 80 });
  });
});

describe("presets", () => {
  it("keeps every curated preset inside the limits", () => {
    for (const preset of CURATED_PRESETS) expect(cleanLook(preset.look), preset.name).toEqual(preset.look);
    expect(new Set(CURATED_PRESETS.map((p) => p.id)).size).toBe(CURATED_PRESETS.length);
  });

  it("applies a look and leaves everything else alone", () => {
    const mine: IslandPrefs = { ...DEFAULT_ISLAND_PREFS, anchor: "left", offset: 40, hidePreviews: true };
    const neon = CURATED_PRESETS.find((p) => p.id === "neon")!;
    const next = applyPreset(mine, neon);
    expect(next).toMatchObject({ theme: "custom", look: neon.look, motion: neon.motion, slots: neon.slots, anchor: "left", offset: 40, hidePreviews: true });
    expect(matchingPreset(next, CURATED_PRESETS)?.id).toBe("neon");
    expect(matchingPreset({ ...next, look: { ...next.look, radius: 9 } }, CURATED_PRESETS)).toBeNull();
    expect(matchingPreset(DEFAULT_ISLAND_PREFS, CURATED_PRESETS)?.id).toBe("classic");
  });

  it("travels as a code and comes back the same", () => {
    const preset = presetFrom(applyPreset(DEFAULT_ISLAND_PREFS, CURATED_PRESETS[3]!), "  Mein Neon – grün 🌿 ", "x");
    const code = encodePreset(preset);
    expect(code).toMatch(/^NI1\.[A-Za-z0-9_-]+$/);
    const back = decodePreset(` ${code}\n`);
    expect(back).toEqual({ ok: true, preset: { name: "Mein Neon – grün 🌿", theme: preset.theme, look: preset.look, motion: preset.motion, slots: preset.slots } });
  });

  it("refuses what isn't a code and limits what is", () => {
    const reason = (code: string) => {
      const result = decodePreset(code);
      return result.ok ? null : result.reason;
    };
    expect(reason("")).toMatch(/Füg einen Code ein/);
    expect(reason("hallo")).toMatch(/kein Vorlagen-Code/);
    expect(reason("NI2.abc")).toMatch(/neueren NOVA-Version/);
    expect(reason("NI1.%%%")).toMatch(/beschädigt/);
    expect(reason(`NI1.${btoa(JSON.stringify({ v: 1, t: "hologram", l: {} }))}`)).toMatch(/beschädigt/);
    expect(reason(`NI1.${btoa(JSON.stringify([1, 2]))}`)).toMatch(/beschädigt/);
    expect(reason(`NI1.${"a".repeat(5000)}`)).toMatch(/zu lang/);
    // Right shape, wild values: limited, never passed on as they are.
    const wild = decodePreset(`NI1.${btoa(JSON.stringify({ v: 1, n: "x".repeat(200), t: "custom", l: { scale: 9000, radius: -4, background: "url(evil)", accent: "#12", border: "neon" }, m: { style: "warp", speed: 1 }, s: { music: { left: "bomb" } } }))}`);
    expect(wild.ok).toBe(true);
    if (!wild.ok) return;
    expect(wild.preset.name).toHaveLength(LIMITS.presetName);
    expect(wild.preset.look).toMatchObject({ scale: LIMITS.scale.max, radius: LIMITS.radius.min, background: DEFAULT_LOOK.background, accent: null, border: "fine" });
    expect(wild.preset.motion).toEqual({ style: "springy", speed: LIMITS.speed.min });
    expect(wild.preset.slots.music).toEqual({ left: "cover", right: "visualizer" });
  });
});

describe("undo and redo", () => {
  it("steps back and forward, and forgets the future after a new change", () => {
    let history = startHistory(1);
    history = commit(history, 2, null, 0);
    history = commit(history, 3, null, 10);
    expect(undo(history).present).toBe(2);
    expect(undo(undo(history)).present).toBe(1);
    expect(undo(undo(undo(history))).present).toBe(1);
    expect(redo(undo(history)).present).toBe(3);
    expect(redo(history)).toBe(history);
    expect(redo(commit(undo(history), 9, null, 20)).present).toBe(9);
  });

  it("counts a slider dragged in one go as one step", () => {
    let history = startHistory(0);
    for (let value = 1; value <= 20; value++) history = commit(history, value, "look.radius", value * 30);
    expect(history.past).toEqual([0]);
    // Another setting, or the same one after a pause, is a step of its own.
    history = commit(history, 21, "look.scale", 620);
    history = commit(history, 22, "look.scale", 5000);
    expect(history.past).toEqual([0, 20, 21]);
    expect(commit(history, history.present, "x", 6000)).toBe(history);
  });
});

describe("placing the island on the stage", () => {
  const stage = 900;
  const pill = 200;

  it("knows where each anchor rests", () => {
    expect(restCenter("left", stage, pill)).toBe(SIDE_GAP + 100);
    expect(restCenter("center", stage, pill)).toBe(450);
    expect(restCenter("right", stage, pill)).toBe(stage - SIDE_GAP - 100);
  });

  it("snaps close to an anchor and keeps a free offset elsewhere", () => {
    expect(settle(450 + SNAP, stage, pill)).toEqual({ anchor: "center", offset: 0 });
    expect(settle(450 + SNAP + 20, stage, pill)).toEqual({ anchor: "center", offset: SNAP + 20 });
    expect(settle(SIDE_GAP + 100 + 80, stage, pill)).toEqual({ anchor: "left", offset: 80 });
    expect(settle(stage - 170, stage, pill)).toEqual({ anchor: "right", offset: -46 });
    expect(settle(-5000, 20_000, pill).offset).toBe(LIMITS.offset.min);
  });

  it("pulls a dragged island onto an anchor and keeps it on the stage", () => {
    expect(magnet(455, stage, pill)).toEqual({ center: 450, anchor: "center" });
    expect(magnet(600, stage, pill)).toEqual({ center: 600, anchor: null });
    expect(clampCenter(-40, stage, pill)).toBe(100);
    expect(clampCenter(5000, stage, pill)).toBe(800);
  });
});

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

function actions(): IslandActions {
  return { mediaControl: vi.fn(), lyrics: vi.fn(async () => []), callAction: vi.fn(), talk: vi.fn(), openAssistant: vi.fn(), menu: vi.fn() };
}

function View({ prefs = DEFAULT_ISLAND_PREFS, data, expanded = false, on = actions(), onExpanded = vi.fn() }: { prefs?: IslandPrefs; data: IslandData; expanded?: boolean; on?: IslandActions; onExpanded?: (expanded: boolean) => void }) {
  return <IslandView prefs={prefs} data={data} actions={on} expanded={expanded} lyrics={false} hovered={false} onExpanded={onExpanded} onLyrics={vi.fn()} />;
}

const music = sceneById("music").data(Date.now());
const pill = () => document.querySelector<HTMLElement>(".island")!;
const slots = () => [...document.querySelectorAll<HTMLElement>(".island-slot")].map((slot) => `${slot.dataset.slot}:${slot.dataset.item}`);

describe("IslandView", () => {
  it("has a scene for every state, and each one arranges", () => {
    for (const scene of SCENES) {
      const everything = { ...DEFAULT_ISLAND_PREFS, modules: { music: true, notifications: true, calls: true, system: true, ai: true } };
      const { arrangement } = layoutOf(everything, scene.data(0));
      expect(arrangement.primary === null, scene.id).toBe(scene.id === "idle" || scene.id === "system" ? arrangement.primary === null : false);
    }
  });

  it("draws the closed pill at the size its content needs, with the chosen side slots", () => {
    const { rerender } = render(<View data={music} />);
    expect(pill().style.width).toBe("268px");
    expect(pill().style.height).toBe("38px");
    expect(pill().textContent).toContain("Nachtflug");
    expect(slots()).toEqual(["left:cover", "right:visualizer"]);
    const mine: IslandPrefs = { ...DEFAULT_ISLAND_PREFS, look: { ...DEFAULT_LOOK, closedHeight: 44 }, slots: { ...DEFAULT_ISLAND_PREFS.slots, music: { left: "none", right: "clock" } } };
    rerender(<View data={music} prefs={mine} />);
    expect(slots()).toEqual(["right:clock"]);
    expect(pill().style.width).toBe(`${206 + 36 + 9}px`);
    expect(pill().style.height).toBe("44px");
  });

  it("carries theme, tone and the look's variables on its own elements", () => {
    render(<View data={music} prefs={{ ...DEFAULT_ISLAND_PREFS, theme: "custom", anchor: "left", look: { ...DEFAULT_LOOK, background: "#ffffff", radius: 9 }, motion: { style: "minimal", speed: 100 } }} />);
    const stage = pill().parentElement!;
    expect(pill().dataset).toMatchObject({ theme: "custom", tone: "light", open: "false" });
    expect(stage.dataset).toMatchObject({ anchor: "left", motionStyle: "minimal" });
    expect(stage.style.getPropertyValue("--island-radius")).toBe("9px");
    expect(stage.style.getPropertyValue("--island-bg")).toBe("rgb(255 255 255 / 1.000)");
  });

  it("opens on a click, and with Enter or Space on the pill only", () => {
    const onExpanded = vi.fn();
    const on = actions();
    const { rerender } = render(<View data={music} onExpanded={onExpanded} on={on} />);
    fireEvent.click(pill());
    expect(onExpanded).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(pill(), { key: "Enter" });
    expect(onExpanded).toHaveBeenCalledTimes(2);
    rerender(<View data={music} expanded onExpanded={onExpanded} on={on} />);
    expect(pill().getAttribute("aria-expanded")).toBe("true");
    onExpanded.mockClear();
    // A control inside acts for itself: it neither closes the island by click nor by key.
    const pause = screen.getByRole("button", { name: "Pause" });
    fireEvent.click(pause);
    fireEvent.keyDown(pause, { key: " " });
    expect(on.mediaControl).toHaveBeenCalledWith("toggle");
    expect(onExpanded).not.toHaveBeenCalled();
    fireEvent.keyDown(pause, { key: "Escape" });
    expect(onExpanded).toHaveBeenLastCalledWith(false);
  });

  it("opens NOVA AI from an island with nothing to show, and NOVA's menu on a right-click", () => {
    const on = actions();
    const onExpanded = vi.fn();
    render(<View data={EMPTY_DATA} on={on} onExpanded={onExpanded} />);
    expect(pill().style.width).toBe("112px");
    fireEvent.click(pill());
    expect(on.openAssistant).toHaveBeenCalledTimes(1);
    expect(onExpanded).not.toHaveBeenCalled();
    fireEvent.contextMenu(pill());
    expect(on.menu).toHaveBeenCalledTimes(1);
  });

  it("shows a ringing call opened by itself, with only what the phone can do", () => {
    const on = actions();
    const ringing = sceneById("ringing").data(0);
    const { rerender } = render(<View data={ringing} on={on} />);
    expect(pill().dataset.ringing).toBe("true");
    expect(pill().style.height).toBe("88px");
    fireEvent.click(screen.getByRole("button", { name: "Annehmen" }));
    expect(on.callAction).toHaveBeenLastCalledWith("demo", "accept");
    fireEvent.click(screen.getByRole("button", { name: "Ablehnen" }));
    expect(on.callAction).toHaveBeenLastCalledWith("demo", "decline");
    rerender(<View data={{ ...ringing, call: { ...ringing.call!, canAnswer: false, canDecline: false } }} on={on} />);
    expect(screen.queryByRole("button", { name: "Annehmen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ablehnen" })).toBeNull();
    expect(screen.getByText("Am Handy annehmen")).toBeTruthy();
  });

  it("carries the NOVA dot, and then leaves NOVA AI's status slot empty", () => {
    const on = actions();
    const thinking = sceneById("aiThinking").data(0);
    const inside: IslandPrefs = { ...DEFAULT_ISLAND_PREFS, mode: "islandOnly", dotInIsland: true };
    const { rerender } = render(<View data={thinking} on={on} />);
    expect(slots()).toEqual(["left:aiStatus"]);
    expect(screen.queryByRole("button", { name: "Mit NOVA sprechen" })).toBeNull();
    rerender(<View data={thinking} prefs={inside} on={on} />);
    expect(slots()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Mit NOVA sprechen" }));
    expect(on.openAssistant).toHaveBeenCalledTimes(1);
    expect(pill().textContent).toContain("Denkt nach");
  });

  it("says nothing of a notification whose preview is hidden", () => {
    const shown = sceneById("notification").data(0);
    const { rerender } = render(<View data={shown} />);
    expect(pill().textContent).toContain("Bin in zehn Minuten da");
    rerender(<View data={{ ...shown, notice: { ...shown.notice!, title: "", text: "" } }} />);
    expect(pill().textContent).toContain("WhatsApp");
    expect(pill().textContent).toContain("Neue Benachrichtigung");
  });
});

// ---------------------------------------------------------------------------
// The Studio (browser preview: no Rust, a local working copy)
// ---------------------------------------------------------------------------

function renderStudio() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <IslandStudio />
    </QueryClientProvider>,
  );
}

const stagePill = () => document.querySelector<HTMLElement>("[aria-label^='Vorschau'] .island")!;

describe("Island Studio", () => {
  it("shows the real island on its stage and plays every scene", () => {
    renderStudio();
    expect(stagePill().textContent).toContain("Nachtflug");
    expect(stagePill().getAttribute("aria-label")).toBe("Nova Island öffnen");
    const scenes = within(screen.getByRole("radiogroup", { name: "Szene" }));
    for (const scene of SCENES) {
      fireEvent.click(scenes.getByRole("radio", { name: scene.label }));
      expect(scenes.getByRole("radio", { name: scene.label }).getAttribute("aria-checked"), scene.id).toBe("true");
      expect(stagePill().dataset.empty === "true", scene.id).toBe(scene.id === "idle");
    }
    // The system module is off by default; its scene shows all the same.
    fireEvent.click(scenes.getByRole("radio", { name: "System" }));
    expect(stagePill().textContent).toContain("CPU");
    fireEvent.click(scenes.getByRole("radio", { name: "Eingehender Anruf" }));
    expect(stagePill().dataset.ringing).toBe("true");
    // The stage answers its own call.
    fireEvent.click(within(stagePill()).getByRole("button", { name: "Annehmen" }));
    expect(scenes.getByRole("radio", { name: "Laufender Anruf" }).getAttribute("aria-checked")).toBe("true");
  });

  it("applies a preset at once and takes it back with undo, button or Ctrl+Z", () => {
    renderStudio();
    const undoButton = screen.getByRole("button", { name: "Rückgängig (Strg+Z)" });
    expect(undoButton).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /Neon/ }));
    expect(stagePill().dataset.theme).toBe("custom");
    expect(stagePill().parentElement!.style.getPropertyValue("--nova-accent")).toBe("#ff3df0");
    fireEvent.click(screen.getByRole("radio", { name: /Paper/ }));
    expect(stagePill().dataset.theme).toBe("white");
    fireEvent.click(undoButton);
    expect(stagePill().dataset.theme).toBe("custom");
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(stagePill().dataset.theme).toBe("black");
    expect(undoButton).toBeDisabled();
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    expect(stagePill().dataset.theme).toBe("custom");
  });

  it("turns a slider into a look right away, and touching the material into a design of one's own", () => {
    renderStudio();
    fireEvent.change(screen.getByRole("slider", { name: "Eckenradius" }), { target: { value: "10" } });
    expect(stagePill().parentElement!.style.getPropertyValue("--island-radius")).toBe("10px");
    fireEvent.change(screen.getByRole("slider", { name: "Größe" }), { target: { value: "120" } });
    expect(stagePill().parentElement!.style.getPropertyValue("--island-scale")).toBe("1.2");
    fireEvent.click(screen.getByRole("radio", { name: "Glas" }));
    expect(stagePill().dataset.theme).toBe("glass");
    fireEvent.change(screen.getByRole("slider", { name: "Deckkraft" }), { target: { value: "70" } });
    expect(stagePill().dataset.theme).toBe("custom");
    // It starts from the glass on screen, not from a black pane.
    expect(stagePill().parentElement!.style.getPropertyValue("--island-bg")).toBe("rgb(20 20 30 / 0.700)");
  });

  it("fills a side slot from the chips and follows the state being set", () => {
    renderStudio();
    const states = screen.getByRole("radiogroup", { name: "Zustand, dessen Slots du belegst" });
    fireEvent.click(screen.getByRole("button", { name: "Uhrzeit nach Links" }));
    expect(slots()).toEqual(["left:clock", "right:visualizer"]);
    fireEvent.click(within(states).getByRole("radio", { name: "Anruf" }));
    expect(stagePill().textContent).toContain("Mama");
    // What makes no sense in a state isn't offered there.
    expect(screen.queryByRole("button", { name: "Fortschrittsring nach Links" })).toBeNull();
    expect(screen.getByRole("button", { name: "Restzeit nach Links" })).toBeTruthy();
    // Choosing a scene on the stage brings the editor along.
    fireEvent.click(screen.getByRole("radio", { name: "KI denkt" }));
    expect(within(states).getByRole("radio", { name: "KI" }).getAttribute("aria-checked")).toBe("true");
  });

  it("switches a module off into the list below and back on from there", () => {
    renderStudio();
    fireEvent.click(screen.getByRole("switch", { name: "Musik anzeigen" }));
    const off = screen.getByRole("list", { name: "Ausgeschaltete Module" });
    expect(within(off).getByRole("button", { name: "Musik einschalten" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Musik verschieben" })).toBeNull();
    fireEvent.click(within(off).getByRole("button", { name: "Musik einschalten" }));
    expect(screen.getByRole("button", { name: "Musik verschieben" })).toBeTruthy();
    // The keyboard reorders: NOVA AI in front of calls.
    const handle = screen.getByRole("button", { name: "NOVA AI verschieben" });
    fireEvent.keyDown(handle, { key: " " });
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    const order = screen.getAllByRole("button", { name: /verschieben$/ }).map((button) => button.getAttribute("aria-label"));
    expect(order.slice(0, 2)).toEqual(["NOVA AI verschieben", "Anrufe verschieben"]);
  });

  it("moves the dot into the island and out again without a mouse", () => {
    renderStudio();
    fireEvent.click(screen.getByRole("button", { name: "NOVA-Punkt in die Island legen" }));
    expect(within(stagePill()).getByRole("button", { name: "Mit NOVA sprechen" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "In der Island" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Neben der Island" }));
    expect(within(stagePill()).queryByRole("button", { name: "Mit NOVA sprechen" })).toBeNull();
  });

  it("saves the current look as a preset, imports one by code and says why a bad code fails", () => {
    renderStudio();
    fireEvent.click(screen.getByRole("radio", { name: /Aurora/ }));
    fireEvent.change(screen.getByLabelText("Name der neuen Vorlage"), { target: { value: "Abendlicht" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    const own = screen.getByRole("list", { name: "Eigene Vorlagen" });
    expect(within(own).getByRole("button", { name: "Abendlicht anwenden" }).getAttribute("aria-pressed")).toBe("true");

    const code = screen.getByLabelText("Vorlage importieren");
    fireEvent.change(code, { target: { value: "kein code" } });
    fireEvent.click(screen.getByRole("button", { name: "Importieren" }));
    expect(screen.getByRole("alert").textContent).toMatch(/kein Vorlagen-Code/);
    expect(within(own).getAllByRole("listitem")).toHaveLength(1);

    const neon = CURATED_PRESETS.find((p) => p.id === "neon")!;
    fireEvent.change(code, { target: { value: encodePreset({ ...neon, name: "Von Lena" }) } });
    fireEvent.click(screen.getByRole("button", { name: "Importieren" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(own).getByRole("button", { name: "Von Lena anwenden" }).getAttribute("aria-pressed")).toBe("true");
    expect(stagePill().parentElement!.style.getPropertyValue("--nova-accent")).toBe("#ff3df0");

    fireEvent.click(within(own).getByRole("button", { name: "Abendlicht löschen" }));
    expect(within(own).getAllByRole("listitem")).toHaveLength(1);
  });

  it("resets to the defaults on the second click and keeps the user's presets", () => {
    renderStudio();
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Kuratierte Vorlagen" })).getByRole("radio", { name: /Minimal/ }));
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    fireEvent.click(screen.getByRole("button", { name: "Auf Standard zurücksetzen" }));
    expect(stagePill().dataset.theme).toBe("custom");
    fireEvent.click(screen.getByRole("button", { name: "Wirklich zurücksetzen" }));
    expect(stagePill().dataset.theme).toBe("black");
    expect(within(screen.getByRole("list", { name: "Eigene Vorlagen" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("plays the scenes by itself until one is chosen", () => {
    vi.useFakeTimers();
    try {
      renderStudio();
      fireEvent.click(screen.getByRole("button", { name: /Auto-Demo/ }));
      act(() => {
        vi.advanceTimersByTime(2900);
      });
      expect(screen.getByRole("radio", { name: "Musik + Lyrics" }).getAttribute("aria-checked")).toBe("true");
      fireEvent.click(screen.getByRole("radio", { name: "Leerlauf" }));
      act(() => {
        vi.advanceTimersByTime(6000);
      });
      expect(screen.getByRole("radio", { name: "Leerlauf" }).getAttribute("aria-checked")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });
});
