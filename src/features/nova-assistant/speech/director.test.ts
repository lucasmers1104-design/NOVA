import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyEvent } from "../conversation";
import type { AgentPrefs } from "../types";
import { ACK_DELAY_MS, ReplyDirector, type SpeakerFactory } from "./director";
import { type ReplySpeaker, StreamingSpeaker, type SynthBackend } from "./streamingSpeaker";
import { useVoice } from "../voice";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(), emitTo: vi.fn() }));

const PREFS: AgentPrefs = {
  provider: null,
  models: {},
  effort: "medium",
  monthlyLimitUsd: null,
  speakReplies: false,
  voice: "",
  speechRate: 1,
  speechVolume: 1,
  language: "de-DE",
  keepListening: true,
  autoMode: false,
};

interface Spoken {
  text: string;
  tag: string;
  first: boolean;
}

/** A speaker that records what it was asked to say. */
function fakeFactory() {
  const said: Spoken[] = [];
  const state = { created: 0, finished: 0, cancelled: 0, onPiece: null as null | ((tag: string, text: string, delay: number) => void) };
  const factory: SpeakerFactory = (_sample, _prefs, options = {}) => {
    state.created++;
    state.onPiece = options.onPiece ?? null;
    const speaker: ReplySpeaker = {
      enqueue: (text, opts = {}) => said.push({ text, tag: opts.tag ?? "reply", first: opts.first ?? false }),
      finish: async () => {
        state.finished++;
      },
      cancel: () => {
        state.cancelled++;
      },
      busy: false,
    };
    return { speaker, nova: false };
  };
  return { factory, said, state };
}

function events(director: ReplyDirector, prefs: AgentPrefs, list: ReplyEvent[]) {
  for (const event of list) director.handle(event, prefs);
}

const reply = (event: Partial<ReplyEvent> & { type: ReplyEvent["type"] }, voice = true) => ({ replyId: "r1", voice, ...event }) as ReplyEvent;

