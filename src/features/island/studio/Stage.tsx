import { Monitor, Move, Pause, Play } from "lucide-react";
import { animate, useMotionValue, motion } from "motion/react";
import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PreviewStage, SegmentedControl, type StageBackdrop } from "@/components/settings-kit";
import { Switch } from "@/components/ui/Switch";
import { notifyError } from "@/features/notifications/store";
import { cn } from "@/lib/cn";
import { previewIsland } from "../api";
import { EMPTY_DATA, type IslandActions, type IslandData, layoutOf } from "../data";
import { useDemoLevel, useMedia } from "../hooks";
import { IslandView } from "../IslandView";
import { Orb } from "../modules";
import { DEMO_LYRICS, SCENE_MODULE, SCENES, sceneById } from "../scenes";
import type { IslandAnchor, IslandPrefs, SceneId } from "../types";
import { clampCenter, magnet, restCenter, settle, SIDE_GAP } from "./position";
import type { UpdatePrefs } from "./useStudioPrefs";

/** A scene of the stage: one of the island's, or what really plays on this PC right now. */
export type StageScene = SceneId | "live";

export interface Playing {
  id: StageScene;
  /** When it started; a new number restarts the scene. */
  startedAt: number;
  /** Start with the island closed, whatever the scene would do (for setting the closed pill's slots). */
  closed?: boolean;
}

interface StageProps {
  prefs: IslandPrefs;
  update: UpdatePrefs;
  playing: Playing;
  onScene: (scene: StageScene) => void;
  /** The pill on the stage, for whoever needs to know where it is (the slot editor). */
  pillRef: RefObject<HTMLDivElement | null>;
  slotHint: "left" | "right" | null;
  /** The real island can be reached (NOVA's desktop app, not the browser preview). */
  desktop: boolean;
}

const BACKDROPS = [
  { value: "nova", label: "NOVA" },
  { value: "dusk", label: "Dunkel" },
  { value: "daylight", label: "Hell" },
] as const satisfies readonly { value: StageBackdrop; label: string }[];

const SPRING = { type: "spring", stiffness: 520, damping: 30, mass: 0.9 } as const;
/** A pointer must travel this far (px) before a press becomes a drag. */
const DRAG_START = 4;
const AUTO_DEMO_MS = 2800;
const ANCHOR_LABEL: Record<IslandAnchor, string> = { left: "Links", center: "Mitte", right: "Rechts" };

interface View {
  key: number;
  expanded: boolean;
  lyrics: boolean;
  /** The demo song was paused at this position (ms). */
  pausedAt: number | null;
}

/**
 * Island Studio's stage: the top of a desktop with the real island on it. Drag the
 * island along the edge, drag the NOVA dot in or out, click the island to open it,
 * and play every scene with the transitions the real one makes.
 */
