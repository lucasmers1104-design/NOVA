import type { PhoneMessage, PhoneNotification, TaskCreate, TaskSummary } from "@nova/companion-protocol";
import type { ChatEntry } from "@nova/companion-protocol/state";
import { describe, expect, it } from "vitest";
import {
  appendDictation,
  clockOffset,
  daySummary,
  dueForwards,
  errorText,
  localDay,
  mergeHosts,
  normalizeTime,
  pruneHidden,
  queueForward,
  reconcileChat,
  rememberApp,
  retryDelay,
  safeSlice,
  taskRows,
  taskText,
  trimScreenshots,
  updateOffered,
  type Waiting,
} from "./logic";

const entry = (taskId: string, role: ChatEntry["role"], state: ChatEntry["state"], more: Partial<ChatEntry> = {}): ChatEntry => ({
  taskId,
  role,
  text: "",
  ts: 0,
  state,
  activity: null,
  steps: [],
  screenshot: null,
  error: null,
  schedule: { kind: "now" },
  ...more,
});

const summary = (taskId: string, state: TaskSummary["state"], more: Partial<TaskSummary> = {}): TaskSummary => ({ taskId, text: taskId, state, runAt: null, createdAt: 0, ...more });

const create = (id: string, schedule: TaskCreate["schedule"] = { kind: "now" }): TaskCreate => ({ type: "task.create", id, ts: 0, text: id, voice: false, wantScreenshot: false, schedule });

const notification = (notifId: string, title = ""): PhoneNotification => ({ type: "phone.notification", id: "m", ts: 0, notifId, app: "com.whatsapp", appName: "WhatsApp", title, text: "", icon: null, posted: 0 });

const call = (callId: string, state: "ringing" | "active" | "ended"): PhoneMessage => ({ type: "phone.call", id: "m", ts: 0, callId, state, name: null, number: null, photo: null, canAnswer: false, canDecline: false });

describe("text", () => {
  it("never leaves half an emoji at the cut", () => {
    const text = `${"a".repeat(199)}😀`;
    expect(safeSlice(text, 200)).toBe("a".repeat(199));
    expect(safeSlice(text, 201)).toBe(text);
    // Android's own cut can already have split a pair before the text reaches JavaScript.
    expect(safeSlice("ab\ud83d", 10)).toBe("ab");
    expect(JSON.parse(JSON.stringify(safeSlice(text, 200)))).toBe("a".repeat(199));
  });

  it("cuts a task to what the PC accepts", () => {
    expect(taskText(`  ${"x".repeat(5000)}  `)).toHaveLength(4000);
    expect(taskText("  Öffne Spotify ")).toBe("Öffne Spotify");
  });

  it("reads times the way people type them", () => {
    expect(normalizeTime("18.30")).toBe("18:30");
    expect(normalizeTime(" 7:05 ")).toBe("07:05");
    expect(normalizeTime("24:00")).toBeNull();
    expect(normalizeTime("18:3")).toBeNull();
    expect(normalizeTime("")).toBeNull();
  });

  it("appends dictation to what was typed", () => {
    expect(appendDictation("Öffne ", "Spotify")).toBe("Öffne Spotify");
    expect(appendDictation("", "Spotify")).toBe("Spotify");
  });

  it("puts the PC's refusals into the app's words", () => {
    expect(errorText("busy", "Too many tasks are waiting")).not.toMatch(/Too many/);
    expect(errorText("unknownRequest", "")).toBe("Diese Freigabe ist nicht mehr offen.");
    expect(errorText("invalid", "text is empty")).toContain("text is empty");
  });

  it("finds tomorrow through the calendar, not by adding 24 hours", () => {
    // 2026-03-29 is the day the clocks go forward in Germany: it has 23 hours.
    expect(localDay(new Date(2026, 2, 28, 23, 30), 1)).toBe("2026-03-29");
    expect(localDay(new Date(2026, 11, 31, 12, 0), 1)).toBe("2027-01-01");
    expect(localDay(new Date(2026, 0, 5, 0, 0))).toBe("2026-01-05");
  });
});

describe("connection", () => {
  it("merges addresses, each once, in order of trust", () => {
    expect(mergeHosts(["b:1"], ["a:1", "b:1", "c:1"])).toEqual(["b:1", "a:1", "c:1"]);
    expect(mergeHosts(["1", "2", "3"], ["4", "5"], 4)).toEqual(["1", "2", "3", "4"]);
  });

  it("estimates the PC's clock and ignores jitter", () => {
    expect(clockOffset(0, 1_180_000, 1_000_000)).toBe(180_000);
    expect(clockOffset(180_000, 1_180_900, 1_000_000)).toBe(180_000);
    expect(clockOffset(180_000, 1_000_000, 1_000_000)).toBe(0);
  });

  it("waits longer after every failure, up to a minute", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(retryDelay)).toEqual([2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]);
  });
});

