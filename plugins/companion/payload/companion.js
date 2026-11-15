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
const PAIRING_SECONDS = 120;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function chip(text, kind) {
  const node = el("li", `chip${kind ? ` chip--${kind}` : ""}`);
  if (kind && kind !== "mono") node.append(el("i"));
  node.append(document.createTextNode(text));
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
let network = null;
let checkingNetwork = false;

function seen(device) {
  if (device.connected) return "Connected now";
  if (device.lastSeen === null) return "Never connected";
  const minutes = Math.round((Date.now() - device.lastSeen) / 60000);
  if (minutes < 1) return "Seen just now";
  if (minutes < 60) return `Seen ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `Seen ${hours} h ago` : `Seen ${Math.round(hours / 24)} days ago`;
}

function renderHero() {
  const chips = $("hero-chips");
  chips.replaceChildren();
  if (!status) return;
  const connected = status.devices.filter((d) => d.connected).length;
  chips.append(status.enabled ? (status.listening ? chip("Connection on", "ok") : chip("Not reachable", "warn")) : chip("Connection off", "off"));
  chips.append(chip(status.devices.length === 1 ? "1 phone paired" : `${status.devices.length} phones paired`, status.devices.length ? "ok" : "off"));
  if (connected) chips.append(chip(connected === 1 ? "1 connected" : `${connected} connected`, "ok"));
  if (network?.verdict === "blocked") chips.append(chip("Windows firewall blocks phones", "warn"));
  if (network?.verdict === "otherFirewall") chips.append(chip(`${network.otherFirewall} firewall decides`, "warn"));
}

function renderNetwork() {
  const verdict = $("net-verdict");
  const tile = $("net-tile");
  const actions = $("net-actions");
  if (!network) {
    verdict.textContent = checkingNetwork ? "Checking…" : status?.enabled ? "Not checked yet." : "Turn on the phone connection to check the network.";
    verdict.className = "small muted";
    tile.className = "tile tile--slate";
    actions.hidden = true;
  } else {
    const texts = {
      ready: ["Phones can reach this PC: NOVA is allowed in Windows' firewall.", "verdict-ok", "tile--green"],
      blocked: [
        network.blocksEverything
          ? "Windows blocks every incoming connection on public networks. Turn that off in Windows Security, or set your network to “Private”."
          : "This PC is on a network Windows calls “Public” and its firewall blocks phones. Typical for PCs on a LAN cable. Allow NOVA, and it works over cable, WLAN and USB tethering.",
        "verdict-bad",
        "tile--amber",
      ],
      unsure: ["Your network is private. If a phone still can't connect, allow NOVA in the firewall once.", "muted", "tile--cyan"],
      otherFirewall: [
        `${network.otherFirewall} has its own firewall switched on, and it decides whether phones get in. NOVA can't see its rules. In its firewall settings, mark your home network as “Private” (trusted), or allow incoming connections for NOVA (nova.exe). ${network.rulePresent ? "Windows' firewall already allows NOVA." : "Allow NOVA in Windows' firewall below too."}`,
        "verdict-bad",
        "tile--amber",
      ],
      unknown: ["Windows' firewall couldn't be asked.", "muted", "tile--slate"],
    };
    const [text, className, tileClass] = texts[network.verdict] ?? texts.unknown;
    verdict.textContent = text;
    verdict.className = `small ${className}`;
    tile.className = `tile ${tileClass}`;
    actions.hidden = network.verdict === "ready" || (network.verdict === "otherFirewall" && network.rulePresent) || !status?.enabled;
  }
  $("net-check").disabled = checkingNetwork || !status?.enabled;
  $("net-check").textContent = checkingNetwork ? "Checking…" : "Check network";

  const list = $("address-list");
  list.replaceChildren();
  const addresses = status?.listening ? status.addresses : [];
  for (const address of addresses) list.append(chip(`${address}:${status.port}`, "mono"));
  $("addresses").hidden = addresses.length === 0;
}

function renderDevices() {
  const devices = $("devices");
  devices.replaceChildren();
  for (const device of status.devices) {
    const item = el("li", "device");
    const avatar = el("span", "avatar", device.name.trim().charAt(0).toUpperCase() || "?");
    avatar.append(el("i", device.connected ? "on" : ""));
    const text = el("div", "grow");
    text.append(el("p", "", device.name));
    text.append(el("p", "muted small", `${seen(device)} · ${device.platform === "ios" ? "iPhone" : "Android"} · paired ${new Date(device.pairedAt).toLocaleDateString()}`));
    const remove = el("button", removing === device.id ? "danger" : "ghost", removing === device.id ? "Really remove?" : "Remove");
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
    item.append(avatar, text, remove);
    devices.append(item);
  }
  $("no-devices").hidden = status.devices.length > 0;
  const connected = status.devices.filter((d) => d.connected).length;
  $("devices-summary").textContent = status.devices.length ? `${connected} of ${status.devices.length} connected right now.` : "";
}

