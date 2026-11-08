// Writes fixtures/crypto.json: fixed keys in, expected bytes out. Run once with
// `node scripts/make-crypto-fixture.mjs`; both crypto.test.ts and crypto.rs check
// their own implementation against it, so the two can never drift apart silently.
import { writeFileSync } from "node:fs";
import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

const fill = (n, length) => new Uint8Array(length).fill(n);
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const utf8 = (text) => new TextEncoder().encode(text);
const concat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));
const nonce = (counter) => {
  const n = new Uint8Array(12);
  new DataView(n.buffer).setBigUint64(4, BigInt(counter));
  return n;
};
const header = (counter) => {
  const h = new Uint8Array(8);
  new DataView(h.buffer).setBigUint64(0, BigInt(counter));
  return h;
};

const inputs = {
  deviceStatic: fill(1, 32),
  deviceEph: fill(2, 32),
  pcStatic: fill(3, 32),
  pcEph: fill(4, 32),
  phoneNonce: fill(5, 16),
  pcNonce: fill(6, 16),
  pairingSecret: fill(7, 32),
  approvalKey: fill(8, 32),
};
const deviceId = "dev-1";
const requestId = "r-1";
const expiresAt = 1762600120000;
const plaintext = '{"type":"status.get","id":"s-1","ts":1}';

const pub = (s) => x25519.getPublicKey(s);
const dh = (s, p) => x25519.getSharedSecret(s, p);
const pcPub = pub(inputs.pcStatic);
const pcEphPub = pub(inputs.pcEph);
const pairing = hkdf(sha256, dh(inputs.deviceEph, pcPub), inputs.pairingSecret, utf8("nova-companion v1 pair"), 32);
const ikm = concat(dh(inputs.deviceStatic, pcPub), dh(inputs.deviceEph, pcEphPub), dh(inputs.deviceStatic, pcEphPub), dh(inputs.deviceEph, pcPub));
const okm = hkdf(sha256, ikm, concat(inputs.phoneNonce, inputs.pcNonce), utf8(`nova-companion v1 session ${deviceId}`), 64);
const up = okm.slice(0, 32);
const down = okm.slice(32);

const fixture = {
  inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, b64(v)])),
  deviceId,
  requestId,
  expiresAt,
  plaintext,
  expected: {
    devicePub: b64(pub(inputs.deviceStatic)),
    deviceEphPub: b64(pub(inputs.deviceEph)),
    pcPub: b64(pcPub),
    pcEphPub: b64(pcEphPub),
    pairingKey: b64(pairing),
    pairingBox: b64(gcm(pairing, nonce(0)).encrypt(utf8(plaintext))),
    up: b64(up),
    down: b64(down),
    upFrame0: b64(concat(header(0), gcm(up, nonce(0)).encrypt(utf8(plaintext)))),
    downFrame1: b64(concat(header(1), gcm(down, nonce(1)).encrypt(utf8(plaintext)))),
    approvalProof: b64(hmac(sha256, inputs.approvalKey, utf8(`${requestId}|approve|${expiresAt}`))),
  },
};
writeFileSync(new URL("../fixtures/crypto.json", import.meta.url), JSON.stringify(fixture, null, 2) + "\n");
console.log("fixtures/crypto.json written");
