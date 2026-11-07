// The whole plugin API from a plugin's side: say you're ready, answer pings, ask by message.
const pending = new Map();
let nextId = 1;

addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.nova !== 1) return;
  const { id, result, error, event: name, data } = event.data;
  if (name === "ping") parent.postMessage({ nova: 1, pong: 1 }, "*");
  if (name === "theme") document.documentElement.style.setProperty("--accent", data.accentText);
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

async function refresh() {
  const snapshot = await call("system.snapshot");
  document.getElementById("cpu").textContent = `${Math.round(snapshot.cpuUsage)} %`;
  document.getElementById("memory").textContent = `${Math.round((snapshot.memoryUsed / snapshot.memoryTotal) * 100)} %`;
}

parent.postMessage({ nova: 1, ready: true }, "*");
void refresh();
setInterval(() => void refresh(), 5000);
