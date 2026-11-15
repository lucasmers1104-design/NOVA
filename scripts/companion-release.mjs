#!/usr/bin/env node
// Puts a built NOVA Companion APK next to NOVA's installers and writes the manifest
// the app checks for updates (releases/companion.json). Nothing is uploaded: commit
// and push releases/ yourself when you want phones to get it.
//
//   node scripts/companion-release.mjs <path/to/app.apk> [--repo owner/name] [--notes "What changed"]
//
// The version and versionCode come from mobile/app.json. Android installs an update only
// with a higher versionCode and the same signing key as the installed app (EAS keeps it).

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

const apk = args[0] && !args[0].startsWith("--") ? resolve(args[0]) : null;
if (!apk || !existsSync(apk)) fail("usage: companion-release.mjs <path/to/app.apk> [--repo owner/name] [--notes text]");
if (!apk.toLowerCase().endsWith(".apk")) fail(`${apk} isn't an APK`);

const expo = JSON.parse(readFileSync(join(root, "mobile", "app.json"), "utf8")).expo;
const version = expo.version;
const versionCode = expo.android?.versionCode;
if (!/^\d+(\.\d+){1,3}$/.test(version ?? "")) fail(`mobile/app.json has no valid version (${version})`);
if (!Number.isInteger(versionCode) || versionCode < 1) fail("mobile/app.json needs android.versionCode (a whole number, higher with every release)");

const previousPath = join(root, "releases", "companion.json");
if (existsSync(previousPath)) {
  const previous = JSON.parse(readFileSync(previousPath, "utf8"));
  if (previous.versionCode >= versionCode) fail(`versionCode ${versionCode} isn't higher than the published ${previous.versionCode}; phones would refuse the update`);
}

// The same default as NOVA's update source (src/features/updates/store.ts) and the app (mobile/src/updates.ts).
const repo = option("repo") ?? "lucasmers1104-design/NOVA";
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(`--repo must look like owner/name, not ${repo}`);

const target = join(root, "releases", "NOVA-Companion.apk");
copyFileSync(apk, target);
const bytes = readFileSync(target);
const manifest = {
  version,
  versionCode,
  url: `https://raw.githubusercontent.com/${repo}/main/releases/NOVA-Companion.apk`,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  size: statSync(target).size,
  notes: option("notes") ?? "",
  published: new Date().toISOString().slice(0, 10),
};
writeFileSync(previousPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`✔ NOVA Companion ${version} (${versionCode}), ${(manifest.size / 1024 / 1024).toFixed(1)} MB → releases/NOVA-Companion.apk + releases/companion.json`);
console.log("  Not published yet: commit and push releases/ when you want phones to see it.");
