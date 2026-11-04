import { Check, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

/** Bars on each side of the centre; the newest level sits in the middle. */
const HALF = 18;
/** How often the level moves one bar outwards. */
const STEP_MS = 45;

interface NovaVoiceLineProps {
  /** Microphone level 0–1 (about 20 updates a second). */
  level: number;
  /** Still listening (false while the words are being finished). */
  active: boolean;
  /** The microphone is open (it takes a moment after the line appears). */
  ready: boolean;
  transcript: string;
  /** Finish now and send what was said. */
  onDone: () => void;
  /** Stop without sending. */
  onCancel: () => void;
  /** Show the prompts in German. */
  german: boolean;
}

/**
 * The voice line shown while NOVA listens: bars that jump up when you speak
 * and sink back slowly when you're quiet, like a studio level meter, with
 * the words understood so far above them. Animates only while it's shown.
 */
export function NovaVoiceLine({ level, active, ready, transcript, onDone, onCancel, german }: NovaVoiceLineProps) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const target = useRef(level);
  target.current = active ? level : 0;

  useEffect(() => {
    const history = new Array<number>(HALF + 1).fill(0);
    let smooth = 0;
    let lastStep = performance.now();
    let frame = requestAnimationFrame(function draw(now) {
      // Fast attack, slow release.
      const goal = Math.min(1, Math.sqrt(target.current) * 1.6);
      smooth = goal > smooth ? smooth + (goal - smooth) * 0.55 : smooth * 0.94 + goal * 0.06;
      if (now - lastStep >= STEP_MS) {
        history.unshift(smooth);
        history.pop();
        lastStep = now;
      } else {
        history[0] = Math.max(history[0]!, smooth);
      }
      bars.current.forEach((bar, i) => {
        if (!bar) return;
        const distance = Math.abs(i - HALF);
        const value = history[distance]! * (1 - (distance / HALF) * 0.45);
        bar.style.transform = `scaleY(${Math.max(0.08, value).toFixed(3)})`;
      });
      frame = requestAnimationFrame(draw);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="px-3 pt-1 pb-3">
      <div className="rounded-[20px] bg-white/[0.055] px-4 pt-3 pb-2.5 ring-1 ring-accent/30" role="group" aria-label="NOVA is listening">
        <p className={cn("min-h-[20px] text-[13.5px] leading-snug", transcript ? "text-fg" : "text-fg-muted")} aria-live="polite">
          {transcript || (active && ready ? (german ? "Ich höre zu …" : "Listening …") : german ? "Einen Moment …" : "One moment …")}
        </p>
        <div className="mt-2 flex items-center gap-3">
          <div className="flex h-11 flex-1 items-center justify-center gap-[3px]" aria-hidden>
            {Array.from({ length: HALF * 2 + 1 }, (_, i) => (
              <span
                key={i}
                ref={(el) => {
                  bars.current[i] = el;
                }}
                className="h-full w-[3px] origin-center rounded-full bg-gradient-to-b from-accent-text to-accent will-change-transform"
                style={{ transform: "scaleY(0.08)", opacity: 0.55 + 0.45 * (1 - Math.abs(i - HALF) / HALF) }}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            title="Cancel (nothing is sent)"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-white/[0.08] hover:text-fg"
          >
            <X size={15} aria-hidden />
          </button>
          <button
            type="button"
            onClick={onDone}
            disabled={!active}
            aria-label="Done, send it"
            title="Done — send it now"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-50"
          >
            <Check size={15} aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
