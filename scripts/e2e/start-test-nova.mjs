#!/usr/bin/env node
// Starts NOVA for end-to-end checks: under its own identifier, so it uses its own empty
// data folder and never touches a real installation's data, with the debug port open and
// the statistics pointed at a local worker. It builds the page into the app like a
// release does, so NOVA's real Content-Security-Policy applies; a dev server wouldn't have it.
//   node scripts/e2e/start-test-nova.mjs [plugin.novaplugin ...]

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const work = join(tmpdir(), "nova-e2e");
mkdirSync(work, { recursive: true });
const override = join(work, "tauri.e2e.json");
writeFileSync(override, JSON.stringify({ identifier: "dev.nova.e2e" }));

const built = spawnSync(`npx tauri build --debug --no-bundle --config "${override}"`, { cwd: root, stdio: "inherit", shell: true });
if (built.status !== 0) process.exit(built.status ?? 1);

const child = spawn(join(root, "src-tauri", "target", "debug", "nova.exe"), [], {
  stdio: "inherit",
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222",
    NOVA_TELEMETRY_URL: process.env.NOVA_TELEMETRY_URL ?? "http://127.0.0.1:8787",
    NOVA_DEV_PLUGINS: process.argv.slice(2).map((p) => resolve(p)).join(";"),
  },
});
child.on("exit", (code) => process.exit(code ?? 0));
