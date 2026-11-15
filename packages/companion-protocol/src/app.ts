// The phone app's own small rules, here so they are tested with the rest (app.test.ts):
// its update manifest on GitHub, PC addresses typed by hand, notification keys.

/** releases/companion.json, written by scripts/companion-release.mjs. */
export interface AppRelease {
  version: string;
  /** Android's versionCode; an update must have a higher one. */
  versionCode: number;
  url: string;
  sha256: string;
  size: number;
  notes: string;
  published: string;
}

/** The port NOVA listens on unless it had to pick another. */
export const DEFAULT_PORT = 47621;

/** "1.10.0" > "1.9.3": numeric parts, missing ones count as 0. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parts = (v: string) => v.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const [a, b] = [parts(candidate), parts(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/**
 * Checks a downloaded manifest. SECURITY: the APK may only come from the same GitHub
 * repository as the manifest, over HTTPS, with a SHA-256 to check it against. Android
 * additionally refuses an update signed with a different key than the installed app.
 */
export function parseRelease(value: unknown, repository: string): AppRelease | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  const { version, versionCode, url, sha256, size } = o;
  if (typeof version !== "string" || !/^\d{1,4}(\.\d{1,4}){1,3}$/.test(version)) return null;
  if (typeof versionCode !== "number" || !Number.isInteger(versionCode) || versionCode < 1) return null;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > 300 * 1024 * 1024) return null;
  if (typeof url !== "string") return null;
  const allowed = [`https://raw.githubusercontent.com/${repository}/`, `https://github.com/${repository}/`];
  if (!allowed.some((start) => url.startsWith(start)) || url.includes("..") || !url.endsWith(".apk")) return null;
  const text = (key: string, most: number) => (typeof o[key] === "string" ? (o[key] as string).slice(0, most) : "");
  return { version, versionCode, url, sha256, size, notes: text("notes", 2000), published: text("published", 40) };
}

/**
 * A PC address typed by hand: "192.168.178.98" or "192.168.178.98:47621".
 * SECURITY: only private, link-local or loopback IPv4 addresses, like the PC accepts.
 */
export function parseHostInput(text: string): string | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d{2,5}))?$/.exec(text.trim());
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return null;
  const [a = 0, b = 0] = octets;
  const local = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 127;
  if (!local) return null;
  const port = match[5] ? Number(match[5]) : DEFAULT_PORT;
  if (port < 1024 || port > 65535) return null;
  return `${octets.join(".")}:${port}`;
}

/** Android's notification key as the protocol carries it: printable, no spaces, at most 200 characters. */
export function protocolKey(key: string): string {
  const cleaned = key.replace(/[^\x21-\x7e]/g, "_").slice(0, 200);
  return cleaned || "_";
}
