#!/usr/bin/env node
// The developer key: entered under Settings → Entwickler, it lifts NOVA's limits for its owner
// (only Claude Haiku without it, and the Discord cooldowns on the relay).
//
//   node scripts/dev-key.mjs
//
// Makes the key once at %USERPROFILE%\.nova\dev-key.txt (never in a repository) and prints only
// its SHA-256, which goes into src-tauri/src/devkey.rs and the relay's DEV_KEY_SHA256. The hash
// can be public; the key can't be worked out from it.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const file = join(homedir(), ".nova", "dev-key.txt");
if (!existsSync(file)) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `novadev_${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
  console.log(`New developer key written to ${file}`);
} else {
  console.log(`Developer key already at ${file}`);
}
const key = readFileSync(file, "utf8").trim();
console.log(`SHA-256: ${createHash("sha256").update(key).digest("hex")}`);
