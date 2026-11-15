import { type CSSProperties, type ReactNode, type Ref, useEffect, useMemo, useState } from "react";
import { Sparkle } from "@/features/nova-assistant/components/Sparkle";
import { type IslandActions, type IslandData, layoutOf } from "./data";
import { islandTone, islandVariables, type MorphCurve, morphCurves, motionTiming } from "./look";
import { AiOpen, CallOpen, CallRinging, Compact, Indicator, IslandActionsProvider, MusicOpen, NoticeOpen, Orb, SystemOpen } from "./modules";
import { type ContentKind, pillSize } from "./priority";
import type { IslandPrefs } from "./types";

/** What one layer of the pill shows, laid out at its own final size. */
interface Layer {
  key: string;
  kind: ContentKind | null;
  open: boolean;
  /** Music's lyrics as this layer last showed them: a layer fading out keeps its own. */
  lyrics: boolean;
  size: { width: number; height: number };
}

export interface IslandViewProps {
  prefs: IslandPrefs;
  data: IslandData;
  actions: IslandActions;
  /** The user opened the island (a ringing call opens it by itself). */
  expanded: boolean;
  lyrics: boolean;
  /** The pointer is over the pill. */
  hovered: boolean;
  onExpanded: (expanded: boolean) => void;
  onLyrics: (lyrics: boolean) => void;
  onHovered?: (hovered: boolean) => void;
  /** The pill's element; the visualizer's level is written onto it as `--level`. */
  pillRef?: Ref<HTMLDivElement>;
  /** The pill's size (logical px, before the size setting), whenever it changes. */
  onSize?: (size: { width: number; height: number }) => void;
  /** Island Studio: the side a dragged chip hovers over lights up. */
  slotHint?: "left" | "right" | null;
  /** Island Studio: something is being dragged onto the island. */
  dropHint?: boolean;
}

/**
 * Nova Island as a picture of its preferences and one moment's data: props in, pill
 * out. No Tauri calls and no timers of its own beyond the fade of replaced content,
 * so the island's window (IslandApp) and Island Studio's stage draw the very same thing.
 */
