// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TaskCreate } from "./messages";
import { addTask, applyMessage, emptyState, liveApprovals, nextAt, noticeTitle, scheduleText } from "./state";

const task = (id: string, text = "Wie lange geht der Download noch?"): TaskCreate => ({ type: "task.create", id, ts: 1, text, voice: false, wantScreenshot: true, schedule: { kind: "now" } });
const ev = (taskId: string, event: object) => ({ type: "task.event", id: "e", ts: 2, taskId, event }) as never;

describe("phone state", () => {
  it("keeps a task in the outbox until the PC accepts it", () => {
    let state = addTask(emptyState, task("t1"));
    expect(state.outbox).toHaveLength(1);
    expect(state.chat.map((e) => [e.role, e.state])).toEqual([
      ["user", "sending"],
      ["nova", "sending"],
    ]);
    state = applyMessage(state, ev("t1", { kind: "accepted", state: "queued" }));
    expect(state.outbox).toHaveLength(0);
    expect(state.chat.every((e) => e.state === "queued")).toBe(true);
  });

  it("builds NOVA's answer from the events and the result", () => {
    let state = addTask(emptyState, task("t1"));
    state = applyMessage(state, ev("t1", { kind: "status", state: "analyzingScreen", detail: "Taking a screenshot" }));
    state = applyMessage(state, ev("t1", { kind: "toolStarted", toolId: "x", title: "Look at your screen", tier: "free" }));
    state = applyMessage(state, ev("t1", { kind: "toolFinished", toolId: "x", ok: true, summary: "Done" }));
    state = applyMessage(state, ev("t1", { kind: "text", text: "Noch " }));
    state = applyMessage(state, ev("t1", { kind: "text", text: "12 Minuten." }));
    const nova = state.chat.find((e) => e.role === "nova")!;
    expect(nova.text).toBe("Noch 12 Minuten.");
    expect(nova.activity).toBe("Taking a screenshot");
    expect(nova.steps).toEqual([{ toolId: "x", title: "Look at your screen", tier: "free", ok: true, summary: "Done" }]);

    const screenshot = { mime: "image/png" as const, width: 2, height: 1, data: "AA==" };
    state = applyMessage(state, { type: "task.result", id: "r", ts: 3, taskId: "t1", ok: true, text: "Noch etwa 12 Minuten.", screenshot, error: null });
    const done = state.chat.find((e) => e.role === "nova")!;
    expect(done).toMatchObject({ state: "done", text: "Noch etwa 12 Minuten.", screenshot, activity: null });
    expect(state.chat.find((e) => e.role === "user")!.state).toBe("done");
  });

  it("drops a task the PC refused from the outbox", () => {
    let state = addTask(emptyState, task("t1"));
    state = applyMessage(state, { type: "error", id: "e", ts: 2, code: "invalid", message: "That time is already over", replyTo: "t1" });
    expect(state.outbox).toHaveLength(0);
    expect(state.chat.find((e) => e.role === "nova")).toMatchObject({ state: "failed", error: "That time is already over" });
    // An error about something else changes nothing.
    expect(applyMessage(state, { type: "error", id: "e", ts: 2, code: "busy", message: "x", replyTo: "other" })).toBe(state);
  });

  it("fills in what finished while the phone was away", () => {
    let state = applyMessage(addTask(emptyState, task("t1")), ev("t1", { kind: "accepted", state: "running" }));
    state = applyMessage(state, { type: "notices", id: "n", ts: 5, items: [{ id: "n1", kind: "taskDone", text: "Fertig, 0 Minuten.", taskId: "t1", ts: 5 }] });
    expect(state.chat.find((e) => e.role === "nova")).toMatchObject({ state: "done", text: "Fertig, 0 Minuten." });
  });

  it("tracks approvals until they close or expire", () => {
    const request = { type: "approval.request", id: "a", ts: 1, requestId: "r1", taskId: "t1", title: "End Steam", detail: null, risk: "high", expiresAt: 100 } as const;
    let state = applyMessage(emptyState, request);
    state = applyMessage(state, request);
    expect(state.approvals).toHaveLength(1);
    expect(liveApprovals(state.approvals, 50)).toHaveLength(1);
    expect(liveApprovals(state.approvals, 100)).toHaveLength(0);
    state = applyMessage(state, { type: "approval.closed", id: "c", ts: 2, requestId: "r1", outcome: "approved" });
    expect(state.approvals).toHaveLength(0);
  });

  it("forgets everything when the PC revokes the phone", () => {
    const state = addTask(emptyState, task("t1"));
    expect(applyMessage(state, { type: "device.revoked", id: "d", ts: 1 })).toEqual(emptyState);
  });
});

describe("texts and times", () => {
  it("keeps content off the lock screen", () => {
    for (const kind of ["approval", "taskDone", "taskFailed", "taskMissed", "checkStopped", "watch"] as const) {
      expect(noticeTitle(kind)).not.toMatch(/!/);
    }
  });

  it("plans HH:MM for today or tomorrow", () => {
    const now = new Date(2026, 10, 8, 12, 0);
    expect(nextAt("18:30", now)).toEqual({ kind: "at", date: "2026-11-08", time: "18:30" });
    expect(nextAt("08:00", now)).toEqual({ kind: "at", date: "2026-11-09", time: "08:00" });
    expect(nextAt("12:00", now)).toEqual({ kind: "at", date: "2026-11-09", time: "12:00" });
    expect(nextAt("23:59", new Date(2026, 11, 31, 23, 59))).toEqual({ kind: "at", date: "2027-01-01", time: "23:59" });
    expect(scheduleText({ kind: "at", date: "2026-11-09", time: "08:00" }, "2026-11-08", "2026-11-09")).toBe("Morgen 08:00");
    expect(scheduleText({ kind: "at", date: "2026-11-12", time: "08:00" }, "2026-11-08", "2026-11-09")).toBe("12.11.2026 08:00");
    expect(scheduleText({ kind: "now" }, "", "")).toBeNull();
  });
});
