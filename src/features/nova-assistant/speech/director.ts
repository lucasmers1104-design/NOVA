import type { ReplyEvent } from "../conversation";
import type { AgentPrefs } from "../types";
import {
  createReplySpeaker,
  lineReady,
  nextSpeechTurn,
  replySpoken,
  setActiveReply,
  speakableText,
  speaksGerman,
  speechChunks,
  useVoice,
  voiceLine,
} from "../voice";
import { normalizeGerman } from "./normalize.de";
import { SentenceSegmenter } from "./segment";
import type { ReplySpeaker } from "./streamingSpeaker";
import { count, endTurn, mark } from "./timings";

/** The "one moment" line plays only if the reply's first sentence isn't ready by then. */
export const ACK_DELAY_MS = 900;

interface Reply {
  id: string;
  voice: boolean;
  prefs: AgentPrefs;
  segmenter: SentenceSegmenter;
  speaker: ReplySpeaker | null;
  nova: boolean;
  ack: string | null;
  ackTimer: ReturnType<typeof setTimeout> | null;
  /** The reply's first sentence is on its way to the speakers. */
  replyReady: boolean;
  confirmAsked: boolean;
}

export type SpeakerFactory = typeof createReplySpeaker;

/**
 * Reads replies aloud while they stream in: each finished sentence goes to the
 * speaker at once, tool rounds end a sentence, a confirmation is asked for out
 * loud in spoken turns, and a stopped reply goes quiet immediately.
 */
export class ReplyDirector {
  private reply: Reply | null = null;

  constructor(private readonly makeSpeaker: SpeakerFactory = createReplySpeaker) {}

  handle(event: ReplyEvent, prefs: AgentPrefs | null | undefined): void {
    if (event.type === "start") {
      this.start(event.replyId, event.voice, event.ack, prefs);
      return;
    }
    const reply = this.reply;
    if (!reply || reply.id !== event.replyId) return;
    switch (event.type) {
      case "text":
        this.say(reply, reply.segmenter.push(event.text));
        break;
      case "toolStarted":
        this.say(reply, reply.segmenter.boundary());
        break;
      case "confirmRequired":
        this.say(reply, reply.segmenter.boundary());
        if (reply.voice && !reply.confirmAsked) {
          reply.confirmAsked = true;
          this.line(reply, "confirm");
        }
        break;
      case "done":
        this.say(reply, reply.segmenter.finish());
        this.finish(reply);
        break;
      case "failed":
        if (reply.voice) this.line(reply, "failed");
        this.finish(reply);
        break;
      case "stopped":
        this.cancel();
        break;
    }
  }

  /** Stops the reply being read (also called through `stopSpeaking`). */
  cancel(): void {
    const reply = this.reply;
    if (!reply) return;
    this.reply = null;
    if (reply.ackTimer) clearTimeout(reply.ackTimer);
    reply.speaker?.cancel();
    setActiveReply(null);
    mark("replyStopped");
    endTurn();
  }

  private start(id: string, voice: boolean, ack: string | null, prefs: AgentPrefs | null | undefined) {
    this.cancel();
    if (!prefs || !(voice || prefs.speakReplies)) return;
    nextSpeechTurn();
    const reply: Reply = {
      id,
      voice,
      prefs,
      segmenter: new SentenceSegmenter({ codeNote: voiceLine("code", prefs.language) }),
      speaker: null,
      nova: false,
      ack: voice ? ack : null,
      ackTimer: null,
      replyReady: false,
      confirmAsked: false,
    };
    this.reply = reply;
    setActiveReply({ cancel: () => this.cancel() });
    if (reply.ack) {
      reply.ackTimer = setTimeout(() => {
        reply.ackTimer = null;
        if (this.reply !== reply || reply.replyReady || !reply.ack) return;
        // A line that still has to be made would only hold up the reply.
        if (!lineReady(reply.ack, reply.prefs)) {
          count("ackSkipped");
          return;
        }
        count("ackPlayed");
        this.enqueue(reply, reply.ack, "ack", true);
      }, ACK_DELAY_MS);
    }
  }

  private ensureSpeaker(reply: Reply, sample: string): ReplySpeaker {
    if (reply.speaker) return reply.speaker;
    const { speaker, nova } = this.makeSpeaker(sample, reply.prefs, {
      label: "speech",
      german: speaksGerman(reply.prefs.language),
      onPiece: (tag, text, delayMs) => {
        if (this.reply !== reply) return;
        const at = Date.now() + delayMs;
        if (tag === "reply" && !reply.replyReady) {
          reply.replyReady = true;
          if (reply.ackTimer) clearTimeout(reply.ackTimer);
          reply.ackTimer = null;
          mark("replyFirstAudio", at);
        }
        if (tag === "ack") mark("ackFirstAudio", at);
        if ((tag === "ack" || tag === "line") && reply.voice) useVoice.setState({ line: text });
      },
    });
    reply.speaker = speaker;
    reply.nova = nova;
    return speaker;
  }

  /** One piece of text through the speaker (cleaned up, and normalized for NOVA's German voices). */
  private enqueue(reply: Reply, raw: string, tag: string, first = false) {
    const spoken = speakableText(raw);
    if (!spoken) return;
    const speaker = this.ensureSpeaker(reply, spoken);
    const text = reply.nova ? normalizeGerman(spoken) : spoken;
    // Fixed lines are split like the ones made ahead of time, so they play at once.
    const pieces = tag === "reply" ? [text] : speechChunks(text);
    pieces.forEach((piece, i) => speaker.enqueue(piece, { tag, first: first && i === 0 }));
  }

  private say(reply: Reply, pieces: string[]) {
    for (const piece of pieces) {
      if (!speakableText(piece)) continue;
      mark("firstPieceQueued");
      count("replyPieces");
      this.enqueue(reply, piece, "reply");
    }
  }

  private line(reply: Reply, kind: "confirm" | "failed") {
    this.enqueue(reply, voiceLine(kind, reply.prefs.language), "line");
  }

  private finish(reply: Reply) {
    if (reply.ackTimer) clearTimeout(reply.ackTimer);
    reply.ackTimer = null;
    const end = () => {
      if (this.reply !== reply) return;
      this.reply = null;
      setActiveReply(null);
      replySpoken();
      mark("replyEnd");
      endTurn();
    };
    if (reply.speaker) void reply.speaker.finish().then(end);
    else end();
  }
}
