#!/usr/bin/env node
// Drives a NOVA dev build over the Chrome DevTools Protocol, for end-to-end
// checks. Start NOVA with
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run desktop
// then:
//   node scripts/cdp.mjs list
//   node scripts/cdp.mjs eval <url-part> "<expression>"   (awaits promises, prints JSON; end the part with $ for an exact URL)
//   node scripts/cdp.mjs shot <url-part> <file.png>

import { writeFileSync } from "node:fs";

const [command, target, ...rest] = process.argv.slice(2);
const port = process.env.CDP_PORT ?? "9222";

async function targets() {
  const response = await fetch(`http://127.0.0.1:${port}/json`);
  return (await response.json()).filter((t) => t.type === "page");
}

async function connect(part) {
  // A trailing "$" asks for that exact URL.
  const exact = part.endsWith("$") ? part.slice(0, -1) : null;
  const page = (await targets()).find((t) => (exact ? t.url === exact : t.url.includes(part)));
  if (!page) throw new Error(`No page whose URL contains "${part}"`);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)(data);
      pending.delete(data.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => socket.close() };
}

if (command === "list") {
  for (const t of await targets()) console.log(t.url);
} else if (command === "eval") {
  const page = await connect(target);
  const result = await page.send("Runtime.evaluate", { expression: rest.join(" "), awaitPromise: true, returnByValue: true });
  page.close();
  if (result.result?.exceptionDetails) {
    console.error(JSON.stringify(result.result.exceptionDetails, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result.result?.result?.value ?? null, null, 2));
} else if (command === "shot") {
  const page = await connect(target);
  const result = await page.send("Page.captureScreenshot", { format: "png" });
  page.close();
  writeFileSync(rest[0], Buffer.from(result.result.data, "base64"));
  console.log(rest[0]);
} else {
  console.error("usage: cdp.mjs list | eval <url-part> <expression> | shot <url-part> <file.png>");
  process.exit(2);
}
