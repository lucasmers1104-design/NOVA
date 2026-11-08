// What the phone shows, as pure functions over messages from the PC. The app keeps
// this in a store and saves it; tests check it without a phone.

import type { ApprovalRequest, NoticeKind, PcMessage, Schedule, Screenshot, Status, TaskCreate, TaskState, TaskSummary, Tier } from "./messages";

export interface Step {
  toolId: string;
  title: string;
  tier: Tier;
  ok?: boolean;
  summary?: string;
}

export interface ChatEntry {
  /** The task id: one user entry and one NOVA entry share it. */
  taskId: string;
  role: "user" | "nova";
  text: string;
  ts: number;
  state: TaskState | "sending";
  /** What NOVA is doing right now, e.g. "Taking a screenshot". */
  activity: string | null;
  steps: Step[];
  screenshot: Screenshot | null;
  error: string | null;
  schedule: Schedule;
}

export interface PhoneState {
  status: Status | null;
  chat: ChatEntry[];
  approvals: ApprovalRequest[];
  tasks: TaskSummary[];
  /** Tasks not yet confirmed by the PC; sent again on every connect. */
  outbox: TaskCreate[];
}

export const emptyState: PhoneState = { status: null, chat: [], approvals: [], tasks: [], outbox: [] };

const MOST_CHAT = 200;
const FINISHED: readonly (TaskState | "sending")[] = ["done", "failed", "cancelled", "missed"];

function updateNova(chat: ChatEntry[], taskId: string, change: (entry: ChatEntry) => ChatEntry): ChatEntry[] {
  return chat.map((entry) => (entry.taskId === taskId && entry.role === "nova" ? change(entry) : entry));
}

/** A new task: shown at once, kept in the outbox until the PC confirms it. */
export function addTask(state: PhoneState, task: TaskCreate): PhoneState {
  const base = { taskId: task.id, ts: task.ts, activity: null, steps: [], screenshot: null, error: null, schedule: task.schedule };
  const chat: ChatEntry[] = [...state.chat, { ...base, role: "user", text: task.text, state: "sending" }, { ...base, role: "nova", text: "", state: "sending" }];
  return { ...state, chat: chat.slice(-MOST_CHAT), outbox: [...state.outbox, task] };
}

export function applyMessage(state: PhoneState, message: PcMessage): PhoneState {
  switch (message.type) {
    case "status":
      return { ...state, status: message };
    case "task.event": {
      const { taskId, event } = message;
      switch (event.kind) {
        case "accepted":
          return {
            ...state,
            outbox: state.outbox.filter((task) => task.id !== taskId),
            chat: state.chat.map((entry) => (entry.taskId === taskId && !FINISHED.includes(entry.state) ? { ...entry, state: event.state } : entry)),
          };
        case "status":
          return { ...state, chat: updateNova(state.chat, taskId, (entry) => ({ ...entry, state: "running", activity: event.detail ?? null })) };
        case "text":
          return { ...state, chat: updateNova(state.chat, taskId, (entry) => ({ ...entry, text: entry.text + event.text })) };
        case "toolStarted":
          return { ...state, chat: updateNova(state.chat, taskId, (entry) => ({ ...entry, steps: [...entry.steps, { toolId: event.toolId, title: event.title, tier: event.tier }] })) };
        case "toolFinished":
          return {
            ...state,
            chat: updateNova(state.chat, taskId, (entry) => ({ ...entry, steps: entry.steps.map((step) => (step.toolId === event.toolId ? { ...step, ok: event.ok, summary: event.summary } : step)) })),
          };
      }
      return state;
    }
    case "task.result": {
      const done: TaskState = message.ok ? "done" : message.error ? "failed" : "cancelled";
      return {
        ...state,
        outbox: state.outbox.filter((task) => task.id !== message.taskId),
        chat: state.chat.map((entry) =>
          entry.taskId !== message.taskId
            ? entry
            : entry.role === "user"
              ? { ...entry, state: done }
              : { ...entry, state: done, text: message.text || entry.text, screenshot: message.screenshot, error: message.error, activity: null },
        ),
      };
    }
    case "approval.request":
      return state.approvals.some((a) => a.requestId === message.requestId) ? state : { ...state, approvals: [...state.approvals, message] };
    case "approval.closed":
      return { ...state, approvals: state.approvals.filter((a) => a.requestId !== message.requestId) };
    case "tasks":
      return { ...state, tasks: message.items };
    case "notices": {
      // A task that finished while the phone was away: its text arrives as a notice.
      let chat = state.chat;
      for (const notice of message.items) {
        if (!notice.taskId) continue;
        const state: TaskState = notice.kind === "taskDone" ? "done" : notice.kind === "taskMissed" ? "missed" : "failed";
        chat = chat.map((entry) =>
          entry.taskId !== notice.taskId || FINISHED.includes(entry.state) ? entry : { ...entry, state, ...(entry.role === "nova" ? { text: notice.text, activity: null } : {}) },
        );
      }
      return { ...state, chat };
    }
    case "error": {
      // The PC refused a task: it won't come back from the outbox.
      if (!message.replyTo || !state.outbox.some((task) => task.id === message.replyTo)) return state;
      const id = message.replyTo;
      return {
        ...state,
        outbox: state.outbox.filter((task) => task.id !== id),
        chat: state.chat.map((entry) => (entry.taskId !== id ? entry : { ...entry, state: "failed", ...(entry.role === "nova" ? { error: message.message } : {}) })),
      };
    }
    case "device.revoked":
      return emptyState;
  }
}

/** Waiting approvals that are still valid. */
export function liveApprovals(approvals: ApprovalRequest[], now: number): ApprovalRequest[] {
  return approvals.filter((a) => a.expiresAt > now);
}

/**
 * Lock-screen texts carry no content (decided 2026-11-08): the details are only
 * visible in the app, over the encrypted connection.
 */
export function noticeTitle(kind: NoticeKind | "approval"): string {
  switch (kind) {
    case "approval":
      return "Neue Freigabe";
    case "taskDone":
      return "Auftrag fertig";
    case "taskFailed":
      return "Auftrag nicht erledigt";
    case "taskMissed":
      return "Auftrag verpasst";
    case "checkStopped":
      return "NOVA prüft nicht mehr";
    case "watch":
      return "NOVA meldet sich";
  }
}

/** "Heute 18:30", "Morgen 08:00" or the date, for scheduled tasks. */
export function scheduleText(schedule: Schedule, today: string, tomorrow: string): string | null {
  switch (schedule.kind) {
    case "now":
      return null;
    case "whenOnline":
      return "Sobald der PC an ist";
    case "at": {
      const day = schedule.date === today ? "Heute" : schedule.date === tomorrow ? "Morgen" : schedule.date.split("-").reverse().join(".");
      return `${day} ${schedule.time}`;
    }
  }
}

/** The next date "HH:MM" falls on: today if it is still ahead, else tomorrow. */
export function nextAt(time: string, now: Date): Schedule {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  const at = new Date(now);
  at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { kind: "at", date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`, time: `${pad(hours)}:${pad(minutes)}` };
}
