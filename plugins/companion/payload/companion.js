// NOVA Companion's page. Everything goes through plugin_call with the "companion"
// permission; Rust checks that this plugin is signed by NOVA. Pairing itself is
// confirmed in NOVA's own window, never here. Text from phones (device names, tasks)
// only ever goes into textContent.

const pending = new Map();
let nextId = 1;

addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.nova !== 1) return;
  const { id, result, error, event: name, data } = event.data;
  if (name === "ping") parent.postMessage({ nova: 1, pong: 1 }, "*");
  if (name === "theme") {
    document.documentElement.style.setProperty("--accent", data.accent);
    document.documentElement.style.setProperty("--accent-text", data.accentText);
    document.documentElement.style.setProperty("--on-accent", data.onAccent);
  }
  if (pending.has(id)) {
    const { resolve, reject } = pending.get(id);
    pending.delete(id);
    error ? reject(new Error(error)) : resolve(result);
  }
});

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    parent.postMessage({ nova: 1, id, method, params }, "*");
  });
}

const $ = (id) => document.getElementById(id);
const svgUrl = (svg) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showError(error) {
  $("error").textContent = error instanceof Error ? error.message : String(error);
  $("error").hidden = false;
}

let status = null;
let candidates = [];
let pairing = null;
let removing = null;

function seen(device) {
  if (device.connected) return "Connected";
  if (device.lastSeen === null) return "Never connected";
  const minutes = Math.round((Date.now() - device.lastSeen) / 60000);
  if (minutes < 1) return "Seen just now";
  if (minutes < 60) return `Seen ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `Seen ${hours} h ago` : `Seen ${Math.round(hours / 24)} days ago`;
}

function render() {
  if (!status) return;
  $("enabled").checked = status.enabled;
  $("keep").checked = status.keepScreenshots;
  $("link-text").textContent = !status.enabled
    ? "Off. When you turn it on, Windows may ask once whether NOVA may use private networks: allow it there, not on public networks."
    : status.listening
      ? `Paired phones on your network reach this PC at ${status.addresses.join(", ") || "no network address yet"} (port ${status.port}).`
      : "Not reachable right now.";
  $("error").hidden = !status.error;
  $("error").textContent = status.error ?? "";
  $("pair").disabled = !(status.enabled && status.listening);

  const devices = $("devices");
  devices.replaceChildren();
  for (const device of status.devices) {
    const item = el("li", "item");
    const text = el("div");
    text.append(el("p", "", device.name));
    const meta = el("p", "muted small", ` · ${device.platform === "ios" ? "iPhone" : "Android"} · paired ${new Date(device.pairedAt).toLocaleDateString()}`);
    meta.prepend(el("span", device.connected ? "ok" : "", seen(device)));
    text.append(meta);
    const remove = el("button", "ghost", removing === device.id ? "Really remove?" : "Remove");
    remove.type = "button";
    remove.onclick = async () => {
      if (removing !== device.id) {
        removing = device.id;
        return render();
      }
      removing = null;
      try {
        status = await call("companion.revoke", { deviceId: device.id });
        render();
      } catch (error) {
        showError(error);
      }
    };
    item.append(text, remove);
    devices.append(item);
  }
  $("no-devices").hidden = status.devices.length > 0;

  const chips = $("allowlist");
  chips.replaceChildren();
  for (const entry of status.allowlist) {
    const chip = el("li", "chip", entry.name);
    const x = el("button", "x", "×");
    x.type = "button";
    x.setAttribute("aria-label", `Remove ${entry.name}`);
    x.onclick = () => saveAllowlist(status.allowlist.filter((a) => !(a.kind === entry.kind && a.id === entry.id)));
    chip.append(x);
    chips.append(chip);
  }

  // Paired or declined: the code was used.
  if (pairing && (Date.now() > pairing.expiresAt || pairing.devices !== status.devices.length)) stopPairing();
}

async function refresh() {
  try {
    status = await call("companion.status");
    render();
  } catch (error) {
    showError(error);
  }
}

async function saveAllowlist(allowlist) {
  try {
    status = await call("companion.setAllowlist", { allowlist });
    render();
  } catch (error) {
    showError(error);
  }
}

async function loadCandidates() {
  try {
    candidates = await call("companion.candidates");
    const list = $("candidates");
    list.replaceChildren(...candidates.map((c) => Object.assign(document.createElement("option"), { value: c.name })));
  } catch {
    // The list is only a convenience.
  }
}

function stopPairing() {
  pairing = null;
  $("pairing").hidden = true;
}

function tick() {
  if (!pairing) return;
  const left = Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 1000));
  $("countdown").textContent = `Valid for ${left} more seconds. Only scan it with your own phone.`;
  if (left === 0) stopPairing();
}

$("enabled").onchange = async (event) => {
  try {
    status = await call("companion.configure", { enabled: event.target.checked });
    render();
    if (status.enabled) void loadCandidates();
  } catch (error) {
    showError(error);
  }
};

$("keep").onchange = async (event) => {
  try {
    status = await call("companion.configure", { keepScreenshots: event.target.checked });
    render();
  } catch (error) {
    showError(error);
  }
};

$("pair").onclick = async () => {
  try {
    const code = await call("companion.pairStart");
    pairing = { expiresAt: code.expiresAt, devices: status?.devices.length ?? 0 };
    $("pair-qr").src = svgUrl(code.svg);
    $("pairing").hidden = false;
    tick();
  } catch (error) {
    showError(error);
  }
};

$("pair-cancel").onclick = () => {
  stopPairing();
  void call("companion.pairCancel").catch(() => {});
};

$("allow-form").onsubmit = (event) => {
  event.preventDefault();
  const name = $("allow-input").value.trim().toLowerCase();
  const found = candidates.find((c) => c.name.toLowerCase() === name);
  if (!found || !status || status.allowlist.some((a) => a.kind === found.kind && a.id === found.id)) return;
  $("allow-input").value = "";
  void saveAllowlist([...status.allowlist, found]);
};

$("log-toggle").onclick = async () => {
  const log = $("log");
  log.hidden = !log.hidden;
  $("log-toggle").textContent = log.hidden ? "Show" : "Hide";
  if (!log.hidden) await loadLog();
};

async function loadLog() {
  try {
    const entries = await call("companion.log");
    const list = $("log-list");
    list.replaceChildren();
    for (const entry of entries) {
      const item = el("li", "entry");
      item.append(el("p", "", entry.text));
      item.append(el("p", "muted small", `${entry.device} · ${new Date(entry.createdAt).toLocaleString()} · ${entry.state}${entry.runAt ? ` · for ${entry.runAt}` : ""}`));
      if (entry.result) item.append(el("p", "subtle small clamp", entry.result));
      list.append(item);
    }
    if (!entries.length) list.append(el("li", "muted", "No tasks from phones yet."));
  } catch (error) {
    showError(error);
  }
}

$("log-clear").onclick = async () => {
  await call("companion.clearLog").catch(showError);
  await loadLog();
};

async function loadApp() {
  try {
    const app = await call("companion.app");
    $("app-qr").src = svgUrl(app.svg);
    $("app-qr").hidden = false;
    $("app-url").textContent = app.url;
  } catch (error) {
    $("app-url").textContent = error instanceof Error ? error.message : String(error);
  }
}

parent.postMessage({ nova: 1, ready: true }, "*");
void refresh().then(() => status?.enabled && loadCandidates());
void loadApp();
setInterval(() => {
  if (document.visibilityState === "visible") void refresh();
  tick();
}, 2000);
