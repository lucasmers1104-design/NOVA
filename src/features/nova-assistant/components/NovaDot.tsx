import { type CSSProperties, useEffect, useRef, useState } from "react";
import { type AssistantState, DOT_DIAMETER, type DotSize } from "../types";
import { Sparkle } from "./Sparkle";

/** Pointer travel (px) that turns a press into a drag. */
export const DRAG_THRESHOLD = 4;
/** One breath of the idle glow; matches `nova-breathe` in dot.css. */
export const BREATH_MS = 5000;
/** Rest between breaths while idle. */
export const REST_MS = 60_000;

/**
 * Whether the idle glow is breathing right now. A running animation makes the
 * transparent window composite every frame (measured ~9 % CPU on a dual-core
 * laptop), so the dot breathes twice when it settles, then once a minute, and
 * rests in between. Each burst lasts whole breaths, so it ends exactly on the
 * resting pose and never jumps.
 */
export function useBreathing(active: boolean): boolean {
  const [breathing, setBreathing] = useState(false);
  useEffect(() => {
    if (!active) {
      setBreathing(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const breathe = (breaths: number) => {
      setBreathing(true);
      timer = setTimeout(() => {
        setBreathing(false);
        timer = setTimeout(() => breathe(1), REST_MS);
      }, breaths * BREATH_MS);
    };
    breathe(2);
    return () => clearTimeout(timer);
  }, [active]);
  return breathing;
}

interface NovaDotProps {
  size: DotSize;
  open: boolean;
  /** What NOVA AI is doing; animates the dot while it's busy. */
  state?: AssistantState;
  /** Audio level 0–1 while listening or speaking. */
  level?: number;
  onToggle: () => void;
  onMenu: () => void;
  /** Hand the drag to Windows, which moves the dot window. */
  onDragStart: () => void;
}

/** The floating NOVA dot: click to talk, drag to move, right-click for options. */
export function NovaDot({ size, open, state = "idle", level = 0, onToggle, onMenu, onDragStart }: NovaDotProps) {
  const press = useRef<{ x: number; y: number } | null>(null);
  const resting = state === "idle" || state === "completed";
  const breathing = useBreathing(!open && resting);
  const label = open ? "Close NOVA AI" : "Talk to NOVA";

  return (
    <button
      type="button"
      className="nova-dot"
      data-open={open}
      data-breathing={breathing}
      data-state={state}
      style={{ "--dot": `${DOT_DIAMETER[size]}px`, "--level": level } as CSSProperties}
      aria-label={label}
      aria-expanded={open}
      title={label}
      onPointerDown={(event) => {
        if (event.button === 0) press.current = { x: event.screenX, y: event.screenY };
      }}
      onPointerMove={(event) => {
        const start = press.current;
        if (!start || (event.buttons & 1) === 0) return;
        if (Math.hypot(event.screenX - start.x, event.screenY - start.y) > DRAG_THRESHOLD) {
          press.current = null;
          onDragStart();
        }
      }}
      onPointerUp={(event) => {
        if (event.button !== 0 || !press.current) return;
        press.current = null;
        onToggle();
      }}
      onPointerCancel={() => {
        press.current = null;
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle();
        }
      }}
    >
      <span className="nova-dot__glow" aria-hidden />
      <span className="nova-dot__halo" aria-hidden />
      <span className="nova-dot__ring" aria-hidden />
      <span className="nova-dot__activity" aria-hidden />
      <span className="nova-orb" aria-hidden>
        <Sparkle />
      </span>
    </button>
  );
}
