#!/usr/bin/env node
// Builds nova-phonemize (tools/nova-phonemize, GPL-3.0) and puts it where
// Tauri bundles it next to nova.exe (bundle.externalBin). Runs before
// `tauri dev`, `tauri build` and the Rust checks; skips the build when the
// helper is newer than its sources.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tool = join(root, "tools", "nova-phonemize");
const triple = "x86_64-pc-windows-msvc";
const target = join(root, "src-tauri", "binaries", `nova-phonemize-${triple}.exe`);

function newest(dir) {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "target") continue;
    const path = join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs);
  }
  return latest;
}

if (existsSync(target) && statSync(target).mtimeMs >= newest(tool)) {
  process.exit(0);
}

console.log("Building nova-phonemize …");
execFileSync("cargo", ["build", "--release"], { cwd: tool, stdio: "inherit" });
mkdirSync(dirname(target), { recursive: true });
copyFileSync(join(tool, "target", "release", "nova-phonemize.exe"), target);
// Windows keeps the original file time on copy; the check above wants "built now".
utimesSync(target, new Date(), new Date());
console.log(`nova-phonemize → ${target}`);
