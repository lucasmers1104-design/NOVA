// Checking parsers: everything that crosses the wire is `unknown` until one of
// these accepts it. Unknown fields are ignored, unknown types are refused.

import type {
  AgentState,
  Handshake,
  Media,
  Notice,
  NoticeKind,
  PairDetails,
  PairingCode,
  PcMessage,
  PhoneMessage,
  Risk,
  Schedule,
  Screenshot,
  TaskEventBody,
  TaskState,
  TaskSummary,
  Tier,
} from "./messages";
import { MAX_TASK_CHARS, PROTOCOL_VERSION } from "./messages";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

class Invalid extends Error {}

type Obj = Record<string, unknown>;

function obj(value: unknown, what = "message"): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Invalid(`${what} is not an object`);
  return value as Obj;
}

function str(o: Obj, key: string, max = 2000, min = 0): string {
  const value = o[key];
  if (typeof value !== "string") throw new Invalid(`${key} is not a string`);
  if (value.length < min || value.length > max) throw new Invalid(`${key} has a bad length`);
  return value;
}

function optStr(o: Obj, key: string, max = 2000): string | undefined {
  return o[key] === undefined ? undefined : str(o, key, max);
}

function nullableStr(o: Obj, key: string, max = 2000): string | null {
  return o[key] === null || o[key] === undefined ? null : str(o, key, max);
}

function bool(o: Obj, key: string): boolean {
  if (typeof o[key] !== "boolean") throw new Invalid(`${key} is not a boolean`);
  return o[key] as boolean;
}

function int(o: Obj, key: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const value = o[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Invalid(`${key} is not a valid number`);
  return value;
}

function oneOf<T extends string>(o: Obj, key: string, allowed: readonly T[]): T {
  const value = o[key];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new Invalid(`${key} is not allowed`);
  return value as T;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url without padding
const NONCE = /^[A-Za-z0-9_-]{22}$/; // 16 bytes
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function id(o: Obj, key: string): string {
  const value = str(o, key, 64, 1);
  if (!ID.test(value)) throw new Invalid(`${key} is not an id`);
  return value;
}

function key32(o: Obj, key: string): string {
  const value = str(o, key, 43, 43);
  if (!KEY.test(value)) throw new Invalid(`${key} is not a key`);
  return value;
}

function base(o: Obj) {
  return { id: id(o, "id"), ts: int(o, "ts") };
}

function attempt<T>(f: () => T): Parsed<T> {
  try {
    return { ok: true, value: f() };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, error: error.message };
    throw error;
  }
}

const TASK_STATES: readonly TaskState[] = ["queued", "scheduled", "running", "done", "failed", "cancelled", "missed"];
const AGENT_STATES: readonly AgentState[] = ["thinking", "searching", "analyzingScreen", "executing", "completed", "error"];
const TIERS: readonly Tier[] = ["free", "approve", "never"];
const RISKS: readonly Risk[] = ["safe", "confirm", "high"];
const NOTICE_KINDS: readonly NoticeKind[] = ["watch", "taskDone", "taskFailed", "taskMissed", "checkStopped"];

function schedule(value: unknown): Schedule {
  const o = obj(value, "schedule");
  const kind = oneOf(o, "kind", ["now", "whenOnline", "at"] as const);
  if (kind !== "at") return { kind };
  const date = str(o, "date", 10);
  const time = str(o, "time", 5);
  if (!DATE.test(date) || !TIME.test(time)) throw new Invalid("schedule time is not valid");
  return { kind, date, time };
}

export function parsePhoneMessage(value: unknown): Parsed<PhoneMessage> {
  return attempt(() => {
    const o = obj(value);
    const type = o.type;
    switch (type) {
      case "task.create": {
        const text = str(o, "text", MAX_TASK_CHARS, 1);
        if (!text.trim()) throw new Invalid("text is empty");
        return { type, ...base(o), text, voice: bool(o, "voice"), wantScreenshot: bool(o, "wantScreenshot"), schedule: schedule(o.schedule) };
      }
      case "task.cancel":
        return { type, ...base(o), taskId: id(o, "taskId") };
      case "approval.answer": {
        const approved = bool(o, "approved");
        const proof = approved ? key32(o, "proof") : undefined;
        return { type, ...base(o), requestId: id(o, "requestId"), approved, ...(proof ? { proof } : {}) };
      }
      case "status.get":
      case "notices.get":
      case "tasks.list":
        return { type, ...base(o) };
      case "notices.ack": {
        const ids = o.ids;
        if (!Array.isArray(ids) || ids.length > 100) throw new Invalid("ids is not a list");
        return { type, ...base(o), ids: ids.map((each, i) => id({ [i]: each }, String(i))) };
      }
      default:
        throw new Invalid("unknown message type");
    }
  });
}

function media(value: unknown): Media | null {
  if (value === null) return null;
  const o = obj(value, "media");
  return { title: str(o, "title", 500), artist: str(o, "artist", 500), playing: bool(o, "playing") };
}

function eventBody(value: unknown): TaskEventBody {
  const o = obj(value, "event");
  const kind = o.kind;
  switch (kind) {
    case "accepted": {
      const runAt = optStr(o, "runAt", 16);
      return { kind, state: oneOf(o, "state", TASK_STATES), ...(runAt ? { runAt } : {}) };
    }
    case "status": {
      const detail = optStr(o, "detail", 500);
      return { kind, state: oneOf(o, "state", AGENT_STATES), ...(detail ? { detail } : {}) };
    }
    case "text":
      return { kind, text: str(o, "text", 20_000) };
    case "toolStarted":
      return { kind, toolId: str(o, "toolId", 200, 1), title: str(o, "title", 500), tier: oneOf(o, "tier", TIERS) };
    case "toolFinished":
      return { kind, toolId: str(o, "toolId", 200, 1), ok: bool(o, "ok"), summary: str(o, "summary", 2000) };
    default:
      throw new Invalid("unknown event kind");
  }
}

function screenshot(value: unknown): Screenshot | null {
  if (value === null || value === undefined) return null;
  const o = obj(value, "screenshot");
  return { mime: oneOf(o, "mime", ["image/png", "image/jpeg"] as const), width: int(o, "width", 1, 10_000), height: int(o, "height", 1, 10_000), data: str(o, "data", 6_000_000, 1) };
}

function list<T>(value: unknown, max: number, each: (o: Obj) => T): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Invalid("items is not a list");
  return value.map((item) => each(obj(item, "item")));
}