function render() {
  if (!status) return;
  $("enabled").checked = status.enabled;
  $("keep").checked = status.keepScreenshots;
  $("link-text").textContent = !status.enabled
    ? "Turn on the phone connection above first. Windows may ask once whether NOVA may use the network."
    : status.listening
      ? `Ready on port ${status.port}. Phones in your network, on the same router or on USB tethering find this PC.`
      : "Not reachable right now.";
  $("error").hidden = !status.error;
  $("error").textContent = status.error ?? "";
  $("pair").disabled = !(status.enabled && status.listening);

  renderHero();
  renderNetwork();
  renderDevices();

  const chips = $("allowlist");
  chips.replaceChildren();
  for (const entry of status.allowlist) {
    const item = el("li", "chip", entry.name);
    const x = el("button", "x", "×");
    x.type = "button";
    x.setAttribute("aria-label", `Remove ${entry.name}`);
    x.onclick = () => saveAllowlist(status.allowlist.filter((a) => !(a.kind === entry.kind && a.id === entry.id)));
    item.append(x);
    chips.append(item);
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

async function checkNetwork() {
  if (!status?.enabled || checkingNetwork) return;
  checkingNetwork = true;
  renderNetwork();
  try {
    network = await call("companion.network");
  } catch {
    network = { verdict: "unknown" };
  }
  checkingNetwork = false;
  renderHero();
  renderNetwork();
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
  $("pair-idle").hidden = false;
}

function tick() {
  if (!pairing) return;
  const left = Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 1000));
  $("countdown").textContent = `Valid for ${left} more seconds`;
  $("ring").style.strokeDashoffset = String(100 - (left / PAIRING_SECONDS) * 100);
  if (left === 0) stopPairing();
}

$("enabled").onchange = async (event) => {
  try {
    status = await call("companion.configure", { enabled: event.target.checked });
    render();
    if (status.enabled) {
      void loadCandidates();
      void checkNetwork();
    } else {
      network = null;
      renderNetwork();
    }
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
    $("pair-idle").hidden = true;
    tick();
  } catch (error) {
    showError(error);
  }
};

$("pair-cancel").onclick = () => {
  stopPairing();
  void call("companion.pairCancel").catch(() => {});
};

$("net-check").onclick = () => void checkNetwork();

/** Says what the click did; the verdict tile alone may not change (e.g. Avast still decides). */
function showResult(text, ok = true) {
  const result = $("net-result");
  result.textContent = text;
  result.className = `small ${ok ? "verdict-ok" : "verdict-bad"}`;
  result.hidden = !text;
}

$("net-allow").onclick = async () => {
  const button = $("net-allow");
  try {
    button.disabled = true;
    button.textContent = "Waiting for Windows…";
    showResult("Windows asks for administrator rights now. Look for its window, it may be in the taskbar.", true);
    // NOVA waits for netsh and checks again, so this is the real state afterwards.
    network = await call("companion.allowFirewall");
    renderHero();
    renderNetwork();
    showResult(
      network.verdict === "otherFirewall"
        ? `✓ Windows' firewall allows NOVA now. ${network.otherFirewall} still decides on its own; allow NOVA there too if a phone can't connect.`
        : network.verdict === "ready"
          ? "✓ Done: NOVA is allowed in Windows' firewall. Phones on your network can connect."
          : network.blocksEverything
            ? "The rule is in place, but Windows blocks every incoming connection on public networks. Turn that off in Windows Security, or set the network to “Private”."
            : "✓ The rule is in place.",
      network.verdict === "ready" || network.verdict === "otherFirewall" || !network.blocksEverything,
    );
  } catch (error) {
    showResult(error instanceof Error ? error.message : String(error), false);
  } finally {
    button.disabled = false;
    button.textContent = "Allow NOVA in the firewall";
  }
};

$("net-settings").onclick = () => void call("companion.networkSettings").catch(showError);

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
  try {
    const release = await call("companion.appRelease");
    if (release?.version) $("app-version").textContent = `Android · newest version ${release.version}`;
  } catch {
    // Older NOVA without the method, or no manifest yet: no version shown.
  }
}

parent.postMessage({ nova: 1, ready: true }, "*");
void refresh().then(() => {
  if (!status?.enabled) return;
  void loadCandidates();
  void checkNetwork();
});
void loadApp();
setInterval(() => {
  if (document.visibilityState === "visible") void refresh();
  tick();
}, 2000);
// The firewall and the network kind change rarely: a calmer pace than the status.
setInterval(() => {
  if (document.visibilityState === "visible" && network?.verdict !== "ready") void checkNetwork();
}, 30_000);
