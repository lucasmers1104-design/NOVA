// The app's own decisions as pure functions, so they are tested without a phone
// (logic.test.ts). Nothing here touches React Native, Expo or the network.

import { type AppRelease, isNewerVersion } from "@nova/companion-protocol/app";
import type { ErrorMessage, PhoneMessage, TaskCreate, TaskState, TaskSummary } from "@nova/companion-protocol";
import { MAX_TASK_CHARS } from "@nova/companion-protocol";
import { type ChatEntry, scheduleText } from "@nova/companion-protocol/state";

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Cuts to `max` UTF-16 units without leaving half an emoji. A lone surrogate
 * survives JSON.stringify as an escape that the PC's parser refuses, which would
 * drop the whole message.
 */
export function safeSlice(text: string, max: number): string {
  let cut = text.length > max ? text.slice(0, max) : text;
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/** A task's text as the PC accepts it. */
export function taskText(text: string): string {
  return safeSlice(text.trim(), MAX_TASK_CHARS);
}

const TIME = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/;

/** "18.30" or "7:05" → "07:05"; `null` if it isn't a time. */
export function normalizeTime(text: string): string | null {
  const match = TIME.exec(text.trim());
  return match ? `${match[1]!.padStart(2, "0")}:${match[2]}` : null;
}

/** Dictation continues what was typed before the microphone was tapped. */
export function appendDictation(typed: string, heard: string): string {
  const before = typed.trimEnd();
  return before ? `${before} ${heard}` : heard;
}

export function greeting(date: Date): string {
  const hour = date.getHours();
  if (hour < 5) return "Gute Nacht";
  if (hour < 11) return "Guten Morgen";
  if (hour < 18) return "Hallo";
  return "Guten Abend";
}

/** "YYYY-MM-DD" of the day `offset` days from `now`, in the phone's time zone. */
export function localDay(now: Date, offset = 0): string {
  // Through the calendar, not by adding 24 hours: days are 23 or 25 hours long when the clocks change.
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The PC's refusals in the app's language; the PC itself speaks English. */
export function errorText(code: ErrorMessage["code"], fallback: string): string {
  switch (code) {
    case "busy":
      return "Am PC warten schon zu viele Aufträge.";
    case "unknownTask":
      return "Diesen Auftrag kennt dein PC nicht mehr.";
    case "unknownRequest":
      return "Diese Freigabe ist nicht mehr offen.";
    case "expired":
      return "Diese Freigabe ist abgelaufen.";
    case "badProof":
      return "Dein PC konnte die Freigabe nicht prüfen. Kopple dein Handy neu, wenn das wieder passiert.";
    case "notAllowed":
      return "Das ist vom Handy aus nicht erlaubt.";
    case "invalid":
      return fallback ? `Dein PC hat den Auftrag abgelehnt: ${fallback}` : "Dein PC hat den Auftrag abgelehnt.";
  }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/** Addresses in order of trust, each once, at most `most`. */
export function mergeHosts(first: readonly string[], rest: readonly string[], most = 8): string[] {
  return [...new Set([...first, ...rest])].slice(0, most);
}

/**
 * How far the PC's clock is ahead of the phone's, from the timestamp of a fresh
 * answer. Approvals expire by the PC's clock; without this a phone that runs
 * three minutes fast sees every approval as expired. Small differences keep the
 * old value so the screens don't re-render for jitter.
 */
export function clockOffset(previous: number, pcTs: number, now: number): number {
  const next = pcTs - now;
  return Math.abs(next - previous) < 2000 ? previous : next;
}

/** The pause before attempt number `failures + 1`: 2 s, doubling, at most a minute. */
export function retryDelay(failures: number): number {
  return Math.min(2000 * 2 ** Math.max(0, failures), 60_000);
}

// ---------------------------------------------------------------------------
// What waits for the connection (notifications and calls for Nova Island)
// ---------------------------------------------------------------------------

export interface Waiting {
  message: PhoneMessage;
  at: number;
}

const FORWARD_FRESH_MS = 60_000;
const MOST_FORWARD = 12;

function callEnded(message: PhoneMessage): boolean {
  return message.type === "phone.call" && message.state === "ended";
}

/** Adds one, forgets what is no news any more. The end of a call always stays: without it the PC shows the call forever. */
export function queueForward(waiting: readonly Waiting[], message: PhoneMessage, now: number): Waiting[] {
  const kept = waiting.filter((w) => {
    if (callEnded(w.message)) return true;
    // A newer state of the same call or notification replaces the older one.
    if (message.type === "phone.call" && w.message.type === "phone.call" && w.message.callId === message.callId) return false;
    if (message.type === "phone.notification" && w.message.type === "phone.notification" && w.message.notifId === message.notifId) return false;
    return now - w.at < FORWARD_FRESH_MS;
  });
  return [...kept, { message, at: now }].slice(-MOST_FORWARD);
}

/** What still goes out once the PC answers. Calls in progress are sent from their live state instead. */
export function dueForwards(waiting: readonly Waiting[], now: number): PhoneMessage[] {
  return waiting.filter((w) => callEnded(w.message) || (w.message.type === "phone.notification" && now - w.at < FORWARD_FRESH_MS)).map((w) => w.message);
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

const FINISHED: readonly (TaskState | "sending")[] = ["done", "failed", "cancelled", "missed"];

/**
 * Brings chat entries in line with the PC's task list. A result that was sent
 * into a dead connection never arrives; without this its entry would say
 * "NOVA arbeitet …" forever. The answer's text can't be recovered this way.
 */
export function reconcileChat(chat: ChatEntry[], tasks: readonly TaskSummary[]): ChatEntry[] {
  const final = new Map(tasks.filter((task) => FINISHED.includes(task.state)).map((task) => [task.taskId, task.state]));
  if (!final.size) return chat;
  let changed = false;
  const next = chat.map((entry) => {
    const state = final.get(entry.taskId);
    if (!state || FINISHED.includes(entry.state)) return entry;
    changed = true;
    return { ...entry, state, activity: null };
  });
  return changed ? next : chat;
}

/** Keeps the pictures of the newest `keep` answers; a screenshot is up to 4 MB of base64. */
export function trimScreenshots(chat: ChatEntry[], keep: number): ChatEntry[] {
  let left = keep;
  let changed = false;
  const next = [...chat];
  for (let i = next.length - 1; i >= 0; i--) {
    const entry = next[i]!;
    if (!entry.screenshot) continue;
    if (left > 0) {
      left--;
    } else {
      next[i] = { ...entry, screenshot: null };
      changed = true;
    }
  }
  return changed ? next : chat;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface TaskRow {
  taskId: string;
  text: string;
  state: TaskState | "outbox";
  when: string | null;
  /** Still to come or running: the PC can be told to drop it. Otherwise it can only be hidden on this phone. */
  cancellable: boolean;
}

/** The Tasks tab: what waits on the phone first, then what the PC knows, without what the user hid. */
export function taskRows(tasks: readonly TaskSummary[], outbox: readonly TaskCreate[], hidden: readonly string[], now: Date): TaskRow[] {
  const [today, tomorrow] = [localDay(now), localDay(now, 1)];
  const waiting: TaskRow[] = outbox.map((task) => ({ taskId: task.id, text: task.text, state: "outbox", when: scheduleText(task.schedule, today, tomorrow), cancellable: true }));
  const known: TaskRow[] = tasks.map((task) => {
    const [date, time] = task.runAt?.split(" ") ?? [];
    const when = date && time ? scheduleText({ kind: "at", date, time }, today, tomorrow) : null;
    return { taskId: task.taskId, text: task.text, state: task.state, when, cancellable: task.state === "queued" || task.state === "scheduled" || task.state === "running" };
  });
  const sent = new Set(waiting.map((row) => row.taskId));
  return [...waiting, ...known.filter((row) => !sent.has(row.taskId))].filter((row) => !hidden.includes(row.taskId));
}

/** Hidden ids the PC no longer lists don't need remembering. */
export function pruneHidden(hidden: readonly string[], tasks: readonly TaskSummary[], outbox: readonly TaskCreate[]): string[] {
  const known = new Set([...tasks.map((task) => task.taskId), ...outbox.map((task) => task.id)]);
  return hidden.filter((id) => known.has(id));
}

export interface DaySummary {
  /** Finished today. */
  done: number;
  /** Waiting on the phone or the PC, or running right now. */
  open: number;
  /** Set for a time still to come. */
  planned: number;
}

/** The start screen's "Heute": what NOVA did for this phone today and what is still to come. */
export function daySummary(tasks: readonly TaskSummary[], outbox: readonly TaskCreate[], now: Date): DaySummary {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const summary: DaySummary = { done: 0, open: outbox.length, planned: 0 };
  for (const task of tasks) {
    if (task.state === "scheduled") summary.planned += 1;
    else if (task.state === "queued" || task.state === "running") summary.open += 1;
    else if (task.state === "done" && task.createdAt >= midnight) summary.done += 1;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/**
 * Whether a release is worth offering. Android refuses an APK with a lower
 * versionCode than the installed one, so that never counts as an update, whatever
 * its version text says.
 */
export function updateOffered(release: Pick<AppRelease, "version" | "versionCode">, installed: { version: string; code: number }): boolean {
  if (release.versionCode < installed.code) return false;
  return release.versionCode > installed.code || isNewerVersion(release.version, installed.version);
}

// ---------------------------------------------------------------------------
// Forwarding per app
// ---------------------------------------------------------------------------

export interface SeenApp {
  app: string;
  name: string;
}

const MOST_SEEN_APPS = 40;

/**
 * Apps that sent a notification, for the per-app switches: a new one goes to the
 * front. Returns the same list for an app it already knows, so the caller can skip saving.
 */
export function rememberApp(seen: SeenApp[], app: string, name: string): SeenApp[] {
  if (seen.some((each) => each.app === app && each.name === name)) return seen;
  return [{ app, name }, ...seen.filter((each) => each.app !== app)].slice(0, MOST_SEEN_APPS);
}
