// The phone's connection to NOVA on the PC: pairing over the QR code's one-time
// secret, then an encrypted session. Platform-free: the app passes its WebSocket.
//
// SECURITY: the device's static key and the approval key never leave the phone
// except the approval key once, sealed to the PC during pairing.

import { b64, fromUtf8, keyPair, open, pairingKey, phoneSessionKeys, randomBytes, seal, SecureChannel, unb64, utf8 } from "./crypto";
import type { PairDetails, PairingCode, PcMessage, PhoneMessage } from "./messages";
import { PROTOCOL_VERSION } from "./messages";
import { parseHandshake, parsePcMessage } from "./parse";

/** The part of a WebSocket the client uses; React Native's and the browser's both fit. */
export interface SocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBuffer): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;

export type FailureReason = "expired" | "declined" | "used" | "busy" | "invalid" | "unreachable" | "rejected" | "timeout";

export class CompanionError extends Error {
  constructor(readonly reason: FailureReason) {
    super(reason);
  }
}

const CONNECT_TIMEOUT_MS = 4000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** The user decides on the PC meanwhile. */
const PAIRING_TIMEOUT_MS = 150_000;

/** A socket with its incoming messages as a queue, for the handshake. */
class Pending {
  private queue: unknown[] = [];
  private waiting: ((data: unknown) => void) | null = null;
  closed = false;

  constructor(readonly socket: SocketLike) {
    socket.onmessage = (event) => {
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        resolve(event.data);
      } else {
        this.queue.push(event.data);
      }
    };
    socket.onclose = () => {
      this.closed = true;
      this.waiting?.(undefined);
    };
  }

  next(timeoutMs: number): Promise<unknown> {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(new CompanionError("rejected"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new CompanionError("timeout"));
      }, timeoutMs);
      this.waiting = (data) => {
        clearTimeout(timer);
        if (data === undefined) reject(new CompanionError("rejected"));
        else resolve(data);
      };
    });
  }
}

function openSocket(url: string, factory: SocketFactory): Promise<SocketLike> {
  return new Promise((resolve, reject) => {
    const socket = factory(url);
    socket.binaryType = "arraybuffer";
    const timer = setTimeout(() => {
      socket.close();
      reject(new CompanionError("unreachable"));
    }, CONNECT_TIMEOUT_MS);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve(socket);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new CompanionError("unreachable"));
    };
  });
}

/** The first host that answers. */
async function firstReachable(hosts: string[], factory: SocketFactory): Promise<{ socket: SocketLike; host: string }> {
  for (const host of hosts) {
    try {
      return { socket: await openSocket(`ws://${host}/`, factory), host };
    } catch {
      // Try the next address.
    }
  }
  throw new CompanionError("unreachable");
}

function json(data: unknown): unknown {
  if (typeof data !== "string") throw new CompanionError("invalid");
  try {
    return JSON.parse(data);
  } catch {
    throw new CompanionError("invalid");
  }
}

export function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export interface PairResult {
  deviceId: string;
  pcName: string;
  host: string;
  deviceSecret: Uint8Array;
  approvalKey: Uint8Array;
}

