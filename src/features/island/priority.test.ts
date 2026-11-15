import { describe, expect, it } from "vitest";
import { aiBusy, arrange, clock, currentNotice, effectiveSlot, type IslandInputs, MAX_PILL, normalizeOrder, pillSize, rate, readableNumber, slotSupported } from "./priority";
import { DEFAULT_ISLAND_PREFS, DEFAULT_ORDER, DEFAULT_SLOTS, type PhoneCall, type PhoneNotice, type SlotItem, type SlotState } from "./types";

const notice: PhoneNotice = { notifId: "k", app: "com.whatsapp", appName: "WhatsApp", title: "Lena", text: "Hi", icon: null, posted: 0 };
const call = (state: PhoneCall["state"]): PhoneCall => ({ callId: "c", state, name: "Mama", number: null, photo: null, canAnswer: true, canDecline: true });

const nothing: IslandInputs = { modules: { ...DEFAULT_ISLAND_PREFS.modules, system: false }, order: DEFAULT_ORDER, callsFirst: true, call: null, ai: "idle", aiReply: false, notification: null, music: null };
const closed = { dot: false, lyrics: false, ringing: false };

describe("Nova Island priority", () => {
  it("shows nothing when nothing happens", () => {
    expect(arrange(nothing)).toEqual({ primary: null, secondary: null });
  });

  it("shows a ringing call alone, over everything", () => {
    expect(arrange({ ...nothing, call: call("ringing"), ai: "thinking", notification: notice, music: "playing" })).toEqual({ primary: "call", secondary: null });
  });

  it("keeps a running call first and one more thing beside it", () => {
    expect(arrange({ ...nothing, call: call("active"), music: "playing", notification: notice })).toEqual({ primary: "call", secondary: "notification" });
  });

  it("shows at most two things, the most relevant first", () => {
    expect(arrange({ ...nothing, ai: "thinking", notification: notice, music: "playing", modules: { ...nothing.modules, system: true } })).toEqual({ primary: "ai", secondary: "notification" });
    expect(arrange({ ...nothing, notification: notice, music: "playing" })).toEqual({ primary: "notification", secondary: "music" });
  });

  it("lets paused music fill only a free place", () => {
    expect(arrange({ ...nothing, music: "paused", modules: { ...nothing.modules, system: true } })).toEqual({ primary: "system", secondary: "music" });
    expect(arrange({ ...nothing, music: "paused" })).toEqual({ primary: "music", secondary: null });
    // Also when music ranks first: paused, it still waits behind what is happening.
    expect(arrange({ ...nothing, order: ["music", "ai", "notifications", "calls", "system"], music: "paused", notification: notice })).toEqual({ primary: "notification", secondary: "music" });
  });

  it("leaves out what is turned off", () => {
    const off = { ...nothing.modules, calls: false, music: false };
    expect(arrange({ ...nothing, modules: off, call: call("ringing"), music: "playing" })).toEqual({ primary: null, secondary: null });
  });

  it("counts only real work as NOVA AI being busy", () => {
    expect(aiBusy("idle")).toBe(false);
    expect(aiBusy("completed")).toBe(false);
    expect(aiBusy("listening")).toBe(true);
    expect(arrange({ ...nothing, ai: "completed", aiReply: true })).toEqual({ primary: "ai", secondary: null });
  });

  it("ranks by the order the user set", () => {
    const busy = { ...nothing, ai: "thinking", notification: notice, music: "playing" } as const;
    expect(arrange({ ...busy, order: ["music", "notifications", "ai", "calls", "system"] })).toEqual({ primary: "music", secondary: "notification" });
    expect(arrange({ ...busy, order: ["notifications", "ai", "music", "calls", "system"] })).toEqual({ primary: "notification", secondary: "ai" });
  });

  it("lets a call lead whatever the order says while calls come first", () => {
    const order = ["music", "ai", "notifications", "system", "calls"] as const;
    expect(arrange({ ...nothing, order, call: call("active"), music: "playing" })).toEqual({ primary: "call", secondary: "music" });
    expect(arrange({ ...nothing, order, call: call("ringing"), music: "playing" })).toEqual({ primary: "call", secondary: null });
    // Without "calls first" the call takes the place the order gives it, also while it rings.
    expect(arrange({ ...nothing, order, callsFirst: false, call: call("active"), music: "playing" })).toEqual({ primary: "music", secondary: "call" });
    expect(arrange({ ...nothing, order, callsFirst: false, call: call("ringing"), music: "playing" })).toEqual({ primary: "music", secondary: "call" });
    expect(arrange({ ...nothing, order, callsFirst: false, call: call("ringing") })).toEqual({ primary: "call", secondary: null });
  });

  it("completes an order that names too little, too much or nonsense", () => {
    expect(normalizeOrder([])).toEqual(DEFAULT_ORDER);
    expect(normalizeOrder(["music", "music", "hologram", "ai"])).toEqual(["music", "ai", "calls", "notifications", "system"]);
    // A broken order from anywhere still arranges.
    expect(arrange({ ...nothing, order: ["music"], notification: notice, music: "playing" })).toEqual({ primary: "music", secondary: "notification" });
  });

  it("grows for what it shows", () => {
    const small = pillSize({ primary: null, secondary: null }, false, closed);
    const music = pillSize({ primary: "music", secondary: null }, false, closed);
    const both = pillSize({ primary: "music", secondary: "system" }, false, { ...closed, dot: true });
    const open = pillSize({ primary: "music", secondary: null }, true, { ...closed, lyrics: true });
    expect(music.width).toBeGreaterThan(small.width);
    expect(both.width).toBeGreaterThan(music.width);
    expect(open.height).toBeGreaterThan(music.height);
  });

  it("keeps the 1.12 sizes with the default slots", () => {
    const width = (state: SlotState) => pillSize({ primary: state, secondary: null }, false, { ...closed, slots: DEFAULT_SLOTS[state] }).width;
    expect([width("music"), width("call"), width("ai"), width("notification"), width("system")]).toEqual([268, 236, 270, 320, 244]);
    expect(pillSize({ primary: "music", secondary: null }, false, { ...closed, slots: DEFAULT_SLOTS.music })).toEqual({ width: 268, height: 38 });
    expect(pillSize({ primary: null, secondary: null }, false, closed)).toEqual({ width: 112, height: 30 });
  });

  it("makes room for what sits in the side slots, and none for an empty one", () => {
    const width = (left: SlotItem, right: SlotItem) => pillSize({ primary: "music", secondary: null }, false, { ...closed, slots: { left, right } }).width;
    expect(width("none", "none")).toBe(206);
    expect(width("cover", "none")).toBe(206 + 24 + 9);
    expect(width("clock", "remaining")).toBe(206 + 36 + 9 + 34 + 9);
    // The closed pill's height follows the setting; the resting pill stays a little slimmer.
    expect(pillSize({ primary: "music", secondary: null }, false, { ...closed, closedHeight: 46 }).height).toBe(46);
    expect(pillSize({ primary: null, secondary: null }, false, { ...closed, closedHeight: 46 }).height).toBe(38);
    // An opened island doesn't care about either.
    expect(pillSize({ primary: "music", secondary: null }, true, { ...closed, closedHeight: 46, slots: { left: "clock", right: "clock" } })).toEqual({ width: 400, height: 186 });
  });

  it("leaves a slot empty where its content makes no sense", () => {
    expect(slotSupported("remaining", "music")).toBe(true);
    expect(slotSupported("remaining", "system")).toBe(false);
    expect(slotSupported("progress", "call")).toBe(false);
    expect(effectiveSlot("remaining", "ai", false)).toBe("none");
    // The island's own dot already shows what NOVA AI does.
    expect(effectiveSlot("aiStatus", "ai", true)).toBe("none");
    expect(effectiveSlot("aiStatus", "ai", false)).toBe("aiStatus");
    const withDot = pillSize({ primary: "ai", secondary: null }, false, { ...closed, dot: true, slots: DEFAULT_SLOTS.ai }).width;
    expect(withDot).toBe(239 + 30);
  });

  it("never asks for more room than the window has", () => {
    const states: SlotState[] = ["music", "call", "ai", "notification", "system"];
    const items: SlotItem[] = ["cover", "visualizer", "appIcon", "clock", "remaining", "progress", "aiStatus", "none"];
    for (const state of states) {
      for (const left of items) {
        for (const right of items) {
          for (const expanded of [false, true]) {
            const size = pillSize({ primary: state, secondary: "system" }, expanded, { dot: true, lyrics: true, ringing: false, slots: { left, right }, closedHeight: 46 });
            expect(size.width <= MAX_PILL.width && size.height <= MAX_PILL.height, `${state} ${left} ${right} ${expanded}`).toBe(true);
          }
        }
      }
    }
    expect(pillSize({ primary: "call", secondary: null }, false, { ...closed, ringing: true })).toEqual({ width: 380, height: 88 });
  });

  it("shows queued notifications one after another", () => {
    const queue = [{ id: 1, shownAt: 0 }, { id: 2, shownAt: null }];
    expect(currentNotice(queue, 1000, 8)?.id).toBe(1);
    expect(currentNotice(queue, 9000, 8)?.id).toBe(2);
    expect(currentNotice([{ id: 1, shownAt: 0 }], 9000, 8)).toBeNull();
  });

  it("formats numbers for the small space", () => {
    expect(readableNumber("+49 170 1234567")).toBe("+49 170 1234567");
    expect(readableNumber("<b>x</b>")).toBeNull();
    expect(rate(999)).toBe("999 B/s");
    expect(rate(12_400_000)).toBe("12.4 MB/s");
    expect(clock(187_000)).toBe("3:07");
  });
});
