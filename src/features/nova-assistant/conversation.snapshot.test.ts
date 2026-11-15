import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { type Item, restoreConversation, snapshotConversation, useConversation } from "./conversation";

vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), sendMessage: vi.fn(async () => {}), clearAttachments: vi.fn(async () => {}) }));

const TALK: Item[] = [
  { kind: "user", id: "m41", text: "Wie spät ist es?", attachments: [] },
  {
    kind: "assistant",
    id: "m40",
    segments: [
      { type: "text", text: "Es ist **14:30**." },
      { type: "tool", tool: { id: "t1", name: "open_app", title: "Spotify öffnen", risk: "safe", state: "done", detail: null, summary: "Geöffnet", card: null } },
    ],
    streaming: false,
    usage: [{ provider: "anthropic", model: "claude", inputTokens: 900, outputTokens: 12, costUsd: 0.001 }],
    error: null,
  },
];

describe("a panel that ends to give its memory back", () => {
  beforeEach(() => {
    useConversation.setState({ items: [], busy: false, attachments: [], lastPrompt: null, state: "idle", detail: null });
  });

  it("hands its conversation to the next panel exactly as it was", () => {
    useConversation.setState({ items: TALK });
    const snapshot = snapshotConversation();
    expect(snapshot).not.toBeNull();
    useConversation.setState({ items: [] });
    expect(restoreConversation(snapshot ?? "")).toBe(true);
    expect(useConversation.getState().items).toEqual(TALK);
    expect(useConversation.getState().lastPrompt).toBe("Wie spät ist es?");
  });

  it("gives new messages ids that aren't on screen yet", async () => {
    expect(restoreConversation(JSON.stringify({ version: 1, items: TALK }))).toBe(true);
    await useConversation.getState().send("Und morgen?");
    expect(api.sendMessage).toHaveBeenCalled();
    const ids = useConversation.getState().items.map((item) => item.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(ids.slice(2).every((id) => Number(id.slice(1)) > 41)).toBe(true);
  });

  it("stays while something is under way that would be lost", () => {
    useConversation.setState({ items: TALK, busy: true });
    expect(snapshotConversation()).toBeNull();
    useConversation.setState({ busy: false, attachments: [{ id: "a1" } as never] });
    expect(snapshotConversation()).toBeNull();
    useConversation.setState({ attachments: [], items: [{ ...TALK[1], streaming: true } as Item] });
    expect(snapshotConversation()).toBeNull();
    // Nothing said yet is fine: there is simply nothing to bring back.
    useConversation.setState({ items: [] });
    expect(snapshotConversation()).toBe('{"version":1,"items":[]}');
  });

  it("starts empty rather than broken on anything it can't read", () => {
    for (const bad of ["", "not json", "null", '{"version":2,"items":[]}', '{"version":1,"items":[{"kind":"user"}]}', '{"version":1,"items":[{"kind":"assistant","id":"m1","segments":"x","usage":[]}]}', '{"version":1,"items":{}}']) {
      expect(restoreConversation(bad), bad).toBe(false);
    }
    expect(useConversation.getState().items).toEqual([]);
  });
});
