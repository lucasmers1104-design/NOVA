// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isNewerVersion, parseHostInput, parseRelease, protocolKey } from "./app";
import { parsePhoneMessage } from "./parse";

const REPO = "lucasmers1104-design/NOVA";
const good = {
  version: "1.1.0",
  versionCode: 2,
  url: `https://raw.githubusercontent.com/${REPO}/main/releases/NOVA-Companion.apk`,
  sha256: "a".repeat(64),
  size: 41_000_000,
  notes: "Neu",
  published: "2026-11-09",
};

describe("phone app updates", () => {
  it("compares versions by number", () => {
    expect(isNewerVersion("1.1.0", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.10.0", "1.9.3")).toBe(true);
    expect(isNewerVersion("1.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "1.1.0")).toBe(false);
  });

  it("accepts a manifest for this repository", () => {
    expect(parseRelease(good, REPO)).toEqual(good);
  });

  it("refuses downloads from elsewhere or without a hash", () => {
    expect(parseRelease({ ...good, url: "https://evil.example/NOVA-Companion.apk" }, REPO)).toBeNull();
    expect(parseRelease({ ...good, url: `https://raw.githubusercontent.com/someone/NOVA/main/x.apk` }, REPO)).toBeNull();
    expect(parseRelease({ ...good, url: `http://raw.githubusercontent.com/${REPO}/main/x.apk` }, REPO)).toBeNull();
    expect(parseRelease({ ...good, url: `https://raw.githubusercontent.com/${REPO}/../other/x.apk` }, REPO)).toBeNull();
    expect(parseRelease({ ...good, sha256: "nope" }, REPO)).toBeNull();
    expect(parseRelease({ ...good, versionCode: 0 }, REPO)).toBeNull();
    expect(parseRelease(null, REPO)).toBeNull();
  });
});

describe("PC addresses typed by hand", () => {
  it("adds NOVA's port and keeps a given one", () => {
    expect(parseHostInput(" 192.168.178.98 ")).toBe("192.168.178.98:47621");
    expect(parseHostInput("10.0.0.5:47700")).toBe("10.0.0.5:47700");
    // USB tethering gives addresses like these.
    expect(parseHostInput("192.168.42.129")).toBe("192.168.42.129:47621");
  });

  it("only takes local network addresses", () => {
    expect(parseHostInput("8.8.8.8")).toBeNull();
    expect(parseHostInput("192.168.1.300")).toBeNull();
    expect(parseHostInput("nova.local")).toBeNull();
    expect(parseHostInput("192.168.1.2:80")).toBeNull();
  });
});

describe("notification keys", () => {
  it("become valid protocol keys", () => {
    const key = protocolKey("0|com.whatsapp|1|my tag|10123");
    expect(key).toBe("0|com.whatsapp|1|my_tag|10123");
    const message = { type: "phone.notification", id: "x", ts: 1, notifId: key, app: "com.whatsapp", appName: "WhatsApp", title: "", text: "", icon: null, posted: 1 };
    expect(parsePhoneMessage(message).ok).toBe(true);
    expect(protocolKey("")).toBe("_");
  });
});