export function IslandView({ prefs, data, actions, expanded, lyrics, hovered, onExpanded, onLyrics, onHovered, pillRef, onSize, slotHint, dropHint }: IslandViewProps) {
  const { arrangement, ringing, showDot } = layoutOf(prefs, data);
  const primary = arrangement.primary;
  const open = (expanded || ringing) && primary !== null;
  const timing = useMemo(() => motionTiming(prefs.motion), [prefs.motion]);
  const variables = useMemo(() => islandVariables(prefs), [prefs.theme, prefs.look, prefs.motion]);

  // The window has room for the largest pill and never moves: the pill morphs inside it.
  const slots = primary ? prefs.slots[primary] : undefined;
  const target = useMemo(
    () => pillSize(arrangement, open, { dot: showDot, lyrics, ringing, slots, closedHeight: prefs.look.closedHeight }),
    [arrangement.primary, arrangement.secondary, open, showDot, lyrics, ringing, slots?.left, slots?.right, prefs.look.closedHeight],
  );
  useEffect(() => {
    onSize?.(target);
  }, [target, onSize]);

  // Each axis eases by its direction: spring while growing, no overshoot while shrinking.
  // Worked out during render, so the curve lands in the same commit as the new size.
  const [morph, setMorph] = useState<{ width: number; height: number; curves: { width: MorphCurve; height: MorphCurve } }>(() => ({
    ...target,
    curves: { width: "spring", height: "spring" },
  }));
  if (morph.width !== target.width || morph.height !== target.height) {
    setMorph({ ...target, curves: morphCurves(morph, target) });
  }
  const curve = (axis: MorphCurve) => (axis === "settle" ? "var(--island-ease)" : "var(--island-spring)");

  // Closed with the pointer still on it (a click on the pill): no hover lift until the
  // pointer has left once, or the lift would pulse into the collapse.
  const [wasOpen, setWasOpen] = useState(open);
  const [held, setHeld] = useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    setHeld(!open && hovered);
  } else if (held && !hovered) {
    setHeld(false);
  }

  // Content is laid out at its final size at once and revealed by the growing pill, so
  // nothing reflows mid-morph. What it replaces fades out on top instead of vanishing.
  const layer: Layer = { key: primary ? `${primary}:${open}` : "idle", kind: primary, open, lyrics, size: target };
  // Worked out during render (React's "state from the previous render"), not in an
  // effect: a render without the old layer would unmount it before it could fade.
  const [shown, setShown] = useState(layer);
  const [leaving, setLeaving] = useState<Layer[]>([]);
  if (shown.key !== layer.key) {
    setLeaving((now) => [...now.filter((l) => l.key !== shown.key && l.key !== layer.key), shown].slice(-2));
    setShown(layer);
  } else if (shown.size !== layer.size || shown.lyrics !== layer.lyrics) {
    // Same view, new size (lyrics opened, a slot changed): it leaves as it last looked.
    setShown(layer);
  }
  useEffect(() => {
    if (leaving.length === 0) return;
    const timer = setTimeout(() => setLeaving((now) => now.filter((l) => !leaving.includes(l))), timing.leave);
    return () => clearTimeout(timer);
  }, [leaving, timing.leave]);

  const toggle = () => {
    if (ringing) return;
    if (primary) onExpanded(!expanded);
    else actions.openAssistant();
  };

  const content = (kind: ContentKind, opened: boolean, withLyrics: boolean): ReactNode => {
    if (!opened && !(kind === "call" && ringing)) return <Compact kind={kind} data={data} prefs={prefs} dot={showDot} />;
    switch (kind) {
      case "music":
        return <MusicOpen media={data.media} lyrics={withLyrics} onLyrics={() => onLyrics(!lyrics)} />;
      case "notification":
        return data.notice ? <NoticeOpen notice={data.notice} /> : null;
      case "call":
        if (!data.call) return null;
        return data.call.state === "ringing" ? <CallRinging call={data.call} error={data.callError} /> : <CallOpen call={data.call} since={data.callSince} />;
      case "system":
        return <SystemOpen load={data.load} />;
      case "ai":
        return <AiOpen state={data.ai.state} level={data.ai.level} task={data.aiNote.task} reply={data.aiReplyShown ? data.aiNote.reply : ""} />;
    }
  };

  const label = primary ? (open ? "Nova Island schließen" : "Nova Island öffnen") : "Mit NOVA sprechen";

  const renderLayer = (l: Layer, leavingNow: boolean) => (
    <div
      key={l.key}
      className="island-layer"
      data-open={l.open || (l.kind === "call" && ringing)}
      data-leaving={leavingNow || undefined}
      aria-hidden={leavingNow || undefined}
      style={{ width: l.size.width, height: l.size.height }}
    >
      {showDot && l.kind !== null && !l.open && !(l.kind === "call" && ringing) && (
        <button
          type="button"
          className="island-dot"
          aria-label="Mit NOVA sprechen"
          title="Mit NOVA sprechen"
          tabIndex={leavingNow ? -1 : 0}
          onClick={(event) => {
            event.stopPropagation();
            actions.openAssistant();
          }}
        >
          <Orb state={data.ai.state} level={data.ai.level} size={20} />
        </button>
      )}
      {showDot && l.kind === null && (
        <span className="island-dot" aria-hidden>
          <Orb state={data.ai.state} level={data.ai.level} size={20} />
        </span>
      )}
      {l.kind ? (
        <div className="island-main">{content(l.kind, l.open, l.lyrics)}</div>
      ) : (
        !showDot && (
          <div className="island-main island-idle">
            <Sparkle className="island-sparkle" />
          </div>
        )
      )}
      {!l.open && !leavingNow && arrangement.secondary && l.key === layer.key && (
        <span className="island-secondary" key={arrangement.secondary}>
          <Indicator kind={arrangement.secondary} data={data} />
        </span>
      )}
    </div>
  );

  return (
    <IslandActionsProvider value={actions}>
      <div className="island-stage" data-anchor={prefs.anchor} data-motion-style={prefs.motion.style} style={variables as CSSProperties}>
        <div
          ref={pillRef}
          className="island"
          data-theme={prefs.theme}
          data-tone={islandTone(prefs)}
          data-open={open}
          data-ringing={ringing || undefined}
          data-empty={!primary || undefined}
          data-hovered={(hovered && !held) || undefined}
          data-slot-hint={slotHint ?? undefined}
          data-drop-hint={dropHint || undefined}
          style={{ width: target.width, height: target.height, "--island-curve-w": curve(morph.curves.width), "--island-curve-h": curve(morph.curves.height) } as CSSProperties}
          role="button"
          tabIndex={0}
          aria-label={label}
          aria-expanded={open}
          title={primary ? undefined : label}
          onPointerEnter={() => onHovered?.(true)}
          onPointerLeave={() => onHovered?.(false)}
          onClick={toggle}
          onKeyDown={(event) => {
            if (event.key === "Escape") onExpanded(false);
            // Only the pill's own keys: Space on a button inside must stay that button's.
            if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              toggle();
            }
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            actions.menu();
          }}
        >
          {/* One keyed list: the layer being replaced keeps its element and just fades out. */}
          {[...leaving.map((l) => ({ l, out: true })), { l: layer, out: false }].map(({ l, out }) => renderLayer(l, out))}
        </div>
      </div>
    </IslandActionsProvider>
  );
}