describe("ReplyDirector", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stays quiet for typed replies unless spoken replies are on", () => {
    const { factory, said, state } = fakeFactory();
    const director = new ReplyDirector(factory);
    events(director, PREFS, [reply({ type: "start", ack: null }, false), reply({ type: "text", text: "Hallo. Wie geht's?" }, false), reply({ type: "done" }, false)]);
    expect(state.created).toBe(0);
    expect(said).toEqual([]);
    events(director, { ...PREFS, speakReplies: true }, [reply({ type: "start", ack: null }, false), reply({ type: "text", text: "Hallo. Wie geht's?" }, false), reply({ type: "done" }, false)]);
    expect(said.map((s) => s.text)).toEqual(["Hallo.", "Wie geht's?"]);
  });

  it("speaks each sentence as soon as it is complete and finishes with the reply", () => {
    const { factory, said, state } = fakeFactory();
    const director = new ReplyDirector(factory);
    events(director, PREFS, [reply({ type: "start", ack: null }), reply({ type: "text", text: "Klar, das schaue ich mir an. Dein" })]);
    expect(said.map((s) => s.text)).toEqual(["Klar, das schaue ich mir an."]);
    events(director, PREFS, [reply({ type: "text", text: " Rechner ist gut ausgelastet." })]);
    expect(said).toHaveLength(1);
    events(director, PREFS, [reply({ type: "done" })]);
    expect(said.map((s) => s.text)).toEqual(["Klar, das schaue ich mir an.", "Dein Rechner ist gut ausgelastet."]);
    expect(state.finished).toBe(1);
  });

  it("ends a sentence when a tool starts and asks for confirmation out loud once", () => {
    const { factory, said } = fakeFactory();
    const director = new ReplyDirector(factory);
    events(director, PREFS, [
      reply({ type: "start", ack: null }),
      reply({ type: "text", text: "Ich lege den Ordner an" }),
      reply({ type: "toolStarted", id: "t1", name: "create_folder", title: "Create folder", risk: "confirm" }),
      reply({ type: "confirmRequired", id: "t1", title: "Create folder", detail: null, risk: "confirm" }),
      reply({ type: "confirmRequired", id: "t2", title: "Create folder", detail: null, risk: "confirm" }),
    ]);
    expect(said).toEqual([
      { text: "Ich lege den Ordner an", tag: "reply", first: false },
      { text: "Bitte bestätige das kurz im Fenster.", tag: "line", first: false },
    ]);
  });

  it("goes quiet at once when the reply is stopped and ignores what arrives later", () => {
    const { factory, said, state } = fakeFactory();
    const director = new ReplyDirector(factory);
    events(director, PREFS, [reply({ type: "start", ack: null }), reply({ type: "text", text: "Erster Satz. Zweiter" }), reply({ type: "stopped" })]);
    expect(state.cancelled).toBe(1);
    events(director, PREFS, [reply({ type: "text", text: " Satz. Dritter Satz." }), reply({ type: "done" })]);
    expect(said.map((s) => s.text)).toEqual(["Erster Satz."]);
    expect(state.finished).toBe(0);
  });

  it("says “one moment” only when the reply takes a while", () => {
    const quick = fakeFactory();
    const director = new ReplyDirector(quick.factory);
    events(director, PREFS, [reply({ type: "start", ack: "Einen Moment." }), reply({ type: "text", text: "Klar. Hier" })]);
    quick.state.onPiece?.("reply", "Klar.", 0);
    vi.advanceTimersByTime(ACK_DELAY_MS + 50);
    expect(quick.said.some((s) => s.tag === "ack")).toBe(false);

    const slow = fakeFactory();
    const other = new ReplyDirector(slow.factory);
    events(other, PREFS, [reply({ type: "start", ack: "Einen Moment." })]);
    vi.advanceTimersByTime(ACK_DELAY_MS + 50);
    expect(slow.said).toEqual([{ text: "Einen Moment.", tag: "ack", first: true }]);
  });

  it("tells a spoken turn when something went wrong", () => {
    const { factory, said, state } = fakeFactory();
    const director = new ReplyDirector(factory);
    events(director, PREFS, [reply({ type: "start", ack: null }), reply({ type: "failed", error: "boom" })]);
    expect(said).toEqual([{ text: "Da ist leider etwas schiefgegangen.", tag: "line", first: false }]);
    expect(state.finished).toBe(1);
  });

  it("drops the previous reply when a new one starts", () => {
    const { factory, state } = fakeFactory();
    const director = new ReplyDirector(factory);
    events(director, PREFS, [reply({ type: "start", ack: null }), reply({ type: "text", text: "Eins. Zwei" })]);
    director.handle({ replyId: "r2", voice: true, type: "start", ack: null }, PREFS);
    expect(state.cancelled).toBe(1);
  });

  describe("listening again after a reply", () => {
    const followUpsAfter = async (prefs: AgentPrefs, list: ReplyEvent[]) => {
      const before = useVoice.getState().followUps;
      events(new ReplyDirector(fakeFactory().factory), prefs, list);
      // The speaker finishes asynchronously.
      await vi.advanceTimersByTimeAsync(0);
      return useVoice.getState().followUps - before;
    };
    const spoken = [reply({ type: "start", ack: null }), reply({ type: "text", text: "Klar." })];

    it("asks once a spoken reply has been said", async () => {
      expect(await followUpsAfter(PREFS, [...spoken, reply({ type: "done" })])).toBe(1);
    });

    it("doesn't when the setting is off", async () => {
      expect(await followUpsAfter({ ...PREFS, keepListening: false }, [...spoken, reply({ type: "done" })])).toBe(0);
    });

    it("doesn't for typed requests, even when they are read aloud", async () => {
      const typed = [reply({ type: "start", ack: null }, false), reply({ type: "text", text: "Klar." }, false), reply({ type: "done" }, false)];
      expect(await followUpsAfter({ ...PREFS, speakReplies: true }, typed)).toBe(0);
    });

    it("doesn't after a stop or a failure", async () => {
      expect(await followUpsAfter(PREFS, [...spoken, reply({ type: "stopped" }), reply({ type: "done" })])).toBe(0);
      expect(await followUpsAfter(PREFS, [...spoken, reply({ type: "failed", error: "boom" })])).toBe(0);
    });
  });
});

