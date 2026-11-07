/**
 * Speaks a reply piece by piece while it is still being written. Pieces are
 * synthesized one after another (never more than a few seconds of audio
 * ahead) and scheduled back to back on one WebAudio timeline, so there are
 * no gaps between sentences.
 */

export interface SpeakerHooks {
  /** Audio started playing (true) or ran out (false). */
  onAudio?: (playing: boolean) => void;
  /** The first piece started playing. */
  onFirstAudio?: () => void;
  /** A piece was put on the timeline; it starts `delayMs` from now. */
  onPiece?: (tag: string, text: string, delayMs: number) => void;
  /** Loudness of what plays now, 0–1, about 14 times a second. */
  onLevel?: (level: number) => void;
  /** The voice failed; these pieces were not said. */
  onFailed?: (unsaid: string[]) => void;
  /** Time the listener waited for audio between two pieces (ms). */
  onGap?: (ms: number) => void;
}

/** What every reply speaker can do (NOVA's voice or a Windows voice). */
export interface ReplySpeaker {
  /** `first`: before everything not yet playing; `tag` names the piece for `onPiece`. */
  enqueue(text: string, options?: { first?: boolean; tag?: string }): void;
  /** Nothing more will come; resolves when everything has been said (or cancelled). */
  finish(): Promise<void>;
  /** Stops at once. */
  cancel(): void;
  /** Pieces waiting or playing. */
  readonly busy: boolean;
}

export interface SynthBackend {
  /** WAV audio for one piece. */
  synth(text: string): Promise<ArrayBuffer>;
  /** Audio made ahead of time (greetings, "one moment"), if there is any. */
  cached?(text: string): ArrayBuffer | null;
  context(): AudioContext;
}

interface Item {
  text: string;
  tag: string;
  state: "waiting" | "making" | "ready" | "scheduled" | "failed";
  buffer: AudioBuffer | null;
}

/** Audio made ahead of what plays is limited to this much (seconds). */
const LOOKAHEAD_SECONDS = 8;
/** The longest piece made by joining waiting ones. */
const LONGEST_JOINED = 800;

export class StreamingSpeaker implements ReplySpeaker {
  private items: Item[] = [];
  private next = 0;
  private nextStart = 0;
  private started = false;
  private finished = false;
  private cancelled = false;
  private making = false;
  private playingSources = new Set<AudioBufferSourceNode>();
  private idle = true;
  private done: Promise<void>;
  private resolveDone!: () => void;
  private gain: GainNode;
  private analyser: AnalyserNode;
  private meter: ReturnType<typeof setInterval> | null = null;
  private budgetTimer: ReturnType<typeof setTimeout> | null = null;
  /** The voice failed: this waits until what was already scheduled has played. */
  private unsaid: string[] | null = null;

  constructor(
    private readonly backend: SynthBackend,
    volume: number,
    private readonly hooks: SpeakerHooks = {},
    /** Online voices count requests: everything waiting goes into one. */
    private readonly joinWaiting = false,
  ) {
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
    const context = backend.context();
    this.gain = context.createGain();
    this.gain.gain.value = volume;
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 512;
    this.gain.connect(this.analyser);
    this.analyser.connect(context.destination);
  }

  get busy(): boolean {
    return !this.cancelled && (this.next < this.items.length || this.playingSources.size > 0);
  }

  enqueue(text: string, options: { first?: boolean; tag?: string } = {}): void {
    if (this.cancelled || this.finished || !text.trim()) return;
    if (this.unsaid) {
      if (options.first) this.unsaid.unshift(text);
      else this.unsaid.push(text);
      return;
    }
    const item: Item = { text, tag: options.tag ?? "reply", state: "waiting", buffer: null };
    // "first": before everything that hasn't started playing yet (the ack line).
    if (options.first) this.items.splice(this.next, 0, item);
    else this.items.push(item);
    const ready = this.backend.cached?.(text);
    if (ready) {
      // Made ahead: no need to wait behind a piece being synthesized.
      item.state = "making";
      this.backend
        .context()
        .decodeAudioData(ready)
        .then((buffer) => {
          if (this.cancelled) return;
          item.buffer = buffer;
          item.state = "ready";
          this.schedule();
        })
        .catch(() => {
          item.state = "waiting";
          void this.make();
        });
      return;
    }
    void this.make();
  }

  finish(): Promise<void> {
    this.finished = true;
    this.settle();
    return this.done;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const source of this.playingSources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    this.playingSources.clear();
    this.close();
  }

  /** Synthesizes waiting pieces in play order, one at a time, within the look-ahead budget. */
  private async make(): Promise<void> {
    if (this.making || this.cancelled) return;
    this.making = true;
    try {
      for (;;) {
        if (this.cancelled) return;
        const item = this.items.find((i) => i.state === "waiting");
        if (!item) return;
        const context = this.backend.context();
        if (this.started && this.nextStart - context.currentTime > LOOKAHEAD_SECONDS) {
          // Enough audio is queued; look again shortly.
          if (!this.budgetTimer) {
            this.budgetTimer = setTimeout(() => {
              this.budgetTimer = null;
              void this.make();
            }, 400);
          }
          return;
        }
        item.state = "making";
        if (this.joinWaiting) {
          const after = this.items.indexOf(item) + 1;
          while (this.items[after]?.state === "waiting" && this.items[after]!.tag === item.tag && item.text.length + this.items[after]!.text.length < LONGEST_JOINED) {
            item.text += ` ${this.items.splice(after, 1)[0]!.text}`;
          }
        }
        try {
          const wav = await this.backend.synth(item.text);
          if (this.cancelled) return;
          item.buffer = await context.decodeAudioData(wav);
          item.state = "ready";
        } catch {
          if (this.cancelled) return;
          this.fail(item);
          return;
        }
        this.schedule();
      }
    } finally {
      this.making = false;
    }
  }