function notice(o: Obj): Notice {
  return { id: id(o, "id"), kind: oneOf(o, "kind", NOTICE_KINDS), text: str(o, "text", 2000), taskId: o.taskId == null ? null : id(o, "taskId"), ts: int(o, "ts") };
}

function taskSummary(o: Obj): TaskSummary {
  return { taskId: id(o, "taskId"), text: str(o, "text", MAX_TASK_CHARS), state: oneOf(o, "state", TASK_STATES), runAt: nullableStr(o, "runAt", 16), createdAt: int(o, "createdAt") };
}

export function parsePcMessage(value: unknown): Parsed<PcMessage> {
  return attempt(() => {
    const o = obj(value);
    const type = o.type;
    switch (type) {
      case "status":
        return {
          type,
          ...base(o),
          pcName: str(o, "pcName", 200),
          busy: bool(o, "busy"),
          aiReady: bool(o, "aiReady"),
          inGame: bool(o, "inGame"),
          media: media(o.media),
          pendingApprovals: int(o, "pendingApprovals", 0, 1000),
          activeTasks: int(o, "activeTasks", 0, 1000),
        };
      case "task.event":
        return { type, ...base(o), taskId: id(o, "taskId"), event: eventBody(o.event) };
      case "task.result":
        return { type, ...base(o), taskId: id(o, "taskId"), ok: bool(o, "ok"), text: str(o, "text", 50_000), screenshot: screenshot(o.screenshot), error: nullableStr(o, "error") };
      case "approval.request":
        return { type, ...base(o), requestId: id(o, "requestId"), taskId: id(o, "taskId"), title: str(o, "title", 500), detail: nullableStr(o, "detail", 2000), risk: oneOf(o, "risk", RISKS), expiresAt: int(o, "expiresAt") };
      case "approval.closed":
        return { type, ...base(o), requestId: id(o, "requestId"), outcome: oneOf(o, "outcome", ["approved", "declined", "expired", "cancelled"] as const) };
      case "notices":
        return { type, ...base(o), items: list(o.items, 200, notice) };
      case "tasks":
        return { type, ...base(o), items: list(o.items, 200, taskSummary) };
      case "error":
        return {
          type,
          ...base(o),
          code: oneOf(o, "code", ["invalid", "busy", "unknownTask", "unknownRequest", "expired", "badProof", "notAllowed"] as const),
          message: str(o, "message", 2000),
          replyTo: o.replyTo == null ? null : id(o, "replyTo"),
        };
      case "device.revoked":
        return { type, ...base(o) };
      default:
        throw new Invalid("unknown message type");
    }
  });
}

