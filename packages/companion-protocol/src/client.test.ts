// @vitest-environment node
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { Connection, pairWithPc, type SocketLike } from "./client";
import { b64, concat, decodeUtf8, dh, fromUtf8, keyPair, open, pairingKey, randomBytes, seal, SecureChannel, unb64, utf8 } from "./crypto";
import type { PcMessage } from "./messages";

/** A socket whose other end is a scripted PC. */
class FakeSocket implements SocketLike {
  binaryType = "blob";
  readyState = 1;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  closed = false;
  constructor(private readonly pc: (data: string | ArrayBuffer, socket: FakeSocket) => void) {
    setTimeout(() => this.onopen?.({}), 0);
  }
  send(data: string | ArrayBuffer) {
    this.pc(data, this);
  }
  deliver(data: string | ArrayBuffer) {
    setTimeout(() => this.onmessage?.({ data }), 0);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    setTimeout(() => this.onclose?.({}), 0);
  }
}

const pc = keyPair();
const secret = randomBytes(32);
const code = { pcId: "pc-1", pcPub: b64(pc.public), secret: b64(secret), hosts: ["10.0.0.2:47621"], expiresAt: Date.now() + 60_000 };

describe("pairing", () => {
  it("sends its keys sealed to the PC and gets its device id", async () => {
    let approvalKey = "";
    const factory = () =>
      new FakeSocket((data, socket) => {
        const request = JSON.parse(data as string);
        expect(request.type).toBe("pair.request");
        const key = pairingKey(pc.secret, unb64(request.ephPub), secret);
        const details = JSON.parse(fromUtf8(open(key, 0, unb64(request.box))));
        expect(details).toMatchObject({ deviceName: "Pixel 9", platform: "android" });
        approvalKey = details.approvalKey;
        socket.deliver(JSON.stringify({ type: "pair.accepted", box: b64(seal(key, 1, utf8(JSON.stringify({ deviceId: "dev-1", pcName: "GAMING-PC" })))) }));
      });
    const result = await pairWithPc(code, " Pixel 9 ", "android", factory);
    expect(result).toMatchObject({ deviceId: "dev-1", pcName: "GAMING-PC", host: "10.0.0.2:47621" });
    expect(b64(result.approvalKey)).toBe(approvalKey);
  });

  it("reports why the PC said no", async () => {
    const factory = () => new FakeSocket((_, socket) => socket.deliver(JSON.stringify({ type: "pair.rejected", reason: "declined" })));
    await expect(pairWithPc(code, "x", "android", factory)).rejects.toMatchObject({ reason: "declined" });
  });

  it("doesn't try an expired code", async () => {
    await expect(pairWithPc({ ...code, expiresAt: 1 }, "x", "android", () => new FakeSocket(() => {}))).rejects.toMatchObject({ reason: "expired" });
  });
});

describe("session", () => {
  const device = keyPair();
  const identity = { pcId: "pc-1", pcPub: pc.public, deviceId: "dev-1", deviceSecret: device.secret };

  /** The PC's side of the handshake, written out from the spec (not from client.ts). */
  function scriptedPc(onReady: (socket: FakeSocket, channel: SecureChannel) => void, pcId = "pc-1") {
    let channel: SecureChannel | null = null;
    return () =>
      new FakeSocket((data, socket) => {
        if (typeof data === "string") {
          const hello = JSON.parse(data);
          const eph = keyPair();
          const nonce = randomBytes(16);
          const ikm = concat(dh(pc.secret, device.public), dh(eph.secret, unb64(hello.ephPub)), dh(eph.secret, device.public), dh(pc.secret, unb64(hello.ephPub)));
          const okm = hkdf(sha256, ikm, concat(unb64(hello.nonce), nonce), utf8(`nova-companion v1 session ${hello.deviceId}`), 64);
          channel = new SecureChannel(okm.slice(32), okm.slice(0, 32));
          socket.deliver(JSON.stringify({ type: "welcome", v: 1, pcId, ephPub: b64(eph.public), nonce: b64(nonce) }));
          onReady(socket, channel);
        } else {
          const message = JSON.parse(fromUtf8(channel!.unframe(new Uint8Array(data))));
          if (message.type === "status.get") {
            const status: PcMessage = { type: "status", id: "s", ts: 1, pcName: "PC", busy: false, aiReady: true, inGame: false, media: null, pendingApprovals: 0, activeTasks: 0 };
            const frame = channel!.frame(utf8(JSON.stringify(status)));
            socket.deliver(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer);
          }
        }
      });
  }

  it("talks encrypted after the handshake", async () => {
    const connection = await Connection.open(["10.0.0.2:47621"], identity, scriptedPc(() => {}));
    const reply = new Promise<PcMessage>((resolve) => (connection.onMessage = resolve));
    connection.send({ type: "status.get", id: "s1", ts: 1 });
    expect((await reply).type).toBe("status");
  });

  it("refuses a PC that isn't the paired one", async () => {
    await expect(Connection.open(["10.0.0.2:47621"], identity, scriptedPc(() => {}, "someone-else"))).rejects.toMatchObject({ reason: "rejected" });
  });

  it("closes on a forged frame", async () => {
    let pcSocket: FakeSocket | null = null;
    const connection = await Connection.open(["10.0.0.2:47621"], identity, scriptedPc((socket) => (pcSocket = socket)));
    const closed = new Promise<void>((resolve) => (connection.onClose = resolve));
    pcSocket!.deliver(new Uint8Array(40).buffer);
    await closed;
    expect(connection.open).toBe(false);
  });
});

describe("utf-8 fallback for Hermes", () => {
  it("decodes like Node and refuses broken input", () => {
    for (const text of ["", "Öffne Fortnite", "Grüße 👋 aus München", "日本"]) {
      expect(decodeUtf8(new Uint8Array(Buffer.from(text)))).toBe(text);
    }
    expect(() => decodeUtf8(Uint8Array.from([0xc3]))).toThrow();
    expect(() => decodeUtf8(Uint8Array.from([0xe2, 0x28, 0xa1]))).toThrow();
    expect(() => decodeUtf8(Uint8Array.from([0x80]))).toThrow();
  });
});