  /** The voice failed: report everything not yet said, stop making more. */
  private fail(from: Item) {
    const index = this.items.indexOf(from);
    const unsaid = this.items.slice(index).filter((i) => i.state !== "scheduled").map((i) => i.text);
    for (const item of this.items.slice(index)) if (item.state !== "scheduled") item.state = "failed";
    this.items = this.items.filter((i) => i.state !== "failed");
    this.next = Math.min(this.next, this.items.length);
    this.unsaid = unsaid;
    this.settle();
  }

  /** Puts every ready piece (in order) on the timeline. */
  private schedule() {
    const context = this.backend.context();
    while (this.next < this.items.length && this.items[this.next]!.state === "ready") {
      const item = this.items[this.next]!;
      const now = context.currentTime;
      if (this.started && this.nextStart < now) this.hooks.onGap?.((now - this.nextStart) * 1000);
      const at = Math.max(now + 0.02, this.nextStart);
      const source = context.createBufferSource();
      source.buffer = item.buffer;
      source.connect(this.gain);
      source.onended = () => {
        this.playingSources.delete(source);
        this.settle();
      };
      source.start(at);
      this.playingSources.add(source);
      this.nextStart = at + item.buffer!.duration;
      this.hooks.onPiece?.(item.tag, item.text, (at - now) * 1000);
      item.state = "scheduled";
      item.buffer = null;
      this.next++;
      if (!this.started) {
        this.started = true;
        this.hooks.onFirstAudio?.();
      }
      if (this.idle) {
        this.idle = false;
        this.hooks.onAudio?.(true);
        this.startMeter();
      }
    }
  }

  /** Called whenever something ends: goes idle, and resolves once all is said. */
  private settle() {
    if (this.cancelled) return;
    if (this.playingSources.size === 0 && !this.idle) {
      this.idle = true;
      this.stopMeter();
      this.hooks.onAudio?.(false);
    }
    // After the pieces already playing: another voice mustn't talk over them.
    if (this.unsaid && this.playingSources.size === 0) {
      const unsaid = this.unsaid;
      this.unsaid = null;
      this.hooks.onFailed?.(unsaid);
    }
    if (this.finished && this.playingSources.size === 0 && this.next >= this.items.length) this.close();
  }

  private startMeter() {
    if (this.meter || !this.hooks.onLevel) return;
    const samples = new Uint8Array(this.analyser.fftSize);
    this.meter = setInterval(() => {
      this.analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += ((s - 128) / 128) ** 2;
      this.hooks.onLevel?.(Math.min(1, Math.sqrt(sum / samples.length) * 4));
    }, 70);
  }

  private stopMeter() {
    if (this.meter) clearInterval(this.meter);
    this.meter = null;
  }

  private close() {
    this.stopMeter();
    if (this.budgetTimer) clearTimeout(this.budgetTimer);
    this.budgetTimer = null;
    try {
      this.gain.disconnect();
      this.analyser.disconnect();
    } catch {
      // Already disconnected.
    }
    if (!this.idle) {
      this.idle = true;
      this.hooks.onAudio?.(false);
    }
    this.resolveDone();
  }
}

/** The same, with a Windows voice: the browser queues utterances itself. */
export class WindowsSpeaker implements ReplySpeaker {
  private pending = 0;
  private started = false;
  private finished = false;
  private cancelled = false;
  private playing = false;
  private done: Promise<void>;
  private resolveDone!: () => void;

  constructor(
    private readonly configure: (utterance: SpeechSynthesisUtterance) => void,
    private readonly hooks: SpeakerHooks = {},
  ) {
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
  }

  get busy(): boolean {
    return !this.cancelled && this.pending > 0;
  }

  enqueue(text: string, options: { first?: boolean; tag?: string } = {}): void {
    if (this.cancelled || this.finished || !text.trim() || typeof speechSynthesis === "undefined") return;
    const utterance = new SpeechSynthesisUtterance(text);
    this.configure(utterance);
    this.pending++;
    utterance.onstart = () => {
      if (this.cancelled) return;
      this.hooks.onPiece?.(options.tag ?? "reply", text, 0);
      if (!this.started) {
        this.started = true;
        this.hooks.onFirstAudio?.();
      }
      if (!this.playing) {
        this.playing = true;
        this.hooks.onAudio?.(true);
      }
    };
    // Each word makes the visualizer jump.
    utterance.onboundary = () => this.hooks.onLevel?.(0.6 + Math.random() * 0.4);
    const end = () => {
      this.pending = Math.max(0, this.pending - 1);
      if (this.pending === 0 && this.playing) {
        this.playing = false;
        if (!this.cancelled) this.hooks.onAudio?.(false);
      }
      this.settle();
    };
    utterance.onend = end;
    utterance.onerror = end;
    speechSynthesis.speak(utterance);
  }

  finish(): Promise<void> {
    this.finished = true;
    this.settle();
    return this.done;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    if (this.playing) {
      this.playing = false;
      this.hooks.onAudio?.(false);
    }
    this.resolveDone();
  }

  private settle() {
    if ((this.finished && this.pending === 0) || this.cancelled) this.resolveDone();
  }
}
