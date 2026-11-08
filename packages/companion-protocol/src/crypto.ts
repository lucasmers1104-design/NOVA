// End-to-end encryption between phone and PC, the same construction as
// src-tauri/src/companion/crypto.rs (checked against fixtures/crypto.json on both sides).
//
// SECURITY: X25519 keys, HKDF-SHA256, AES-256-GCM with a counter nonce per direction.
// The session mixes static and ephemeral keys like Noise KK, so a stolen long-term
// key doesn't open recorded traffic. Change nothing here without changing Rust too.

import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

const encoder = new TextEncoder();
// Hermes on older React Native has no TextDecoder; the fallback below reads strict UTF-8.
const decoder = typeof TextDecoder === "undefined" ? null : new TextDecoder("utf-8", { fatal: true });

export const utf8 = (text: string) => encoder.encode(text);

export function fromUtf8(bytes: Uint8Array): string {
  return decoder ? decoder.decode(bytes) : decodeUtf8(bytes);
}

export function decodeUtf8(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    const extra = b < 0x80 ? 0 : b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : b >= 0xc0 ? 1 : -1;
    if (extra < 0 || (extra > 0 && i + extra >= bytes.length)) throw new Error("not UTF-8");
    let code = extra === 0 ? b : b & (0x3f >> extra);
    for (let j = 1; j <= extra; j++) {
      const next = bytes[i + j]!;
      if ((next & 0xc0) !== 0x80) throw new Error("not UTF-8");
      code = (code << 6) | (next & 0x3f);
    }
    out += String.fromCodePoint(code);
    i += extra + 1;
  }
  return out;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Unpadded base64url; written out because React Native has no Buffer and no btoa for bytes. */
export function b64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let c = 0; c < chars; c++) out += ALPHABET[(n >> (18 - 6 * c)) & 63];
  }
  return out;
}

export function unb64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of clean) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new Error("not base64");
    value = (value << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 255;
    }
  }
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  // On the phone, expo-crypto installs getRandomValues before this runs.
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export interface KeyPair {
  secret: Uint8Array;
  public: Uint8Array;
}

export function keyPair(secret = randomBytes(32)): KeyPair {
  return { secret, public: x25519.getPublicKey(secret) };
}

/** X25519; refuses an all-zero result (a low-order public key from an attacker). */
export function dh(secret: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(secret, publicKey);
  if (shared.every((b) => b === 0)) throw new Error("bad public key");
  return shared;
}

export function nonceFor(counter: number): Uint8Array {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(counter));
  return nonce;
}

export function seal(key: Uint8Array, counter: number, plaintext: Uint8Array): Uint8Array {
  return gcm(key, nonceFor(counter)).encrypt(plaintext);
}

export function open(key: Uint8Array, counter: number, ciphertext: Uint8Array): Uint8Array {
  return gcm(key, nonceFor(counter)).decrypt(ciphertext);
}

/** The key for the one-time pairing box: only who scanned the QR code knows `secret`. */
export function pairingKey(phoneEph: Uint8Array, pcPub: Uint8Array, secret: Uint8Array): Uint8Array {
  return hkdf(sha256, dh(phoneEph, pcPub), secret, utf8("nova-companion v1 pair"), 32);
}

export interface SessionKeys {
  /** Phone → PC. */
  up: Uint8Array;
  /** PC → phone. */
  down: Uint8Array;
}

/** The phone's side of the session handshake. */
export function phoneSessionKeys(
  deviceStatic: Uint8Array,
  deviceEph: Uint8Array,
  pcPub: Uint8Array,
  pcEphPub: Uint8Array,
  phoneNonce: Uint8Array,
  pcNonce: Uint8Array,
  deviceId: string,
): SessionKeys {
  const ikm = concat(dh(deviceStatic, pcPub), dh(deviceEph, pcEphPub), dh(deviceStatic, pcEphPub), dh(deviceEph, pcPub));
  const okm = hkdf(sha256, ikm, concat(phoneNonce, pcNonce), utf8(`nova-companion v1 session ${deviceId}`), 64);
  return { up: okm.slice(0, 32), down: okm.slice(32) };
}

/** SECURITY: the proof that the biometric-locked approval key approved this request. */
export function approvalProof(approvalKey: Uint8Array, requestId: string, expiresAt: number): string {
  return b64(hmac(sha256, approvalKey, utf8(`${requestId}|approve|${expiresAt}`)));
}

/**
 * One direction-pair of an encrypted connection. Frames are an 8-byte big-endian
 * counter followed by the AES-GCM ciphertext; counters must arrive in order.
 */
export class SecureChannel {
  private sent = 0;
  private received = 0;

  constructor(
    private readonly sendKey: Uint8Array,
    private readonly receiveKey: Uint8Array,
  ) {}

  frame(plaintext: Uint8Array): Uint8Array {
    const counter = this.sent++;
    const header = new Uint8Array(8);
    new DataView(header.buffer).setBigUint64(0, BigInt(counter));
    return concat(header, seal(this.sendKey, counter, plaintext));
  }

  /** SECURITY: a replayed, reordered or forged frame throws; the caller closes the connection. */
  unframe(frame: Uint8Array): Uint8Array {
    if (frame.length < 8 + 16) throw new Error("frame too short");
    const counter = Number(new DataView(frame.buffer, frame.byteOffset, 8).getBigUint64(0));
    if (counter !== this.received) throw new Error("frame out of order");
    const plaintext = open(this.receiveKey, counter, frame.subarray(8));
    this.received++;
    return plaintext;
  }
}
