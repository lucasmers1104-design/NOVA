#!/usr/bin/env node
// Builds a signed .novaplugin package from a manifest and a folder of files.
//
//   node scripts/package-plugin.mjs <manifest.json> <payload folder> --out <file.novaplugin> [--key <file>] [--unsigned]
//
// The private key never enters a repository. It is read from --key, or
// %USERPROFILE%\.nova\plugins\nova-plugins.key. --unsigned makes packages that only
// debug builds of NOVA accept. A package is a ZIP with manifest.json, payload/… and
// a signature over the sorted list of its files and their SHA-256 hashes.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const [manifestPath, payloadDir] = args;
const out = option("out");
if (!manifestPath || !payloadDir || !out) fail("usage: package-plugin.mjs <manifest.json> <payload folder> --out <file.novaplugin> [--key <file>] [--unsigned]");

function filesIn(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

const files = new Map([["manifest.json", readFileSync(manifestPath)]]);
for (const file of filesIn(payloadDir)) {
  files.set(`payload/${relative(payloadDir, file).split(sep).join("/")}`, readFileSync(file));
}

/** The signed text. NOVA rebuilds it from what it unpacks, so the order inside the ZIP doesn't matter. */
const list = [...files.keys()]
  .sort()
  .map((name) => `${createHash("sha256").update(files.get(name)).digest("hex")}  ${name}\n`)
  .join("");

function sign() {
  const keyPath = option("key") ?? join(homedir(), ".nova", "plugins", "nova-plugins.key");
  if (!existsSync(keyPath)) fail(`Signing key not found at ${keyPath}`);
  const work = mkdtempSync(join(tmpdir(), "nova-plugin-"));
  try {
    const listPath = join(work, "list.txt");
    writeFileSync(listPath, list);
    const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PATH: keyPath, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "" };
    delete env.TAURI_SIGNING_PRIVATE_KEY;
    const result = spawnSync(`npx tauri signer sign "${listPath}"`, { cwd: root, env, stdio: "pipe", shell: true, encoding: "utf8" });
    if (result.status !== 0) fail(`Signing failed: ${result.stderr || result.stdout}`);
    return readFileSync(`${listPath}.sig`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (!args.includes("--unsigned")) files.set("signature", sign());

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const shared = Buffer.alloc(26);
    shared.writeUInt16LE(20, 0); // version needed
    shared.writeUInt16LE(0x0800, 2); // UTF-8 names
    shared.writeUInt16LE(8, 4); // deflate
    shared.writeUInt32LE(0x00210000, 6); // fixed time, for reproducible packages
    shared.writeUInt32LE(crc, 10);
    shared.writeUInt32LE(compressed.length, 14);
    shared.writeUInt32LE(data.length, 18);
    shared.writeUInt16LE(nameBytes.length, 22);
    const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), shared, nameBytes, compressed]);
    const tail = Buffer.alloc(14);
    tail.writeUInt32LE(offset, 10);
    centrals.push(Buffer.concat([Buffer.from([0x50, 0x4b, 0x01, 0x02, 20, 0]), shared, tail, nameBytes]));
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

writeFileSync(out, zip([...files]));
const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
console.log(`✔ ${manifest.id} ${manifest.version} → ${out} (${files.size} files${args.includes("--unsigned") ? ", UNSIGNED" : ", signed"})`);
