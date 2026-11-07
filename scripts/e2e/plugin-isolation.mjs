#!/usr/bin/env node
// Checks in a running NOVA that a malicious plugin stays in its sandbox. Package and start it:
//   node scripts/package-plugin.mjs scripts/e2e/hostile-plugin/manifest.json scripts/e2e/hostile-plugin/payload --out hostile.novaplugin --unsigned
//   node scripts/e2e/start-test-nova.mjs hostile.novaplugin
// then:
//   node scripts/e2e/plugin-isolation.mjs
// Exits non-zero if anything got out.

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";

const cdp = resolve(import.meta.dirname, "..", "cdp.mjs");
const PLUGIN = "dev.nova.e2e-hostile";
const MAIN = process.env.NOVA_E2E_URL ?? "http://tauri.localhost/";
const run = promisify(execFile);
const evaluate = async (expression) => JSON.parse((await run("node", [cdp, "eval", MAIN + "$", expression], { encoding: "utf8" })).stdout);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const invoke = (command, args) => `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`;
const stored = async (key) => {
  const value = await evaluate(invoke("plugin_call", { pluginId: PLUGIN, method: "storage.get", params: { key } }));
  return value === null ? null : JSON.parse(value);
};
const clickNav = (label) => evaluate(`(() => { const b = document.querySelector('button[aria-label=${JSON.stringify(label)}]'); if (!b) return false; b.click(); return true; })()`);

// The plugin aims everything that leaves at this address. It must never hear from it.
const hits = [];
const sink = createServer((request, response) => {
  hits.push(request.url);
  response.end("reached");
});
sink.on("upgrade", (request, socket) => {
  hits.push(request.url);
  socket.destroy();
});
await new Promise((done) => sink.listen(8799, "127.0.0.1", done));

async function waitFor(label, check, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`Timed out: ${label}`);
}

const problems = [];
const csp = await evaluate("fetch('http://127.0.0.1:8799/from-nova-page').then(() => 'NOT enforced', () => 'enforced')");
console.log(`NOVA's own Content-Security-Policy in this build: ${csp}`);
if (csp !== "enforced") problems.push("this build doesn't apply NOVA's CSP, so the result says little: use start-test-nova.mjs");
hits.length = 0;

// A plugin's storage outlives a restart: an old report must not pass for this run.
for (const key of ["report", "done", "survived top navigation", "survived self navigation", "hang over"]) {
  await evaluate(invoke("plugin_call", { pluginId: PLUGIN, method: "storage.delete", params: { key } }));
}

await waitFor("the hostile plugin in the sidebar", () => clickNav("Hostile attack"));
console.log("Attack page opened; waiting for its report…");
const report = await waitFor("the report", () => stored("report"), 120000);
console.log(JSON.stringify(report, null, 2));

const mustFail = ["fetch ipc.localhost", "fetch internet", "fetch own files", "websocket", "image to internet", "parent DOM", "top DOM", "localStorage", "cookies", "indexedDB", "window.open", "eval", "inline script", "remote script", "unknown broker method", "broker without permission", "broker network", "broker analytics"];
for (const name of mustFail) {
  if (!String(report[name]).startsWith("blocked")) problems.push(`${name}: ${report[name]}`);
}

// These objects exist in every frame on Windows (wry injects them there). What counts is
// that no command answers and none leaves a mark, checked from the outside below.
for (const name of ["invoke settings_set", "invoke settings_get", "invoke ai_key_status", "invoke files_recent"]) {
  const value = String(report[name]);
  if (value.startsWith("reached") && value !== "reached: no answer") problems.push(`${name} ANSWERED: ${value}`);
}

await sleep(2000);
for (const key of ["nova.hostile-invoke", "nova.hostile-ipc", "nova.hostile-webview", "nova.hostile-fetch"]) {
  const value = await evaluate(invoke("settings_get", { key }));
  console.log(`setting ${key}: ${value}`);
  if (value !== null) problems.push(`the plugin wrote the setting ${key}`);
}

console.log("Trying to navigate away…");
await waitFor("the plugin surviving top navigation", () => stored("survived top navigation"), 20000);
const stillNova = await evaluate("location.href");
console.log(`top window: ${stillNova}`);
if (stillNova !== MAIN) problems.push(`the plugin moved NOVA's window to ${stillNova}`);
await sleep(5000);
if (report["sub frame"] !== "reached: tried") problems.push(`this isn't the current test plugin: ${report["sub frame"]}`);

console.log("Hang test: is NOVA's window still responsive while a plugin loops for 8 seconds?");
if (!(await clickNav("Hostile hang"))) problems.push("no hang page in the sidebar");
await sleep(1500);
const worst = await evaluate("new Promise((done) => { let worst = 0, last = performance.now(), n = 0; const t = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; if (++n > 40) { clearInterval(t); done(Math.round(worst)); } }, 100); })");
console.log(`longest stall of NOVA's own window during the loop: ${worst} ms`);
if (worst > 2000) problems.push(`NOVA's window froze for ${worst} ms while a plugin looped`);

console.log(`requests that reached the outside: ${hits.length ? hits.join(", ") : "none"}`);
for (const hit of hits) problems.push(`the plugin reached the network: ${hit}`);

if (problems.length) {
  console.error("\n✖ NOT ISOLATED:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log("\n✔ The plugin stayed in its sandbox.");
process.exit(0);
