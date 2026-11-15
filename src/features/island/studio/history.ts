// Undo and redo for Island Studio, as pure functions over a small record.

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** What the latest change was about ("look.radius"), and when: a slider dragged in one go is one step. */
  tag: string | null;
  at: number;
}

/** How many steps back are kept. */
const MOST_STEPS = 60;
/** Changes with the same tag closer together than this merge into one step. */
const MERGE_MS = 800;

export function startHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], tag: null, at: 0 };
}

/** A new present. Redo is gone after it, as everywhere. */
export function commit<T>(history: History<T>, next: T, tag: string | null, now: number): History<T> {
  if (Object.is(next, history.present)) return history;
  const merges = tag !== null && tag === history.tag && now - history.at < MERGE_MS;
  const past = merges ? history.past : [...history.past, history.present].slice(-MOST_STEPS);
  return { past, present: next, future: [], tag, at: now };
}

export function undo<T>(history: History<T>): History<T> {
  const previous = history.past.at(-1);
  if (previous === undefined) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future], tag: null, at: 0 };
}

export function redo<T>(history: History<T>): History<T> {
  const [next, ...future] = history.future;
  if (next === undefined) return history;
  return { past: [...history.past, history.present], present: next, future, tag: null, at: 0 };
}
