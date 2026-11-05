import { create } from "zustand";
import { answerConfirmation, cancelRequest, resetConversation, sendMessage } from "./api";
import { beginTurn, count, endTurn, mark } from "./speech/timings";
import type { AgentEvent, AssistantState, AttachmentView, Risk, ToolCard } from "./types";

export interface ToolItem {
  id: string;
  name: string;
  title: string;
  risk: Risk;
  state: "running" | "confirm" | "done" | "failed" | "declined";
  detail: string | null;
  summary: string | null;
  card: ToolCard | null;
}

export interface UsageInfo {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export type Segment = { type: "text"; text: string } | { type: "tool"; tool: ToolItem };

export type Item =
  | { kind: "user"; id: string; text: string; attachments: AttachmentView[] }
  | { kind: "assistant"; id: string; segments: Segment[]; streaming: boolean; usage: UsageInfo[]; error: string | null; stopped?: boolean };

export type AssistantItem = Extract<Item, { kind: "assistant" }>;

interface ConversationState {
  items: Item[];
  state: AssistantState;
  detail: string | null;
  busy: boolean;
  /** Screenshots and files that go with the next message. */
  attachments: AttachmentView[];
  lastPrompt: string | null;
  send: (text: string, options?: SendOptions) => Promise<void>;
  apply: (event: AgentEvent) => void;
  cancel: () => Promise<void>;
  confirm: (id: string, approved: boolean) => Promise<void>;
  reset: () => Promise<void>;
  retry: () => Promise<void>;
  setAttachments: (attachments: AttachmentView[]) => void;
  /** Voice states the panel drives itself (listening, processing, speaking). */
  setState: (state: AssistantState, detail?: string | null) => void;
}

export interface SendOptions {
  /** The user spoke this request: the reply is read aloud. */
  voice?: boolean;
  /** Said if the reply takes a moment ("one moment"). */
  ack?: string;
}

/** A reply as it streams in, for whoever reads it aloud. */
export type ReplyEvent = { replyId: string; voice: boolean } & ({ type: "start"; ack: string | null } | { type: "stopped" } | AgentEvent);

const replyListeners = new Set<(event: ReplyEvent) => void>();

/** Follows every reply as it streams in; returns the unsubscribe function. */
export function onReply(listener: (event: ReplyEvent) => void): () => void {
  replyListeners.add(listener);
  return () => replyListeners.delete(listener);
}

function emitReply(event: ReplyEvent) {
  for (const listener of replyListeners) listener(event);
}

/** The reply streaming in now. */
let currentReply: { id: string; voice: boolean } | null = null;

let nextId = 1;
const id = () => `m${nextId++}`;

function updateTool(segments: Segment[], toolId: string, patch: (tool: ToolItem) => ToolItem): Segment[] {
  return segments.map((s) => (s.type === "tool" && s.tool.id === toolId ? { type: "tool", tool: patch(s.tool) } : s));
}

/** Applies one streamed event to the assistant reply being written. */
export function reduceReply(item: AssistantItem, event: AgentEvent): AssistantItem {
  switch (event.type) {
    case "text": {
      const last = item.segments.at(-1);
      const segments: Segment[] =
        last?.type === "text" ? [...item.segments.slice(0, -1), { type: "text", text: last.text + event.text }] : [...item.segments, { type: "text", text: event.text }];
      return { ...item, segments };
    }
    case "toolStarted":
      return {
        ...item,
        segments: [
          ...item.segments,
          { type: "tool", tool: { id: event.id, name: event.name, title: event.title, risk: event.risk, state: "running", detail: null, summary: null, card: null } },
        ],
      };
    case "confirmRequired":
      return { ...item, segments: updateTool(item.segments, event.id, (t) => ({ ...t, state: "confirm", title: event.title, detail: event.detail, risk: event.risk })) };
    case "toolFinished": {
      const exists = item.segments.some((s) => s.type === "tool" && s.tool.id === event.id);
      const finished = (t: ToolItem): ToolItem => ({
        ...t,
        state: event.ok ? "done" : t.state === "confirm" && event.summary === "Not allowed" ? "declined" : "failed",
        summary: event.summary,
        card: event.card,
      });
      if (!exists) {
        // A call rejected before it started (invalid arguments).
        return {
          ...item,
          segments: [...item.segments, { type: "tool", tool: finished({ id: event.id, name: "", title: event.summary, risk: "safe", state: "running", detail: null, summary: null, card: null }) }],
        };
      }
      return { ...item, segments: updateTool(item.segments, event.id, finished) };
    }
    case "usage":
      return { ...item, usage: [...item.usage, { provider: event.provider, model: event.model, inputTokens: event.inputTokens, outputTokens: event.outputTokens, costUsd: event.costUsd }] };
    case "done":
      return { ...item, streaming: false };
    case "failed":
      return { ...item, streaming: false, error: event.error };
    case "status":
      // The backend ends a cancelled run with "Done"; the reply stays as far as it got.
      return event.state === "completed" && event.detail === "Stopped" ? { ...item, stopped: true } : item;
  }
}

/** The reply's text, for reading aloud. */
export function replyText(item: AssistantItem): string {
  return item.segments
    .filter((s): s is Extract<Segment, { type: "text" }> => s.type === "text")
    .map((s) => s.text)
    .join("\n\n");
}

export const useConversation = create<ConversationState>()((set, get) => ({
  items: [],
  state: "idle",
  detail: null,
  busy: false,
  attachments: [],
  lastPrompt: null,

  send: async (text, options = {}) => {
    const { busy, attachments } = get();
    if (busy || (!text.trim() && attachments.length === 0)) return;
    const voice = options.voice ?? false;
    const reply: AssistantItem = { kind: "assistant", id: id(), segments: [], streaming: true, usage: [], error: null };
    set((s) => ({
      items: [...s.items, { kind: "user", id: id(), text: text.trim(), attachments }, reply],
      attachments: [],
      busy: true,
      state: "thinking",
      detail: null,
      lastPrompt: text,
    }));
    beginTurn(voice ? "voice" : "reply");
    mark("send");
    const current = { id: reply.id, voice };
    currentReply = current;
    emitReply({ replyId: reply.id, voice, type: "start", ack: options.ack ?? null });
    try {
      await sendMessage(text, voice, (event) => {
        get().apply(event);
        if (currentReply === current) emitReply({ replyId: reply.id, voice, ...event });
      });
    } catch (error) {
      const failed: AgentEvent = { type: "failed", error: error instanceof Error ? error.message : String(error) };
      get().apply(failed);
      if (currentReply === current) emitReply({ replyId: reply.id, voice, ...failed });
    }
    if (currentReply === current) currentReply = null;
    // The command returns after its last event; make sure the turn is closed.
    set((s) => ({ busy: false, items: s.items.map((i) => (i.kind === "assistant" && i.streaming ? { ...i, streaming: false } : i)) }));
  },

  apply: (event) => {
    if (event.type === "text") mark("firstDelta");
    if (event.type === "usage") {
      count("inputTokens", event.inputTokens);
      count("cacheReadTokens", event.cacheReadTokens ?? 0);
      count("cacheWriteTokens", event.cacheWriteTokens ?? 0);
      count("requests");
    }
    if (event.type === "done" || event.type === "failed") {
      mark("replyDone");
      // A spoken reply ends the turn when it has been said; otherwise this does.
      endTurn(90_000);
    }
    set((s) => {
      const items = [...s.items];
      const index = items.findLastIndex((i) => i.kind === "assistant");
      if (index >= 0) items[index] = reduceReply(items[index] as AssistantItem, event);
      switch (event.type) {
        case "status":
          return { items, state: event.state, detail: event.detail };
        case "confirmRequired":
          return { items, state: "executing", detail: "Waiting for your OK" };
        case "done":
          return { items, busy: false, state: s.state === "error" ? "error" : "completed", detail: null };
        case "failed":
          return { items, busy: false, state: "error", detail: event.error };
        default:
          return { items };
      }
    });
  },

  cancel: async () => {
    // Whatever arrives after this is not read aloud.
    const reply = currentReply;
    if (reply) {
      currentReply = null;
      set((s) => ({ items: s.items.map((i) => (i.kind === "assistant" && i.id === reply.id ? { ...i, stopped: true } : i)) }));
      emitReply({ replyId: reply.id, voice: reply.voice, type: "stopped" });
    }
    await cancelRequest().catch(() => {});
  },

  confirm: async (toolId, approved) => {
    // Before answering: a quick tool finishes first otherwise, and "running" would overwrite "done".
    set((s) => ({
      items: s.items.map((i) => (i.kind === "assistant" ? { ...i, segments: updateTool(i.segments, toolId, (t) => (approved ? { ...t, state: "running" } : t)) } : i)),
    }));
    await answerConfirmation(toolId, approved);
  },

  reset: async () => {
    if (get().busy) await get().cancel();
    await resetConversation();
    set({ items: [], state: "idle", detail: null, lastPrompt: null });
  },

  retry: async () => {
    const prompt = get().lastPrompt;
    if (prompt !== null) await get().send(prompt);
  },

  setAttachments: (attachments) => set({ attachments }),
  setState: (state, detail = null) => set({ state, detail }),
}));