export function Stage({ prefs, update, playing, onScene, pillRef, slotHint, desktop }: StageProps) {
  const [backdrop, setBackdrop] = useState<StageBackdrop>("nova");
  const [auto, setAuto] = useState(false);
  const [mirror, setMirror] = useState(false);
  const scene = playing.id === "live" ? null : sceneById(playing.id);

  // A new scene starts in its own state; worked out during render, so the island never
  // shows the new scene in the old one's state for a frame.
  const fresh = (): View => ({ key: playing.startedAt, expanded: !playing.closed && (scene?.expanded ?? false), lyrics: !playing.closed && (scene?.lyrics ?? false), pausedAt: null });
  const [view, setView] = useState<View>(fresh);
  const current = view.key === playing.startedAt ? view : fresh();
  if (view.key !== playing.startedAt) setView(current);

  const live = useMedia(playing.id === "live");
  const data: IslandData = useMemo(() => {
    if (!scene) return { ...EMPTY_DATA, media: live };
    const base = scene.data(playing.startedAt);
    const song = base.media.state;
    if (!song || current.pausedAt === null) return base;
    return { ...base, media: { ...base.media, state: { ...song, status: "paused", positionMs: current.pausedAt } } };
  }, [scene, playing.startedAt, current.pausedAt, live]);

  // The scene's module shows even while it is switched off, so every scene can be seen.
  const needed = scene ? SCENE_MODULE[scene.id] : "music";
  const shown = useMemo(() => (needed && !prefs.modules[needed] ? { ...prefs, modules: { ...prefs.modules, [needed]: true } } : prefs), [prefs, needed]);
  const layout = layoutOf(shown, data);

  const actions: IslandActions = useMemo(
    () => ({
      mediaControl: (action) => {
        if (action !== "toggle") return;
        setView((now) => {
          if (now.pausedAt !== null) return { ...now, pausedAt: null };
          const song = sceneById(playing.id === "live" ? "idle" : playing.id).data(playing.startedAt).media.state;
          return song ? { ...now, pausedAt: Math.min(song.durationMs ?? 0, (song.positionMs ?? 0) + Date.now() - song.sampledAtMs) } : now;
        });
      },
      lyrics: async () => [...DEMO_LYRICS],
      // The stage answers its own made-up call.
      callAction: (_callId, action) => onScene(action === "accept" ? "call" : "idle"),
      talk: () => {},
      openAssistant: () => {},
      menu: () => {},
    }),
    [playing.id, playing.startedAt, onScene],
  );

  useDemoLevel(layout.musicOnScreen && data.media.state?.status === "playing", pillRef);

  // Auto demo: every scene in turn.
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => {
      const index = SCENES.findIndex((s) => s.id === playing.id);
      onScene(SCENES[(index + 1) % SCENES.length]!.id);
    }, AUTO_DEMO_MS);
    return () => clearInterval(timer);
  }, [auto, playing.id, onScene]);

  // "Also on the desktop": the real island plays the scene for ten seconds.
  useEffect(() => {
    if (!mirror || !desktop || playing.id === "live") return;
    previewIsland(playing.id).catch((error: unknown) => {
      setMirror(false);
      notifyError("Die Island auf dem Desktop ist nicht erreichbar", error);
    });
  }, [mirror, desktop, playing.id, playing.startedAt]);
  useEffect(() => {
    if (!mirror || !desktop) return;
    return () => void previewIsland(null).catch(() => {});
  }, [mirror, desktop]);

  // ------------------------------------------------------------------------
  // Dragging the island along the top edge
  // ------------------------------------------------------------------------
  const stage = useRef<HTMLDivElement>(null);
  const x = useMotionValue(prefs.offset);
  const press = useRef<{ startX: number; startY: number; base: number; moved: boolean } | null>(null);
  const [guide, setGuide] = useState<IslandAnchor | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  /** The pill's width when the drag began: the snap guides stand where its center would rest. */
  const [guideWidth, setGuideWidth] = useState(200);
  /** A drag ends with a click on what was dragged; that click must not also open the island. */
  const swallowClick = useRef(false);

  const measure = useCallback(() => {
    const stageRect = stage.current?.getBoundingClientRect();
    const pillRect = pillRef.current?.getBoundingClientRect();
    return stageRect && pillRect ? { stageWidth: stageRect.width, pillWidth: pillRect.width } : null;
  }, [pillRef]);

  // Wherever a new place comes from (a drag, the keyboard, the buttons, undo, a preset):
  // the island glides there from where it is. A new anchor moves the layout at once, so
  // the shift is first set to what keeps the pill where it was, in the same frame, and
  // only then springs to the offset.
  const wrapper = useRef<HTMLDivElement>(null);
  const anchored = useRef(prefs.anchor);
  useLayoutEffect(() => {
    if (press.current?.moved) return;
    const sizes = measure();
    if (sizes && anchored.current !== prefs.anchor) {
      const center = restCenter(anchored.current, sizes.stageWidth, sizes.pillWidth) + x.get();
      const kept = center - restCenter(prefs.anchor, sizes.stageWidth, sizes.pillWidth);
      x.jump(kept);
      // Motion writes on its next frame; this write is for the frame being painted now.
      if (wrapper.current) wrapper.current.style.transform = `translateX(${kept}px)`;
    }
    anchored.current = prefs.anchor;
    animate(x, prefs.offset, SPRING);
  }, [x, prefs.offset, prefs.anchor, measure]);

  const place = useCallback(
    (center: number, sizes: { stageWidth: number; pillWidth: number }) => {
      const next = settle(center, sizes.stageWidth, sizes.pillWidth);
      update((now) => ({ ...now, anchor: next.anchor, offset: next.offset }), "position");
      // Dropped where it already belongs: nothing changes above, so glide back from here.
      animate(x, next.offset, SPRING);
    },
    [x, update],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    // Buttons on the island keep their clicks; the island's own dot has its own drag.
    if (event.button !== 0 || target.closest("button, .island-lyrics")) return;
    press.current = { startX: event.clientX, startY: event.clientY, base: x.get(), moved: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const now = press.current;
    const sizes = measure();
    if (!now || !sizes) return;
    const dx = event.clientX - now.startX;
    if (!now.moved && Math.hypot(dx, event.clientY - now.startY) < DRAG_START) return;
    if (!now.moved) {
      now.moved = true;
      setDragging(true);
      setGuideWidth(sizes.pillWidth);
      // Only now: a captured pointer's click goes to the capturing element, and a plain
      // click must still reach the island to open it.
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const rest = restCenter(prefs.anchor, sizes.stageWidth, sizes.pillWidth);
    const pulled = magnet(clampCenter(rest + now.base + dx, sizes.stageWidth, sizes.pillWidth), sizes.stageWidth, sizes.pillWidth);
    x.set(pulled.center - rest);
    setGuide(pulled.anchor);
  };
  const onPointerUp = () => {
    const now = press.current;
    const sizes = measure();
    press.current = null;
    setGuide(null);
    if (!now?.moved) return;
    swallowClick.current = true;
    setTimeout(() => {
      swallowClick.current = false;
      setDragging(false);
    }, 0);
    if (sizes) place(restCenter(prefs.anchor, sizes.stageWidth, sizes.pillWidth) + x.get(), sizes);
  };

  // The same with the keyboard: Space picks the island up, the arrows move it.
  const [held, setHeld] = useState<{ anchor: IslandAnchor; offset: number } | null>(null);
  const toggleHeld = () => {
    const sizes = measure();
    if (sizes) setGuideWidth(sizes.pillWidth);
    setHeld(held ? null : { anchor: prefs.anchor, offset: prefs.offset });
  };
  const onGripKey = (event: KeyboardEvent) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      toggleHeld();
    } else if (held && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      const sizes = measure();
      if (!sizes) return;
      const step = (event.shiftKey ? 48 : 12) * (event.key === "ArrowLeft" ? -1 : 1);
      const rest = restCenter(prefs.anchor, sizes.stageWidth, sizes.pillWidth);
      place(clampCenter(rest + prefs.offset + step, sizes.stageWidth, sizes.pillWidth), sizes);
    } else if (held && event.key === "Escape") {
      event.preventDefault();
      update((now) => ({ ...now, anchor: held.anchor, offset: held.offset }), "position");
      setHeld(null);
    }
  };

  // ------------------------------------------------------------------------
  // Dragging the NOVA dot into the island or out of it
  // ------------------------------------------------------------------------
  const [dot, setDot] = useState<{ from: "desk" | "island"; x: number; y: number; over: boolean } | null>(null);
  const dotInIsland = prefs.mode === "islandOnly" && prefs.dotInIsland;

  const startDotDrag = (from: "desk" | "island", event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    const start = { x: event.clientX, y: event.clientY };
    let moved = false;
    const overIsland = (clientX: number, clientY: number) => {
      const rect = pillRef.current?.getBoundingClientRect();
      return Boolean(rect && clientX >= rect.left - 12 && clientX <= rect.right + 12 && clientY >= rect.top - 12 && clientY <= rect.bottom + 12);
    };
    const onMove = (move: PointerEvent) => {
      if (!moved && Math.hypot(move.clientX - start.x, move.clientY - start.y) < DRAG_START) return;
      moved = true;
      setDot({ from, x: move.clientX, y: move.clientY, over: overIsland(move.clientX, move.clientY) });
    };
    const onUp = (up: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDot(null);
      if (!moved) return;
      const over = overIsland(up.clientX, up.clientY);
      if (from === "desk" && over) update((now) => ({ ...now, mode: "islandOnly", dotInIsland: true }), "dot");
      if (from === "island" && !over) update((now) => ({ ...now, mode: "dotAndIsland" }), "dot");
      swallowClick.current = true;
      setTimeout(() => {
        swallowClick.current = false;
      }, 0);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Tall enough for whatever the island grows to, at its size setting.
  const [pillHeight, setPillHeight] = useState(38);
  const onSize = useCallback((size: { height: number }) => setPillHeight(size.height), []);
  const height = Math.max(250, Math.round((pillHeight * prefs.look.scale) / 100) + 96);

  const choose = (id: StageScene) => {
    setAuto(false);
    onScene(id);
  };

  return (
    // A fragment, not a wrapper: the stage must be a direct child of the page's column,
    // or its sticky range would end with the wrapper and it would scroll away.
    <>
      <PreviewStage
        label="Vorschau: Nova Island am oberen Bildschirmrand"
        backdrop={backdrop}
        taskbar
        height={height}
        // Stays in view while the cards below scroll: a slider is only fun with the island in sight.
        sticky
        className="transition-[height] duration-300 ease-nova"
        corner={<SegmentedControl label="Hintergrund der Bühne" value={backdrop} options={BACKDROPS} onChange={setBackdrop} />}
      >
        <div ref={stage} className="absolute inset-0">
          {/* Where the island snaps: shown while it is dragged, the one it would take lit up. */}
          {(dragging || held) &&
            (["left", "center", "right"] as const).map((anchor) => (
              <span
                key={anchor}
                aria-hidden
                className={cn("pointer-events-none absolute top-2 h-10 w-px transition-colors", guide === anchor ? "bg-accent-text shadow-[0_0_10px_var(--nova-accent)]" : "bg-white/25")}
                style={anchor === "left" ? { left: SIDE_GAP + guideWidth / 2 } : anchor === "right" ? { right: SIDE_GAP + guideWidth / 2 } : { left: "50%" }}
              />
            ))}
          <motion.div
            ref={wrapper}
            style={{ x }}
            className={cn("pointer-events-none absolute inset-0 px-[14px] [&_.island]:pointer-events-auto", dragging ? "[&_.island]:cursor-grabbing" : "[&_.island]:cursor-grab")}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerDownCapture={(event) => {
              if ((event.target as HTMLElement).closest(".island-dot")) startDotDrag("island", event);
            }}
            onClickCapture={(event) => {
              if (swallowClick.current) {
                event.stopPropagation();
                event.preventDefault();
              }
            }}
          >
            <IslandView
              prefs={shown}
              data={data}
              actions={actions}
              expanded={current.expanded}
              lyrics={current.lyrics}
              hovered={hovered && !dragging}
              onHovered={setHovered}
              onExpanded={(expanded) => setView({ ...current, expanded })}
              onLyrics={(lyrics) => setView({ ...current, lyrics })}
              pillRef={pillRef}
              onSize={onSize}
              slotHint={slotHint}
              dropHint={dot?.from === "desk" && dot.over}
            />
          </motion.div>

          {/* The dot's place on the desktop, beside the taskbar's corner. */}
          <div className="absolute right-4 bottom-12 flex items-center gap-2">
            {dotInIsland || dot?.from === "desk" ? (
              <span aria-hidden className={cn("flex size-9 items-center justify-center rounded-full border border-dashed transition-colors", dot?.from === "island" && !dot.over ? "border-accent-text bg-accent/20" : "border-white/25")} />
            ) : (
              <button
                type="button"
                aria-label={prefs.mode === "dotAndIsland" ? "NOVA-Punkt in die Island legen" : "NOVA-Punkt einschalten und in die Island legen"}
                title="In die Island ziehen"
                onPointerDown={(event) => startDotDrag("desk", event)}
                onClick={() => !swallowClick.current && update((now) => ({ ...now, mode: "islandOnly", dotInIsland: true }), "dot")}
                className={cn("flex size-9 cursor-grab items-center justify-center rounded-full transition-transform hover:scale-110 active:cursor-grabbing", prefs.mode === "islandOnly" && "opacity-40")}
              >
                <Orb state="idle" size={22} />
              </button>
            )}
          </div>
        </div>
      </PreviewStage>

      {/* The dot while it is being carried. */}
      {dot && (
        <span aria-hidden className="pointer-events-none fixed z-50" style={{ left: dot.x - 13, top: dot.y - 13 }}>
          <Orb state="listening" size={26} />
        </span>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Szene" className="flex min-w-0 flex-1 flex-wrap gap-1.5">
          {[...SCENES.map((s) => ({ id: s.id as StageScene, label: s.label })), { id: "live" as StageScene, label: "Live" }].map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={playing.id === option.id}
              title={option.id === "live" ? "Was auf diesem PC gerade läuft" : undefined}
              onClick={() => choose(option.id)}
              className={cn(
                "h-7 rounded-full border px-2.5 text-[12px] font-medium transition-colors",
                playing.id === option.id ? "border-accent bg-accent/15 text-fg" : "border-line bg-white/[0.03] text-fg-muted hover:border-line-strong hover:text-fg",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-pressed={auto}
          onClick={() => setAuto((now) => !now)}
          className={cn("flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium transition-colors", auto ? "border-accent bg-accent text-on-accent" : "border-line text-fg hover:border-line-strong")}
        >
          {auto ? <Pause size={12} aria-hidden /> : <Play size={12} aria-hidden />} Auto-Demo
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-[14px] border border-line bg-white/[0.02] px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={`Island verschieben. Jetzt: ${ANCHOR_LABEL[prefs.anchor]}${prefs.offset ? `, ${prefs.offset} px versetzt` : ""}`}
            aria-pressed={held !== null}
            title="Leertaste greift, Pfeiltasten verschieben"
            onKeyDown={onGripKey}
            onBlur={() => setHeld(null)}
            onClick={toggleHeld}
            className={cn("flex size-7 items-center justify-center rounded-[8px] transition-colors", held ? "bg-accent/20 text-accent-text" : "text-fg-subtle hover:bg-white/[0.06] hover:text-fg")}
          >
            <Move size={14} aria-hidden />
          </button>
          <SegmentedControl
            label="Position der Island"
            value={prefs.anchor}
            options={(["left", "center", "right"] as const).map((value) => ({ value, label: ANCHOR_LABEL[value] }))}
            onChange={(anchor) => update((now) => ({ ...now, anchor, offset: 0 }), "position")}
          />
          <span className="text-[12px] text-fg-subtle tabular-nums" aria-live="polite">
            {prefs.offset === 0 ? "eingerastet" : `${prefs.offset > 0 ? "+" : ""}${prefs.offset} px`}
          </span>
        </div>
        <label className={cn("flex items-center gap-2.5 text-[12.5px]", desktop ? "text-fg" : "text-fg-subtle")} title={desktop ? "Jede Szene läuft dort 10 Sekunden" : "Nur in der NOVA-Desktop-App"}>
          <Monitor size={14} className="text-fg-subtle" aria-hidden />
          Auch auf dem Desktop zeigen
          <Switch label="Auch auf dem Desktop zeigen" checked={mirror} disabled={!desktop || !prefs.enabled} onChange={setMirror} />
        </label>
      </div>
    </>
  );
}