/** A WebAudio stand-in with a clock the test moves. */
function fakeAudio() {
  const started: { at: number; duration: number }[] = [];
  const sources: { stop: () => void; onended: (() => void) | null; stopped: boolean }[] = [];
  const context = {
    currentTime: 0,
    destination: {},
    createGain: () => ({ gain: { value: 1 }, connect: () => {}, disconnect: () => {} }),
    createAnalyser: () => ({ fftSize: 512, connect: () => {}, disconnect: () => {}, getByteTimeDomainData: () => {} }),
    decodeAudioData: async (wav: ArrayBuffer) => ({ duration: wav.byteLength / 1000 }),
    createBufferSource: () => {
      const source = {
        buffer: null as { duration: number } | null,
        onended: null as (() => void) | null,
        stopped: false,
        connect: () => {},
        start: (at: number) => started.push({ at, duration: source.buffer!.duration }),
        stop: () => {
          source.stopped = true;
        },
      };
      sources.push(source);
      return source;
    },
  };
  return { context: context as unknown as AudioContext, started, sources, raw: context };
}

describe("StreamingSpeaker", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("plays pieces back to back in order, with the ack line ahead of everything not yet playing", async () => {
    const audio = fakeAudio();
    const made: string[] = [];
    const backend: SynthBackend = {
      // Each piece "lasts" its length in seconds / 10.
      synth: async (text) => {
        made.push(text);
        return new ArrayBuffer(text.length * 100);
      },
      cached: (text) => (text === "Moment." ? new ArrayBuffer(700) : null),
      context: () => audio.context,
    };
    const speaker = new StreamingSpeaker(backend, 1);
    speaker.enqueue("Erster Satz.");
    speaker.enqueue("Moment.", { first: true, tag: "ack" });
    speaker.enqueue("Zweiter Satz.");
    for (let i = 0; i < 6; i++) await flush();
    expect(made).toEqual(["Erster Satz.", "Zweiter Satz."]);
    expect(audio.started).toHaveLength(3);
    const [a, b, c] = audio.started;
    expect(a!.duration).toBeCloseTo(0.7); // the ack, made ahead, went first
    expect(b!.at).toBeCloseTo(a!.at + a!.duration);
    expect(c!.at).toBeCloseTo(b!.at + b!.duration);
  });

  it("joins waiting pieces into one request for online voices", async () => {
    const audio = fakeAudio();
    const made: string[] = [];
    const backend: SynthBackend = {
      synth: async (text) => {
        made.push(text);
        return new ArrayBuffer(100);
      },
      context: () => audio.context,
    };
    const speaker = new StreamingSpeaker(backend, 1, {}, true);
    // The first goes alone so NOVA starts quickly; what piles up meanwhile goes together.
    speaker.enqueue("Eins.");
    speaker.enqueue("Zwei.");
    speaker.enqueue("Drei.");
    speaker.enqueue("x".repeat(900));
    for (let i = 0; i < 8; i++) await flush();
    expect(made).toEqual(["Eins.", "Zwei. Drei.", "x".repeat(900)]);
    expect(audio.started).toHaveLength(3);
  });

  it("hands what wasn't said to the caller when the voice fails", async () => {
    const audio = fakeAudio();
    const unsaid: string[][] = [];
    const backend: SynthBackend = {
      synth: async (text) => {
        if (text.startsWith("Zwei")) throw new Error("engine died");
        return new ArrayBuffer(500);
      },
      context: () => audio.context,
    };
    const speaker = new StreamingSpeaker(backend, 1, { onFailed: (texts) => unsaid.push(texts) });
    speaker.enqueue("Eins.");
    speaker.enqueue("Zwei.");
    speaker.enqueue("Drei.");
    for (let i = 0; i < 6; i++) await flush();
    expect(unsaid).toEqual([["Zwei.", "Drei."]]);
    expect(audio.started).toHaveLength(1);
  });

  it("stops everything at once when cancelled", async () => {
    const audio = fakeAudio();
    const backend: SynthBackend = { synth: async () => new ArrayBuffer(500), context: () => audio.context };
    const speaker = new StreamingSpeaker(backend, 1);
    speaker.enqueue("Eins.");
    for (let i = 0; i < 4; i++) await flush();
    const done = speaker.finish();
    speaker.cancel();
    await done;
    expect(audio.sources.every((s) => s.stopped)).toBe(true);
    speaker.enqueue("Zwei.");
    expect(speaker.busy).toBe(false);
  });
});
