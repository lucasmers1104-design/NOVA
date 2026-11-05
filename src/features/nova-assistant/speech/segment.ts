/**
 * Cuts a reply that is still streaming in into pieces NOVA can say one after
 * another: whole sentences, as soon as each one is certainly complete. A full
 * stop only ends a sentence when the next character proves it (an uppercase
 * letter or digit after a space), so "z. B.", "3. Mai", "2,5" and "v1.4"
 * stay in one piece. The first piece is kept short so NOVA starts talking
 * early; code blocks and tables are left out.
 */

export interface SegmenterOptions {
  /** The first piece is cut at a comma once it gets this long without a sentence end. */
  firstSoftLimit?: number;
  /** …and at a space once it gets this long. */
  firstHardLimit?: number;
  /** Later pieces never get longer than this. */
  longest?: number;
  /** Later sentences shorter than this ride along with the next one. */
  joinBelow?: number;
  /** Said once when the reply contains code (null: nothing). */
  codeNote?: string | null;
}

/** Words that end in a full stop without ending the sentence. */
const ABBREVIATIONS = new Set([
  "bzw", "ca", "usw", "etc", "vgl", "ggf", "evtl", "inkl", "exkl", "zzgl", "nr", "dr", "prof", "hr", "str", "mio", "mrd", "tsd", "jh", "abs", "kap",
  "bspw", "sog", "max", "mind", "ggü", "bzgl", "lt", "gem", "zb", "dh", "ua", "uu", "oä", "od", "allg", "insb", "jew", "tel", "mr", "mrs", "ms", "vs", "approx",
  "jan", "feb", "mär", "apr", "jun", "jul", "aug", "sep", "sept", "okt", "nov", "dez",
]);
/** Abbreviations that are only abbreviations when capitalized ("Mo." but not "so."). */
const CAPITALIZED_ABBREVIATIONS = new Set(["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So", "St", "Bd", "Hrsg"]);
const MONTHS = /^(Januar|Jänner|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\b/;

const OPENING_PUNCTUATION = /["„“‚'(\[»«]/;

export class SentenceSegmenter {
  private buffer = "";
  private inFence = false;
  private noted = false;
  private emitted = 0;
  /** A short sentence waiting for the next one. */
  private held: string | null = null;
  private readonly firstSoftLimit: number;
  private readonly firstHardLimit: number;
  private readonly longest: number;
  private readonly joinBelow: number;
  private readonly codeNote: string | null;

  constructor(options: SegmenterOptions = {}) {
    this.firstSoftLimit = options.firstSoftLimit ?? 100;
    this.firstHardLimit = options.firstHardLimit ?? 160;
    this.longest = options.longest ?? 220;
    this.joinBelow = options.joinBelow ?? 24;
    this.codeNote = options.codeNote ?? null;
  }

  /** Adds streamed text; returns the pieces that are complete now. */
  push(text: string): string[] {
    this.buffer += text;
    return this.drain(false);
  }

  /** What has come so far is complete (a tool starts, or a new paragraph). */
  boundary(): string[] {
    const out = this.drain(true);
    return this.flushHeld(out);
  }

  /** The reply is complete. */
  finish(): string[] {
    return this.boundary();
  }

  private flushHeld(out: string[]): string[] {
    if (this.held !== null) {
      out.push(this.held);
      this.held = null;
    }
    return out;
  }

  /** Hands a finished piece out, joining very short later sentences (not across line breaks). */
  private emit(out: string[], raw: string) {
    const hard = /\n\s*$/.test(raw);
    const piece = clean(raw);
    if (!piece) return;
    if (this.emitted === 0) {
      this.emitted++;
      out.push(piece);
      return;
    }
    let text = piece;
    if (this.held !== null) {
      if (this.held.length + 1 + text.length <= this.longest) text = `${this.held} ${text}`;
      else out.push(this.held);
      this.held = null;
    }
    this.emitted++;
    if (!hard && text.length < this.joinBelow) this.held = text;
    else out.push(text);
  }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      if (this.inFence) {
        const close = this.buffer.indexOf("```");
        if (close < 0) {
          // Keep a possible half-arrived fence marker.
          this.buffer = final ? "" : this.buffer.slice(-2);
          if (final) this.inFence = false;
          return out;
        }
        const lineEnd = this.buffer.indexOf("\n", close + 3);
        this.buffer = lineEnd < 0 ? this.buffer.slice(close + 3) : this.buffer.slice(lineEnd + 1);
        this.inFence = false;
        continue;
      }
      const fence = this.buffer.indexOf("```");
      const region = fence < 0 ? this.buffer : this.buffer.slice(0, fence);
      const end = findBreak(region, final && fence < 0);
      if (end !== null) {
        this.emit(out, region.slice(0, end));
        this.buffer = this.buffer.slice(end);
        continue;
      }
      if (fence >= 0) {
        this.emit(out, region);
        this.buffer = this.buffer.slice(fence + 3);
        this.inFence = true;
        if (this.codeNote && !this.noted) {
          this.noted = true;
          this.flushHeld(out);
          this.emit(out, this.codeNote);
        }
        continue;
      }
      if (final) {
        this.emit(out, this.buffer);
        this.buffer = "";
        return out;
      }
      // No sentence end yet: cut long text so NOVA doesn't wait for it.
      const cut = this.longCut(this.buffer);
      if (cut === null) return out;
      this.emit(out, this.buffer.slice(0, cut));
      this.buffer = this.buffer.slice(cut);
    }
  }

  private longCut(text: string): number | null {
    const first = this.emitted === 0;
    const soft = first ? this.firstSoftLimit : this.longest;
    const hard = first ? this.firstHardLimit : this.longest;
    if (text.length < soft) return null;
    const window = text.slice(0, hard);
    const min = first ? 30 : Math.floor(this.longest / 3);
    let best = -1;
    for (const mark of [", ", " – ", " - ", ": ", "; "]) best = Math.max(best, window.lastIndexOf(mark));
    if (best >= min) return best + 1;
    if (text.length < hard) return null;
    const space = window.lastIndexOf(" ");
    return space >= min ? space + 1 : hard;
  }
}

