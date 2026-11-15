// Closing the island must be one calm motion: no overshoot below the closed size, no
// hover lift pulsing into the collapse, and the fading content keeps what it showed.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { IslandActions, IslandData } from "./data";
import { IslandView } from "./IslandView";
import { morphCurves } from "./look";
import { sceneById } from "./scenes";
import { DEFAULT_ISLAND_PREFS } from "./types";

function actions(): IslandActions {
  return { mediaControl: vi.fn(), lyrics: vi.fn(async () => []), callAction: vi.fn(), talk: vi.fn(), openAssistant: vi.fn(), menu: vi.fn() };
}

const on = actions();
const music = sceneById("music").data(Date.now());
const pill = () => document.querySelector<HTMLElement>(".island")!;
const curve = (axis: "w" | "h") => pill().style.getPropertyValue(`--island-curve-${axis}`);

function View({ data = music, expanded = false, lyrics = false, hovered = false }: { data?: IslandData; expanded?: boolean; lyrics?: boolean; hovered?: boolean }) {
  return <IslandView prefs={DEFAULT_ISLAND_PREFS} data={data} actions={on} expanded={expanded} lyrics={lyrics} hovered={hovered} onExpanded={vi.fn()} onLyrics={vi.fn()} />;
}

describe("the pill's morph curves", () => {
  it("springs only while growing, per axis", () => {
    expect(morphCurves({ width: 206, height: 38 }, { width: 400, height: 186 })).toEqual({ width: "spring", height: "spring" });
    expect(morphCurves({ width: 400, height: 312 }, { width: 268, height: 38 })).toEqual({ width: "settle", height: "settle" });
    expect(morphCurves({ width: 400, height: 312 }, { width: 400, height: 186 })).toEqual({ width: "spring", height: "settle" });
    expect(morphCurves({ width: 268, height: 38 }, { width: 380, height: 30 })).toEqual({ width: "spring", height: "settle" });
  });

  it("opens with the spring and closes without overshoot", () => {
    const { rerender } = render(<View />);
    rerender(<View expanded />);
    expect(curve("w")).toBe("var(--island-spring)");
    expect(curve("h")).toBe("var(--island-spring)");
    rerender(<View expanded lyrics />);
    expect(curve("h")).toBe("var(--island-spring)");
    rerender(<View />);
    expect(pill().style.height).toBe("38px");
    expect(curve("w")).toBe("var(--island-ease)");
    expect(curve("h")).toBe("var(--island-ease)");
    // A render with the same size keeps the curve of the morph that is running.
    rerender(<View hovered />);
    expect(curve("h")).toBe("var(--island-ease)");
  });
});

describe("closing under the pointer", () => {
  it("doesn't lift the pill it just closed until the pointer has left once", () => {
    const { rerender } = render(<View expanded hovered />);
    expect(pill().dataset.hovered).toBe("true");
    rerender(<View hovered />);
    expect(pill().dataset.hovered).toBeUndefined();
    rerender(<View hovered />);
    expect(pill().dataset.hovered).toBeUndefined();
    rerender(<View />);
    rerender(<View hovered />);
    expect(pill().dataset.hovered).toBe("true");
  });

  it("lifts a closed pill as before when the pointer comes to it", () => {
    const { rerender } = render(<View />);
    rerender(<View hovered />);
    expect(pill().dataset.hovered).toBe("true");
  });
});

describe("the open view fading out", () => {
  it("keeps its lyrics while the closed pill takes over", () => {
    const { rerender } = render(<View expanded lyrics />);
    expect(document.querySelector(".island-lyrics")).not.toBeNull();
    // IslandApp drops the lyrics one render after closing; the fading layer keeps them.
    rerender(<View lyrics />);
    rerender(<View />);
    const leaving = document.querySelector<HTMLElement>(".island-layer[data-leaving]");
    expect(leaving).not.toBeNull();
    expect(leaving!.querySelector(".island-lyrics")).not.toBeNull();
  });
});
