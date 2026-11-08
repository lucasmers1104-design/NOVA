#!/usr/bin/env node
// Builds a signed NOVA installer and publishes it into releases/ together with
// the latest.json manifest the in-app updater reads.
//
//   npm run release -- --repo owner/name [--notes "What changed"] [--skip-build]
//
// Options:
//   --repo owner/name   Public GitHub repository the app updates from. Defaults to
//                       the "origin" remote. Download URLs point at raw files on main.
//   --base-url URL      Use this base URL for downloads instead (e.g. a local test server).
//   --out DIR           Output folder (default: releases).
//   --notes TEXT        Release notes; defaults to this version's CHANGELOG section.
//   --skip-build        Reuse the installer from the last build.
//   --local-test        Build a test variant that accepts http://localhost update servers.
//   --installer-only    Build and copy the signed installer without writing latest.json
//                       (e.g. before the GitHub repository exists).
//
// The private signing key never enters the repository. It is read from
// TAURI_SIGNING_PRIVATE_KEY_PATH, or %USERPROFILE%\.nova\updater\nova-updater.key.

import { execSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

// This repository is public and every push reaches every installation: stop before a
// private plugin, its dashboard or a signing key can go along.
function refuseWhatMustStayPrivate() {
  const listed = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout?.split("\n").filter(Boolean) ?? [];
  const files = [...listed(["ls-files"]), ...listed(["ls-files", "--others", "--exclude-standard"])];
  // Plugins NOVA offers publicly (Plugins → Available) are listed in releases/plugins/catalog.json;
  // any other package, and anything named like the private plugin, stays out.
  const catalog = (() => {
    try {
      return JSON.parse(readFileSync(join(root, "releases", "plugins", "catalog.json"), "utf8")).plugins.map((p) => `releases/plugins/${p.file}`);
    } catch {
      return [];
    }
  })();
  const published = (file) => catalog.includes(file) && !/developer-analytics/i.test(file);
  const secret = files.filter((file) => (/\.(novaplugin|key)$/i.test(file) && !published(file)) || /(^|\/)(nova-private|developer-analytics)(\/|$)/i.test(file));
  if (secret.length > 0) fail(`These must not be in the public repository:\n  ${secret.join("\n  ")}`);
}
refuseWhatMustStayPrivate();

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const installerName = `NOVA_${version}_x64-setup.exe`;
const bundleDir = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const outDir = resolve(root, option("out") ?? "releases");

/** "owner/name" from --repo or the GitHub "origin" remote. */
function resolveRepo() {
  const explicit = option("repo");
  if (explicit) return explicit.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  try {
    const remote = execSync("git remote get-url origin", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
    if (match) return `${match[1]}/${match[2]}`;
  } catch {
    // No remote configured.
  }
  return null;
}

function releaseNotes() {
  const notes = option("notes");
  if (notes) return notes;
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const section = changelog.split(/^## /m).find((s) => s.startsWith(`${version} `) || s.startsWith(`${version}\n`));
  if (!section) return `NOVA ${version}`;
  return section
    .split("\n")
    .slice(1)
    .filter((line) => line.startsWith("- "))
    .map((line) => line.replace(/\*\*/g, ""))
    .join("\n");
}

const installerOnly = flag("installer-only");
const baseUrl = installerOnly ? null : option("base-url")?.replace(/\/$/, "") ?? (() => {
  const repo = resolveRepo();
  if (!repo) fail("No GitHub repository known. Pass --repo owner/name (or add a GitHub 'origin' remote).");
  return `https://raw.githubusercontent.com/${repo}/main/releases`;
})();

if (!flag("skip-build")) {
  const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH ?? join(homedir(), ".nova", "updater", "nova-updater.key");
  if (!existsSync(keyPath)) fail(`Signing key not found at ${keyPath}. Generate one with: npx tauri signer generate -w "${keyPath}"`);
  const env = {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, "utf8").trim(),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
  };
  const buildArgs = ["tauri", "build"];
  if (flag("local-test")) {
    // Test builds only: allow plain-http update servers on localhost. Passed as a
    // file because the Windows shell would strip the quotes from inline JSON.
    const overrideFile = join(tmpdir(), "nova-local-test.conf.json");
    writeFileSync(overrideFile, JSON.stringify({ plugins: { updater: { dangerousInsecureTransportProtocol: true } } }));
    buildArgs.push("--config", `"${overrideFile}"`);
  }
  console.log(`\n▶ Building NOVA ${version}${flag("local-test") ? " (local test variant)" : ""}…\n`);
  // One command string: npx is a .cmd shim on Windows and needs the shell.
  const result = spawnSync(["npx", ...buildArgs].join(" "), { cwd: root, env, stdio: "inherit", shell: true });
  if (result.status !== 0) fail("Build failed.");
}

const installer = join(bundleDir, installerName);
const signature = `${installer}.sig`;
if (!existsSync(installer) || !existsSync(signature)) fail(`Missing ${installerName} or its .sig in ${bundleDir}. Build with signing first.`);

mkdirSync(outDir, { recursive: true });
copyFileSync(installer, join(outDir, installerName));
copyFileSync(signature, join(outDir, `${installerName}.sig`));
if (installerOnly) {
  console.log(`\n✔ NOVA ${version} installer copied to ${outDir}`);
  console.log("  latest.json was not written. Once the repository exists: npm run release -- --repo owner/name --skip-build\n");
  process.exit(0);
}

const manifest = {
  version,
  notes: releaseNotes(),
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(signature, "utf8").trim(),
      url: `${baseUrl}/${installerName}`,
    },
  },
};
writeFileSync(join(outDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`\n✔ NOVA ${version} published to ${outDir}`);
console.log(`  ${installerName}`);
console.log(`  latest.json → ${manifest.platforms["windows-x86_64"].url}\n`);