describe("forwarding queue", () => {
  it("drops stale notifications but never the end of a call", () => {
    let waiting: Waiting[] = [];
    waiting = queueForward(waiting, notification("n1"), 0);
    waiting = queueForward(waiting, call("c1", "ringing"), 1000);
    waiting = queueForward(waiting, call("c1", "ended"), 5000);
    // Two minutes later: the notification is no news, the ringing was replaced, the end remains.
    expect(dueForwards(waiting, 120_000)).toEqual([call("c1", "ended")]);
  });

  it("keeps only the newest state of the same notification and sends fresh ones", () => {
    let waiting: Waiting[] = [];
    waiting = queueForward(waiting, notification("n1"), 0);
    waiting = queueForward(waiting, notification("n1", "neu"), 1000);
    waiting = queueForward(waiting, notification("n2"), 2000);
    expect(dueForwards(waiting, 3000)).toEqual([notification("n1", "neu"), notification("n2")]);
  });

  it("leaves calls in progress to the live snapshot", () => {
    const waiting = queueForward([], call("c1", "ringing"), 0);
    expect(dueForwards(waiting, 1000)).toEqual([]);
  });

  it("stays small", () => {
    let waiting: Waiting[] = [];
    for (let i = 0; i < 50; i++) waiting = queueForward(waiting, notification(`n${i}`), i);
    expect(waiting.length).toBeLessThanOrEqual(12);
  });
});

describe("chat", () => {
  it("ends entries the PC's list says are over", () => {
    const chat = [entry("t1", "user", "running"), entry("t1", "nova", "running", { text: "Teil", activity: "Screenshot" }), entry("t2", "nova", "running")];
    const next = reconcileChat(chat, [summary("t1", "done"), summary("t2", "running")]);
    expect(next[0]!.state).toBe("done");
    expect(next[1]).toMatchObject({ state: "done", text: "Teil", activity: null });
    expect(next[2]).toBe(chat[2]);
  });

  it("returns the same chat when nothing changed", () => {
    const chat = [entry("t1", "nova", "done"), entry("t2", "nova", "running")];
    expect(reconcileChat(chat, [summary("t1", "failed"), summary("t2", "queued")])).toBe(chat);
    expect(reconcileChat(chat, [])).toBe(chat);
  });

  it("keeps only the newest screenshots", () => {
    const shot = { mime: "image/jpeg" as const, width: 1, height: 1, data: "x" };
    const chat = [entry("a", "nova", "done", { screenshot: shot }), entry("b", "nova", "done"), entry("c", "nova", "done", { screenshot: shot }), entry("d", "nova", "done", { screenshot: shot })];
    const next = trimScreenshots(chat, 2);
    expect(next.map((e) => Boolean(e.screenshot))).toEqual([false, false, true, true]);
    expect(trimScreenshots(next, 2)).toBe(next);
  });
});

describe("tasks", () => {
  const now = new Date(2026, 10, 11, 9, 0);

  it("lists what waits on the phone first and leaves out hidden and duplicate rows", () => {
    const rows = taskRows([summary("t1", "done"), summary("t2", "scheduled", { runAt: "2026-11-11 18:30" }), summary("o1", "queued"), summary("t3", "running")], [create("o1", { kind: "whenOnline" })], ["t1"], now);
    expect(rows.map((row) => row.taskId)).toEqual(["o1", "t2", "t3"]);
    expect(rows[0]).toMatchObject({ state: "outbox", when: "Sobald der PC an ist", cancellable: true });
    expect(rows[1]).toMatchObject({ when: "Heute 18:30", cancellable: true });
    expect(rows[2]).toMatchObject({ state: "running", cancellable: true });
  });

  it("offers finished tasks for hiding only", () => {
    expect(taskRows([summary("t1", "failed")], [], [], now)[0]!.cancellable).toBe(false);
  });

  it("forgets hidden ids the PC no longer lists", () => {
    expect(pruneHidden(["t1", "gone", "o1"], [summary("t1", "done")], [create("o1")])).toEqual(["t1", "o1"]);
  });

  it("sums up today", () => {
    const midnight = new Date(2026, 10, 11).getTime();
    const tasks = [summary("a", "done", { createdAt: midnight + 1 }), summary("b", "done", { createdAt: midnight - 1 }), summary("c", "scheduled"), summary("d", "running"), summary("e", "queued"), summary("f", "failed", { createdAt: midnight + 5 })];
    expect(daySummary(tasks, [create("o1")], now)).toEqual({ done: 1, open: 3, planned: 1 });
  });
});

describe("updates", () => {
  const installed = { version: "1.2.0", code: 3 };

  it("offers a higher versionCode or a newer version", () => {
    expect(updateOffered({ version: "1.2.1", versionCode: 4 }, installed)).toBe(true);
    expect(updateOffered({ version: "1.3.0", versionCode: 3 }, installed)).toBe(true);
    expect(updateOffered({ version: "1.2.0", versionCode: 3 }, installed)).toBe(false);
  });

  it("never offers what Android would refuse", () => {
    expect(updateOffered({ version: "9.0.0", versionCode: 2 }, installed)).toBe(false);
  });
});

describe("apps for per-app forwarding", () => {
  it("adds a new app in front and keeps the list for a known one", () => {
    const seen = [{ app: "com.whatsapp", name: "WhatsApp" }];
    expect(rememberApp(seen, "com.whatsapp", "WhatsApp")).toBe(seen);
    expect(rememberApp(seen, "org.telegram", "Telegram")).toEqual([{ app: "org.telegram", name: "Telegram" }, ...seen]);
    expect(rememberApp(seen, "com.whatsapp", "WhatsApp Business")).toEqual([{ app: "com.whatsapp", name: "WhatsApp Business" }]);
  });

  it("stays bounded", () => {
    let seen: { app: string; name: string }[] = [];
    for (let i = 0; i < 100; i++) seen = rememberApp(seen, `app${i}`, `App ${i}`);
    expect(seen).toHaveLength(40);
    expect(seen[0]!.app).toBe("app99");
  });
});