export function parseHandshake(value: unknown): Parsed<Handshake> {
  return attempt(() => {
    const o = obj(value);
    const type = o.type;
    const version = () => {
      if (int(o, "v") !== PROTOCOL_VERSION) throw new Invalid("unsupported version");
      return PROTOCOL_VERSION;
    };
    const nonce = () => {
      const value = str(o, "nonce", 22, 22);
      if (!NONCE.test(value)) throw new Invalid("nonce is not valid");
      return value;
    };
    switch (type) {
      case "hello":
        return { type, v: version(), deviceId: id(o, "deviceId"), ephPub: key32(o, "ephPub"), nonce: nonce() };
      case "welcome":
        return { type, v: version(), pcId: id(o, "pcId"), ephPub: key32(o, "ephPub"), nonce: nonce() };
      case "pair.request":
        return { type, v: version(), ephPub: key32(o, "ephPub"), box: str(o, "box", 4000, 1) };
      case "pair.accepted":
        return { type, box: str(o, "box", 4000, 1) };
      case "pair.rejected":
        return { type, reason: oneOf(o, "reason", ["expired", "declined", "used", "busy", "invalid"] as const) };
      default:
        throw new Invalid("unknown handshake type");
    }
  });
}

export function parsePairDetails(value: unknown): Parsed<PairDetails> {
  return attempt(() => {
    const o = obj(value);
    const deviceName = str(o, "deviceName", 60, 1).trim();
    if (!deviceName) throw new Invalid("deviceName is empty");
    return { deviceName, platform: oneOf(o, "platform", ["android", "ios"] as const), devicePub: key32(o, "devicePub"), approvalKey: key32(o, "approvalKey") };
  });
}

const QR_PREFIX = "nova-companion:1?";

// Every value is an id, base64url, a number or host:port, so no escaping is needed.
// (React Native's URLSearchParams is incomplete, hence by hand.)
export function encodePairingCode(code: PairingCode): string {
  return `${QR_PREFIX}pc=${code.pcId}&pk=${code.pcPub}&s=${code.secret}&h=${code.hosts.join(",")}&exp=${code.expiresAt}`;
}

export function parsePairingCode(text: string): Parsed<PairingCode> {
  return attempt(() => {
    if (!text.startsWith(QR_PREFIX) || text.length > 1000) throw new Invalid("not a NOVA pairing code");
    const params = new Map(text.slice(QR_PREFIX.length).split("&").map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)] as const));
    const o: Obj = { pc: params.get("pc"), pk: params.get("pk"), s: params.get("s"), h: params.get("h"), exp: Number(params.get("exp")) };
    const hosts = str(o, "h", 300, 1).split(",");
    if (hosts.length > 8 || !hosts.every((h) => /^[0-9A-Za-z.:[\]-]{3,60}:\d{2,5}$/.test(h))) throw new Invalid("hosts are not valid");
    return { pcId: id(o, "pc"), pcPub: key32(o, "pk"), secret: key32(o, "s"), hosts, expiresAt: int(o, "exp") };
  });
}