/** Pairs with the PC whose QR code was scanned. The user confirms on the PC meanwhile. */
export async function pairWithPc(code: PairingCode, deviceName: string, platform: PairDetails["platform"], factory: SocketFactory, now = Date.now()): Promise<PairResult> {
  if (now > code.expiresAt) throw new CompanionError("expired");
  const device = keyPair();
  const eph = keyPair();
  const approvalKey = randomBytes(32);
  // SECURITY: only who scanned the QR code knows `secret`, so only they can open this box.
  const key = pairingKey(eph.secret, unb64(code.pcPub), unb64(code.secret));
  const details: PairDetails = { deviceName: deviceName.trim().slice(0, 60) || "Handy", platform, devicePub: b64(device.public), approvalKey: b64(approvalKey) };
  const { socket, host } = await firstReachable(code.hosts, factory);
  const pending = new Pending(socket);
  try {
    socket.send(JSON.stringify({ type: "pair.request", v: PROTOCOL_VERSION, ephPub: b64(eph.public), box: b64(seal(key, 0, utf8(JSON.stringify(details)))) }));
    const reply = parseHandshake(json(await pending.next(PAIRING_TIMEOUT_MS)));
    if (!reply.ok) throw new CompanionError("invalid");
    if (reply.value.type === "pair.rejected") throw new CompanionError(reply.value.reason);
    if (reply.value.type !== "pair.accepted") throw new CompanionError("invalid");
    const accepted = JSON.parse(fromUtf8(open(key, 1, unb64(reply.value.box)))) as { deviceId?: unknown; pcName?: unknown };
    if (typeof accepted.deviceId !== "string") throw new CompanionError("invalid");
    return { deviceId: accepted.deviceId, pcName: typeof accepted.pcName === "string" ? accepted.pcName : "PC", host, deviceSecret: device.secret, approvalKey };
  } finally {
    socket.close();
  }
}

/** What the phone keeps about the PC it paired with. Only `deviceSecret` is secret. */
export interface Identity {
  pcId: string;
  pcPub: Uint8Array;
  deviceId: string;
  deviceSecret: Uint8Array;
}

/** An open, encrypted session with the PC. */
export class Connection {
  onMessage: (message: PcMessage) => void = () => {};
  onClose: () => void = () => {};
  private closed = false;

  private constructor(
    private readonly socket: SocketLike,
    private readonly channel: SecureChannel,
    readonly host: string,
  ) {
    socket.onmessage = (event) => this.receive(event.data);
    socket.onclose = () => this.finish();
    socket.onerror = () => this.finish();
  }

  /** Tries the hosts in order and completes the handshake with the first that answers. */
  static async open(hosts: string[], identity: Identity, factory: SocketFactory): Promise<Connection> {
    const { socket, host } = await firstReachable(hosts, factory);
    const pending = new Pending(socket);
    try {
      const eph = keyPair();
      const nonce = randomBytes(16);
      socket.send(JSON.stringify({ type: "hello", v: PROTOCOL_VERSION, deviceId: identity.deviceId, ephPub: b64(eph.public), nonce: b64(nonce) }));
      // SECURITY: an unknown or revoked device gets no welcome; the PC just closes.
      const welcome = parseHandshake(json(await pending.next(HANDSHAKE_TIMEOUT_MS)));
      if (!welcome.ok || welcome.value.type !== "welcome") throw new CompanionError("rejected");
      if (welcome.value.pcId !== identity.pcId) throw new CompanionError("rejected");
      const keys = phoneSessionKeys(identity.deviceSecret, eph.secret, identity.pcPub, unb64(welcome.value.ephPub), nonce, unb64(welcome.value.nonce), identity.deviceId);
      return new Connection(socket, new SecureChannel(keys.up, keys.down), host);
    } catch (error) {
      socket.close();
      throw error instanceof CompanionError ? error : new CompanionError("rejected");
    }
  }

  get open(): boolean {
    return !this.closed;
  }

  send(message: PhoneMessage): void {
    if (this.closed) throw new CompanionError("unreachable");
    this.socket.send(toBuffer(this.channel.frame(utf8(JSON.stringify(message)))));
  }

  close(): void {
    this.socket.close();
    this.finish();
  }

  private receive(data: unknown): void {
    const bytes = toBytes(data);
    if (!bytes) return this.close();
    let text: string;
    try {
      text = fromUtf8(this.channel.unframe(bytes));
    } catch {
      // SECURITY: a forged or replayed frame ends the session.
      return this.close();
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = parsePcMessage(value);
    if (parsed.ok) this.onMessage(parsed.value);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }
}

/** A message id: 16 random bytes, base64url. */
export function newId(): string {
  return b64(randomBytes(16));
}