/** Removes table rows and list markers; keeps the words. */
function clean(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*\|/.test(line) && !/^\s*[-:| ]{3,}\s*$/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Where the first complete piece of `text` ends (exclusive), or null. A line
 * break always ends a piece; a sentence end only when what follows proves it.
 * `final`: nothing more will come, so a trailing sentence end counts.
 */
export function findBreak(text: string, final = false): number | null {
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\n") {
      if (text.slice(0, i).trim()) return i + 1;
      continue;
    }
    if (c !== "." && c !== "!" && c !== "?" && c !== "…") continue;
    // The whole run of punctuation and closing quotes/brackets belongs to this sentence.
    let j = i + 1;
    while (j < text.length && /[.!?…"“”'’)\]»]/.test(text[j]!)) j++;
    if (j >= text.length) {
      if (final) return null; // the rest is flushed whole anyway
      return null;
    }
    if (!/\s/.test(text[j]!)) {
      i = j - 1;
      continue; // "2.5", "v1.4", "example.com"
    }
    let k = j;
    while (k < text.length && /[ \t]/.test(text[k]!)) k++;
    if (k >= text.length) return null; // the next character decides
    const next = text[k]!;
    if (next === "\n") return k + 1;
    // "vom 3. M…": whether this is a date ("3. Mai") shows once the word is complete.
    if (c === "." && /\d$/.test(text.slice(0, i)) && /^\p{L}+$/u.test(text.slice(k))) return null;
    if (c === "." && !endsSentence(text.slice(0, i), text.slice(k))) {
      i = j - 1;
      continue;
    }
    if ((c === "." && text[i + 1] === ".") || c === "…") {
      // "Nun ja… mal sehen" goes on in lowercase.
      if (/\p{Ll}/u.test(next)) {
        i = j - 1;
        continue;
      }
    }
    if (/[\p{Lu}\d]/u.test(next) || OPENING_PUNCTUATION.test(next) || /[*_#•-]/.test(next)) return k;
    i = j - 1;
  }
  return null;
}

/** Whether a full stop after `before` ends the sentence, given the text `after` it. */
function endsSentence(before: string, after: string): boolean {
  const word = /(\S+)$/.exec(before)?.[1] ?? "";
  const bare = word.replace(/^["„“‚'(\[»«]+/, "");
  if (!bare) return true;
  // "z.B", "d.h", "u.a", "e.g": inner dots mean an abbreviation.
  if (/^\p{L}{1,3}(\.\p{L}{1,3})+$/u.test(bare)) return false;
  // Single letters: initials and "z. B." / "d. h.".
  if (/^\p{L}$/u.test(bare)) return false;
  if (ABBREVIATIONS.has(bare.toLowerCase())) return false;
  if (CAPITALIZED_ABBREVIATIONS.has(bare)) return false;
  // "1. Foo" at the start of a line is a numbered list item.
  if (/(^|\n)[ \t]*\d{1,3}$/.test(before)) return false;
  if (/^\d{1,2}$/.test(bare)) {
    // "3. Mai", "am 3. und 4."; a date like "03.11." has no space and never gets here.
    if (MONTHS.test(after) || /^\p{Ll}/u.test(after)) return false;
  }
  return true;
}
