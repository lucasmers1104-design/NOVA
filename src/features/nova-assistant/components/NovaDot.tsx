import "../orb.css";
import "./nova-dot.css";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { AssistantState, DotLook } from "../types";
import { Sparkle } from "./Sparkle";

/** Pointer travel (px) that turns a press into a drag. */
export const DRAG_THRESHOLD = 4;
/** One breath of the idle glow; matches `nova-breathe` in nova-dot.css. */
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

/** Whether a look's color is light enough to need a dark sparkle. */
export function isLightColor(color: string): boolean {
  if (color === "white") return true;
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!hex) return false;
  const [r = 0, g = 0, b = 0] = hex.slice(1).map((h) => parseInt(h, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.62;
}

/** The CSS color for a look's `color` setting. */
export function dotColor(color: string): string {
  if (color === "white") return "#f3f4f8";
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  return "var(--nova-accent)";
}

interface NovaDotProps {
  look: DotLook;
  open: boolean;
  /** What NOVA AI is doing; animates the dot while it's busy. */
  state?: AssistantState;
  /** Audio level 0–1 while listening or speaking. */
  level?: number;
  onToggle: () => void;
  onMenu: () => void;
  /** Hand the drag to Windows, which moves the dot window. */
  onDragStart: () => void;
  /** Draw it as if pointed at (the Settings preview). */
  hovered?: boolean;
}

/** The floating NOVA dot: click to talk, drag to move, right-click for options. */
export function NovaDot({ look, open, state = "idle", level = 0, onToggle, onMenu, onDragStart, hovered = false }: NovaDotProps) {
  const press = useRef<{ x: number; y: number } | null>(null);
  const resting = state === "idle" || state === "completed";
  const breathing = useBreathing(look.breathe && look.glow && !open && resting);
  const label = open ? "Close NOVA AI" : "Talk to NOVA";

  return (
    <button
      type="button"
      className="nova-dot"
      data-style={look.style}
      data-tinted={look.color !== "accent"}
      data-light={isLightColor(look.color)}
      data-open={open}
      data-busy={!resting}
      data-glow={look.glow}
      data-activity={look.activity}
      data-breathing={breathing}
      data-state={state}
      data-hover={hovered || undefined}
      style={
        {
          "--dot": `${look.diameter}px`,
          "--dot-color": dotColor(look.color),
          "--idle": look.idleOpacity / 100,
          "--level": level,
        } as CSSProperties
      }
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
      {look.glow && <span className="nova-dot__glow" aria-hidden />}
      <span className="nova-dot__ring" aria-hidden />
      <span className="nova-dot__activity" aria-hidden />
      <span className={look.style === "orb" ? "nova-dot__body nova-orb" : "nova-dot__body"} aria-hidden>
        {look.icon && <Sparkle />}
      </span>
    </button>
  );
}
