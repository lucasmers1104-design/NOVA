// @vitest-environment node
import { describe, expect, it } from "vitest";
import fixture from "../fixtures/crypto.json";
import { approvalProof, b64, dh, keyPair, open, pairingKey, phoneSessionKeys, seal, SecureChannel, unb64, utf8 } from "./crypto";

const input = (name: keyof typeof fixture.inputs) => unb64(fixture.inputs[name]);

// The same fixture is checked by src-tauri/src/companion/crypto.rs.
describe("companion crypto", () => {
  it("derives the same keys as the PC", () => {
    const pc = keyPair(input("pcStatic"));
    const pcEph = keyPair(input("pcEph"));
    expect(b64(keyPair(input("deviceStatic")).public)).toBe(fixture.expected.devicePub);
    expect(b64(pc.public)).toBe(fixture.expected.pcPub);
    expect(b64(pairingKey(input("deviceEph"), pc.public, input("pairingSecret")))).toBe(fixture.expected.pairingKey);
    const keys = phoneSessionKeys(input("deviceStatic"), input("deviceEph"), pc.public, pcEph.public, input("phoneNonce"), input("pcNonce"), fixture.deviceId);
    expect(b64(keys.up)).toBe(fixture.expected.up);
    expect(b64(keys.down)).toBe(fixture.expected.down);
  });

  it("frames like the PC and refuses replays and forgeries", () => {
    const up = unb64(fixture.expected.up);
    const down = unb64(fixture.expected.down);
    const phone = new SecureChannel(up, down);
    expect(b64(phone.frame(utf8(fixture.plaintext)))).toBe(fixture.expected.upFrame0);

    const pc = new SecureChannel(down, up);
    const first = pc.frame(utf8("first"));
    const second = unb64(fixture.expected.downFrame1);
    expect(new TextDecoder().decode(phone.unframe(first))).toBe("first");
    expect(new TextDecoder().decode(phone.unframe(second))).toBe(fixture.plaintext);
    // The same frame again is a replay.
    expect(() => phone.unframe(second)).toThrow();

    const forged = pc.frame(utf8("third"));
    forged[forged.length - 1]! ^= 1;
    expect(() => phone.unframe(forged)).toThrow();
  });

  it("seals the pairing box and the approval proof like the PC", () => {
    const key = unb64(fixture.expected.pairingKey);
    expect(b64(seal(key, 0, utf8(fixture.plaintext)))).toBe(fixture.expected.pairingBox);
    expect(() => open(key, 1, unb64(fixture.expected.pairingBox))).toThrow();
    expect(approvalProof(input("approvalKey"), fixture.requestId, fixture.expiresAt)).toBe(fixture.expected.approvalProof);
    expect(approvalProof(input("approvalKey"), fixture.requestId, fixture.expiresAt + 1)).not.toBe(fixture.expected.approvalProof);
  });

  it("refuses an all-zero public key", () => {
    expect(() => dh(input("deviceStatic"), new Uint8Array(32))).toThrow();
  });

  it("encodes base64url like Node", () => {
    for (const length of [0, 1, 2, 3, 31, 32, 33]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) & 255);
      expect(b64(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
      expect(unb64(b64(bytes))).toEqual(bytes);
    }
  });
});
