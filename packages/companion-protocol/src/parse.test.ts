// @vitest-environment node
import { describe, expect, it } from "vitest";
import handshakeInvalid from "../fixtures/handshake-invalid.json";
import handshakeValid from "../fixtures/handshake-valid.json";
import pcInvalid from "../fixtures/pc-invalid.json";
import pcValid from "../fixtures/pc-valid.json";
import phoneInvalid from "../fixtures/phone-invalid.json";
import phoneValid from "../fixtures/phone-valid.json";
import { encodePairingCode, parseHandshake, parsePairDetails, parsePairingCode, parsePcMessage, parsePhoneMessage } from "./parse";

// The same fixtures are parsed by src-tauri/src/companion/protocol.rs.
describe("companion protocol fixtures", () => {
  it.each(phoneValid.map((m) => [m.type, m] as const))("accepts phone message %s", (_, message) => {
    const parsed = parsePhoneMessage(message);
    expect(parsed).toEqual({ ok: true, value: message });
  });

  it.each(phoneInvalid.map((m, i) => [i, m] as const))("refuses phone message #%i", (_, message) => {
    expect(parsePhoneMessage(message).ok).toBe(false);
  });

  it.each(pcValid.map((m) => [m.id, m] as const))("accepts PC message %s", (_, message) => {
    expect(parsePcMessage(message)).toEqual({ ok: true, value: message });
  });

  it.each(pcInvalid.map((m, i) => [i, m] as const))("refuses PC message #%i", (_, message) => {
    expect(parsePcMessage(message).ok).toBe(false);
  });

  it.each(handshakeValid.map((m) => [m.type, m] as const))("accepts handshake %s", (_, message) => {
    expect(parseHandshake(message)).toEqual({ ok: true, value: message });
  });

  it.each(handshakeInvalid.map((m, i) => [i, m] as const))("refuses handshake #%i", (_, message) => {
    expect(parseHandshake(message).ok).toBe(false);
  });
});

describe("pairing", () => {
  const key = "A".repeat(43);

  it("round-trips the QR code", () => {
    const code = { pcId: "pc-1", pcPub: key, secret: key, hosts: ["192.168.1.20:47621", "[fe80::1]:47621"], expiresAt: 1762600120000 };
    expect(parsePairingCode(encodePairingCode(code))).toEqual({ ok: true, value: code });
  });

  it("refuses other QR codes", () => {
    expect(parsePairingCode("https://example.com").ok).toBe(false);
    expect(parsePairingCode(`nova-companion:1?pc=pc-1&pk=${key}&s=short&h=1.2.3.4:1&exp=1`).ok).toBe(false);
    expect(parsePairingCode(`nova-companion:1?pc=pc-1&pk=${key}&s=${key}&h=evil host:1&exp=1`).ok).toBe(false);
  });

  it("checks the pairing details", () => {
    expect(parsePairDetails({ deviceName: " Pixel 9 ", platform: "android", devicePub: key, approvalKey: key })).toEqual({
      ok: true,
      value: { deviceName: "Pixel 9", platform: "android", devicePub: key, approvalKey: key },
    });
    expect(parsePairDetails({ deviceName: "  ", platform: "android", devicePub: key, approvalKey: key }).ok).toBe(false);
    expect(parsePairDetails({ deviceName: "x", platform: "windows", devicePub: key, approvalKey: key }).ok).toBe(false);
  });
});
