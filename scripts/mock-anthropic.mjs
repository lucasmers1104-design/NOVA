#!/usr/bin/env node
// A scripted stand-in for the Anthropic Messages API, for testing NOVA AI
// end to end without a key or costs. Debug builds of NOVA use it when started
// with NOVA_DEV_ANTHROPIC_URL=http://127.0.0.1:<port>/v1/messages.
//
//   node scripts/mock-anthropic.mjs [--port 8787] [--scenario file.json] [--log requests.jsonl]
//
// A scenario lists replies, served in order (and repeated): each with a delay
// before the first token (`ttftMs`), a delay per chunk (`chunkMs`), the text,
// and optionally one tool call. Prompt caching is simulated: a request whose
// cached prefix was seen before reports cache reads instead of writes.
// Every request body is summarised into the log so tests can check what NOVA
// sent (cache breakpoints, effort, voice note, beta headers).

import { createServer } from "node:http";
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const port = Number(args.port ?? 8787);
const logFile = args.log ?? null;

const DEFAULT_SCENARIO = {
  replies: [
    {
      ttftMs: 900,
      chunkMs: 40,
      chunkChars: 8,
      text:
        "Klar, das schaue ich mir an. Dein Rechner ist gerade gut ausgelastet, aber nicht überlastet. " +
        "Am meisten Leistung braucht im Moment der Browser mit 23 Prozent der CPU. " +
        "Wenn du willst, kann ich dir die fünf größten Prozesse auflisten, damit du entscheiden kannst, was du schließen möchtest.",
    },
  ],
};

const scenario = args.scenario ? JSON.parse(readFileSync(args.scenario, "utf8")) : DEFAULT_SCENARIO;
let cursor = 0;
const seenPrefixes = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tokens = (value) => Math.ceil(JSON.stringify(value ?? "").length / 4);

function log(entry) {
  if (logFile) appendFileSync(logFile, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
}

/** Tokens before the last breakpoint, and whether that prefix was cached already. */
function cacheUsage(body) {
  const systemBlocks = Array.isArray(body.system) ? body.system : [];
  const explicit = systemBlocks.some((b) => b.cache_control) || (body.tools ?? []).some((t) => t.cache_control);
  const messages = body.messages ?? [];
  const automatic = Boolean(body.cache_control);
  const markedMessage = messages.findLastIndex((m) => Array.isArray(m.content) && m.content.some((b) => b && b.cache_control));
  if (!explicit && !automatic && markedMessage < 0) return { input: tokens(body), read: 0, write: 0 };
  // The cached prefix ends at the last breakpoint (automatic: the last message).
  const end = automatic ? messages.length : markedMessage >= 0 ? markedMessage + 1 : 0;
  const prefix = { tools: body.tools, system: body.system, messages: messages.slice(0, end) };
  // Earlier prefixes of the same conversation count as cached too.
  let read = 0;
  for (let i = end; i >= 0; i--) {
    const key = createHash("sha256").update(JSON.stringify({ ...prefix, messages: messages.slice(0, i) })).digest("hex");
    if (seenPrefixes.has(key)) {
      read = tokens({ ...prefix, messages: messages.slice(0, i) });
      break;
    }
  }
  const total = tokens(prefix);
  seenPrefixes.add(createHash("sha256").update(JSON.stringify(prefix)).digest("hex"));
  return { input: Math.max(1, tokens(body) - total), read, write: Math.max(0, total - read) };
}

function summary(req, body) {
  const messages = body.messages ?? [];
  const last = messages.at(-1);
  const lastText = Array.isArray(last?.content)
    ? last.content.filter((b) => b.type === "text").map((b) => b.text).join(" ")
    : typeof last?.content === "string"
      ? last.content
      : "";
  return {
    stream: body.stream === true,
    maxTokens: body.max_tokens,
    effort: body.output_config?.effort ?? null,
    beta: req.headers["anthropic-beta"] ?? null,
    topLevelCache: Boolean(body.cache_control),
    systemCache: Array.isArray(body.system) && body.system.some((b) => b.cache_control),
    toolCache: (body.tools ?? []).some((t) => t.cache_control),
    messageCacheIndex: messages.findLastIndex((m) => Array.isArray(m.content) && m.content.some((b) => b && b.cache_control)),
    systemMessages: messages.filter((m) => m.role === "system").map((m) => m.output_config ?? m.content),
    messages: messages.length,
    tools: (body.tools ?? []).length,
    voiceNote: /\[Voice turn/.test(lastText),
    lastTextTail: lastText.slice(-160),
  };
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function stream(res, reply, usage, model) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  await sleep(reply.ttftMs ?? 600);
  sse(res, "message_start", {
    type: "message_start",
    message: { id: `msg_mock_${Date.now()}`, type: "message", role: "assistant", model, content: [], usage: { input_tokens: usage.input, cache_read_input_tokens: usage.read, cache_creation_input_tokens: usage.write, output_tokens: 1 } },
  });
  let index = 0;
  let output = 0;
  if (reply.text) {
    sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
    const size = reply.chunkChars ?? 8;
    for (let i = 0; i < reply.text.length; i += size) {
      sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: reply.text.slice(i, i + size) } });
      output += 2;
      await sleep(reply.chunkMs ?? 40);
    }
    sse(res, "content_block_stop", { type: "content_block_stop", index });
    index++;
  }
  if (reply.tool) {
    sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_mock_${Date.now()}`, name: reply.tool.name, input: {} } });
    sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.tool.input ?? {}) } });
    sse(res, "content_block_stop", { type: "content_block_stop", index });
    output += 20;
  }
  sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: reply.tool ? "tool_use" : "end_turn" }, usage: { output_tokens: output } });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
      res.writeHead(404).end();
      return;
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "invalid JSON" } }));
      return;
    }
    const usage = cacheUsage(body);
    const model = body.model ?? "claude-mock";
    log({ ...summary(req, body), usage });
    if (body.max_tokens === 0) {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ id: `msg_mock_${Date.now()}`, type: "message", role: "assistant", model, content: [], stop_reason: "max_tokens", usage: { input_tokens: usage.input, cache_read_input_tokens: usage.read, cache_creation_input_tokens: usage.write, output_tokens: 0 } }),
      );
      return;
    }
    const reply = scenario.replies[cursor % scenario.replies.length];
    cursor++;
    try {
      await stream(res, reply, usage, model);
    } catch {
      res.end();
    }
  });
}).listen(port, "127.0.0.1", () => console.log(`mock Anthropic API on http://127.0.0.1:${port}/v1/messages`));
