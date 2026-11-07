import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { groupSegments } from "@/features/nova-assistant/components/NovaConversation";
import { FinderHintCard, TimerCard } from "@/features/nova-assistant/components/NovaResultCards";
import { NovaToolbar } from "@/features/nova-assistant/components/NovaToolbar";
import { NovaToolSteps } from "@/features/nova-assistant/components/NovaToolCard";
import type { Segment, ToolItem } from "@/features/nova-assistant/conversation";
import type { AgentPrefs } from "@/features/nova-assistant/types";
import { searchSettings } from "./SettingsPage";

const tool = (id: string, state: ToolItem["state"] = "done"): ToolItem => ({ id, name: "start_game", title: `Step ${id}`, risk: "safe", state, detail: null, summary: null, card: null });

describe("finding a setting", () => {
  it("knows settings by their name and by the words people use", () => {
    expect(searchSettings("auto mode")[0]?.section).toBe("assistant-brain");
    expect(searchSettings("stimme").map((s) => s.label)).toContain("Voice");
    expect(searchSettings("klatschen")[0]?.section).toBe("wake");
    expect(searchSettings("  ")).toEqual([]);
    expect(searchSettings("gibt es nicht")).toEqual([]);
  });
});

describe("a reply's steps", () => {
  it("groups actions in a row, and text apart", () => {
    const segments: Segment[] = [{ type: "tool", tool: tool("a") }, { type: "tool", tool: tool("b") }, { type: "text", text: "Fertig" }, { type: "tool", tool: tool("c") }];
    const groups = groupSegments(segments);
    expect(groups.map((g) => g.type)).toEqual(["tools", "text", "tools"]);
    expect(groups[0]?.type === "tools" && groups[0].tools.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("folds three finished steps, never one that needs an answer", () => {
    const { rerender } = render(<NovaToolSteps tools={[tool("a"), tool("b"), tool("c")]} onConfirm={vi.fn()} />);
    expect(screen.getByText("3/3")).toBeTruthy();
    expect(screen.queryByText("Step a")).toBeNull();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("Step a")).toBeTruthy();
    rerender(<NovaToolSteps tools={[tool("a"), tool("b"), tool("c", "confirm")]} onConfirm={vi.fn()} />);
    expect(screen.getByText("Step c")).toBeTruthy();
    expect(screen.getByText("2/3")).toBeTruthy();
  });
});

describe("the bar in NOVA's window", () => {
  const prefs = { autoMode: false, speakReplies: false, keepListening: true } as AgentPrefs;

  it("asks before auto mode goes on, and not before it goes off", () => {
    const onPrefs = vi.fn();
    const { rerender } = render(<NovaToolbar prefs={prefs} german={false} onPrefs={onPrefs} onHistory={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Auto mode" }));
    expect(onPrefs).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Turn on at my own risk" }));
    expect(onPrefs).toHaveBeenCalledWith({ autoMode: true });
    onPrefs.mockClear();
    rerender(<NovaToolbar prefs={{ ...prefs, autoMode: true }} german={false} onPrefs={onPrefs} onHistory={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Auto mode" }));
    expect(onPrefs).toHaveBeenCalledWith({ autoMode: false });
  });
});

describe("result cards", () => {
  it("a timer counts down and ends", () => {
    const { rerender } = render(<TimerCard card={{ kind: "timer", id: 1, label: "Pizza", endsAt: Date.now() + 90_000, seconds: 90 }} />);
    expect(screen.getByText("Pizza")).toBeTruthy();
    expect(screen.getByText(/^1:3\d$/)).toBeTruthy();
    rerender(<TimerCard key="over" card={{ kind: "timer", id: 2, label: "", endsAt: Date.now() - 1, seconds: 90 }} />);
    expect(screen.getByText("Time's up")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel the timer" })).toBeNull();
  });

  it("explains what the whole PC means before adding it", () => {
    render(<FinderHintCard />);
    fireEvent.click(screen.getByRole("button", { name: "Add the whole PC" }));
    expect(screen.getByText(/stay off limits/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Yes, the whole PC" })).toBeTruthy();
  });
});
