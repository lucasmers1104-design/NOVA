import { callNative } from "@/lib/native";

/**
 * Timings of one spoken turn (wake → listening → reply → last audio), sent to
 * NOVA's local data folder as `voice-turns.jsonl` so slow turns can be
 * explained. Holds milliseconds, counts and engine names only — never what
 * was said.
 */
interface Turn {
  kind: string;
  started: number;
  marks: Record<string, number>;
  counts: Record<string, number>;
  notes: Record<string, string>;
}

let current: Turn | null = null;
let finishTimer: ReturnType<typeof setTimeout> | null = null;

/** Starts a turn unless one is already running (a wake turn continues into its reply). */
export function beginTurn(kind: string, at = Date.now()): void {
  if (current) return;
  current = { kind, started: at, marks: {}, counts: {}, notes: {} };
}

/** Records when `name` first happened in the current turn. */
export function mark(name: string, at = Date.now()): void {
  if (current && !(name in current.marks)) current.marks[name] = at - current.started;
}

export function count(name: string, by = 1): void {
  if (current) current.counts[name] = (current.counts[name] ?? 0) + by;
}

/** Adds a duration (ms) to a running total, e.g. time spent waiting for audio. */
export function addTime(name: string, ms: number): void {
  count(name, Math.max(0, Math.round(ms)));
}

export function note(name: string, value: string): void {
  if (current) current.notes[name] = value.slice(0, 60);
}

export function turnActive(): boolean {
  return current !== null;
}

/** Ends the turn and writes its report; `delay` lets late marks (last audio) land first. */
export function endTurn(delay = 0): void {
  if (finishTimer) clearTimeout(finishTimer);
  const send = () => {
    finishTimer = null;
    const turn = current;
    current = null;
    if (!turn || Object.keys(turn.marks).length === 0) return;
    void callNative("voice_report_turn", { report: turn }).catch(() => {});
  };
  if (delay > 0) finishTimer = setTimeout(send, delay);
  else send();
}

/** Drops the current turn without a report (nothing worth measuring happened). */
export function discardTurn(): void {
  if (finishTimer) clearTimeout(finishTimer);
  finishTimer = null;
  current = null;
}
