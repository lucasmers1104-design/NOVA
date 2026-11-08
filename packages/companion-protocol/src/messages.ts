// NOVA Companion protocol v1. The Rust side (src-tauri/src/companion/protocol.rs)
// mirrors these types; both parse the same fixtures in ../fixtures.

export const PROTOCOL_VERSION = 1;

/** Largest encrypted frame either side accepts (a task result with a screenshot). */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** Largest frame for everything else. */
export const MAX_SMALL_FRAME_BYTES = 64 * 1024;
export const MAX_TASK_CHARS = 4000;

// ---------------------------------------------------------------------------
// Handshake and pairing (plain JSON text frames; keys are base64url)
// ---------------------------------------------------------------------------

export interface Hello {
  type: "hello";
  v: number;
  deviceId: string;
  ephPub: string;
  nonce: string;
}

export interface Welcome {
  type: "welcome";
  v: number;
  pcId: string;
  ephPub: string;
  nonce: string;
}

/** `box` holds a sealed `PairDetails`. */
export interface PairRequest {
  type: "pair.request";
  v: number;
  ephPub: string;
  box: string;
}

export interface PairDetails {
  deviceName: string;
  platform: "android" | "ios";
  devicePub: string;
  approvalKey: string;
}

/** `box` holds a sealed `{ deviceId }`. */
export interface PairAccepted {
  type: "pair.accepted";
  box: string;
}

export interface PairRejected {
  type: "pair.rejected";
  reason: "expired" | "declined" | "used" | "busy" | "invalid";
}

export type Handshake = Hello | Welcome | PairRequest | PairAccepted | PairRejected;

/** What the QR code on the PC carries. */
export interface PairingCode {
  pcId: string;
  pcPub: string;
  secret: string;
  hosts: string[];
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Encrypted messages
// ---------------------------------------------------------------------------

export type Schedule = { kind: "now" } | { kind: "whenOnline" } | { kind: "at"; date: string; time: string };

export type Tier = "free" | "approve" | "never";
export type Risk = "safe" | "confirm" | "high";
export type TaskState = "queued" | "scheduled" | "running" | "done" | "failed" | "cancelled" | "missed";
export type AgentState = "thinking" | "searching" | "analyzingScreen" | "executing" | "completed" | "error";

interface Base {
  id: string;
  ts: number;
}

export interface TaskCreate extends Base {
  type: "task.create";
  text: string;
  voice: boolean;
  wantScreenshot: boolean;
  schedule: Schedule;
}

export interface TaskCancel extends Base {
  type: "task.cancel";
  taskId: string;
}

export interface ApprovalAnswer extends Base {
  type: "approval.answer";
  requestId: string;
  approved: boolean;
  /** base64url HMAC-SHA256(approvalKey, `${requestId}|approve|${expiresAt}`); only with `approved`. */
  proof?: string;
}

export interface StatusGet extends Base {
  type: "status.get";
}

export interface NoticesGet extends Base {
  type: "notices.get";
}

export interface NoticesAck extends Base {
  type: "notices.ack";
  ids: string[];
}

export interface TasksList extends Base {
  type: "tasks.list";
}

export type PhoneMessage = TaskCreate | TaskCancel | ApprovalAnswer | StatusGet | NoticesGet | NoticesAck | TasksList;

export interface Media {
  title: string;
  artist: string;
  playing: boolean;
}

export interface Status extends Base {
  type: "status";
  pcName: string;
  busy: boolean;
  aiReady: boolean;
  inGame: boolean;
  media: Media | null;
  pendingApprovals: number;
  activeTasks: number;
}

export type TaskEventBody =
  | { kind: "accepted"; state: TaskState; runAt?: string }
  | { kind: "status"; state: AgentState; detail?: string }
  | { kind: "text"; text: string }
  | { kind: "toolStarted"; toolId: string; title: string; tier: Tier }
  | { kind: "toolFinished"; toolId: string; ok: boolean; summary: string };

export interface TaskEvent extends Base {
  type: "task.event";
  taskId: string;
  event: TaskEventBody;
}

export interface Screenshot {
  mime: "image/png" | "image/jpeg";
  width: number;
  height: number;
  data: string;
}

export interface TaskResult extends Base {
  type: "task.result";
  taskId: string;
  ok: boolean;
  text: string;
  screenshot: Screenshot | null;
  error: string | null;
}

export interface ApprovalRequest extends Base {
  type: "approval.request";
  requestId: string;
  taskId: string;
  title: string;
  detail: string | null;
  risk: Risk;
  expiresAt: number;
}

export interface ApprovalClosed extends Base {
  type: "approval.closed";
  requestId: string;
  outcome: "approved" | "declined" | "expired" | "cancelled";
}

export type NoticeKind = "watch" | "taskDone" | "taskFailed" | "taskMissed" | "checkStopped";

export interface Notice {
  id: string;
  kind: NoticeKind;
  text: string;
  taskId: string | null;
  ts: number;
}

export interface Notices extends Base {
  type: "notices";
  items: Notice[];
}

export interface TaskSummary {
  taskId: string;
  text: string;
  state: TaskState;
  /** "YYYY-MM-DD HH:MM" for scheduled tasks. */
  runAt: string | null;
  createdAt: number;
}

export interface Tasks extends Base {
  type: "tasks";
  items: TaskSummary[];
}

export interface ErrorMessage extends Base {
  type: "error";
  code: "invalid" | "busy" | "unknownTask" | "unknownRequest" | "expired" | "badProof" | "notAllowed";
  message: string;
  replyTo: string | null;
}

export interface DeviceRevoked extends Base {
  type: "device.revoked";
}

export type PcMessage = Status | TaskEvent | TaskResult | ApprovalRequest | ApprovalClosed | Notices | Tasks | ErrorMessage | DeviceRevoked;
