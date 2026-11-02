import type { CSSProperties } from "react";
import type { AssistantState } from "../types";
import { Sparkle } from "./Sparkle";

export const STATUS_LABELS: Record<AssistantState, string> = {
  idle: "Ready",
  activating: "Opening…",
  listening: "Listening…",
  processing: "Understanding…",
  thinking: "Thinking…",
  searching: "Searching your files…",
  analyzingScreen: "Looking at your screen…",
  executing: "Working…",
  speaking: "Speaking…",
  completed: "Done",
  error: "Something went wrong",
};

export function statusLabel(state: AssistantState, detail: string | null): string {
  if (detail && (state === "executing" || state === "searching")) return detail;
  return STATUS_LABELS[state];
}

/** The NOVA orb with a ring that shows what NOVA AI is doing. */
export function NovaStatusOrb({ state, level = 0, size = 32 }: { state: AssistantState; level?: number; size?: number }) {
  return (
    <span className="nova-orb-status" data-state={state} style={{ width: size, height: size, "--level": level } as CSSProperties} aria-hidden>
      <span className="nova-orb">
        <Sparkle />
      </span>
    </span>
  );
}

/** Animated bars for listening (microphone level) and speaking. */
export function NovaVoiceVisualizer({ level, active }: { level: number; active: boolean }) {
  const bars = [0.55, 0.85, 1, 0.75, 0.5];
  return (
    <span className="flex h-5 items-center gap-[3px]" aria-hidden>
      {bars.map((weight, i) => (
        <span
          key={i}
          className="w-[3px] rounded-full bg-accent-text transition-[height] duration-100 ease-out"
          style={{ height: `${active ? Math.max(3, Math.min(20, 3 + level * 22 * weight)) : 3}px` }}
        />
      ))}
    </span>
  );
}
