import { CircleQuestionMark, GripVertical, Settings2, X } from "lucide-react";
import { motion, useMotionValue } from "motion/react";
import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "@/components/ui/Button";
import { useDashboard } from "@/features/dashboard/store";
import { cn } from "@/lib/cn";
import { resolveConfig, WidgetConfigContext } from "@/widgets/config";
import { getWidget } from "@/widgets/registry";
import type { WidgetDefinition, WidgetInstance } from "@/widgets/types";
import { WidgetBoundary } from "@/widgets/WidgetBoundary";
import { WidgetFrame } from "@/widgets/WidgetFrame";

export const GRID_ROW_HEIGHT = 96;
export const GRID_GAP = 16;
/** Below this content width the 12-column layout folds to 6 columns. */
const WIDE_GRID_MIN_WIDTH = 1000;
/** Pointer travel before a press on a widget becomes a drag. */
const DRAG_THRESHOLD = 5;

/** Maps a width designed for 12 columns onto the current column count. */
export function columnSpan(w: number, columns: number): number {
  return Math.max(1, Math.min(columns, Math.ceil((w * columns) / 12)));
}

function useGridColumns(ref: RefObject<HTMLElement | null>): number {
  const [columns, setColumns] = useState(12);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = (width: number) => setColumns(width >= WIDE_GRID_MIN_WIDTH ? 12 : 6);
    update(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => entry && update(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return columns;
}

function activeWidgets(): WidgetInstance[] {
  const { layouts, activeId } = useDashboard.getState();
  return layouts.find((l) => l.id === activeId)?.widgets ?? [];
}

function focusOverlay(instanceId: string) {
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`[data-instance="${instanceId}"] [data-edit-overlay]`)?.focus();
  });
}

interface DashboardGridProps {
  widgets: readonly WidgetInstance[];
  editing: boolean;
  onConfigure: (instanceId: string) => void;
}

export function DashboardGrid({ widgets, editing, onConfigure }: DashboardGridProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const columns = useGridColumns(gridRef);
  const [dragging, setDragging] = useState<{ instanceId: string; width: number; height: number } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const ghostX = useMotionValue(0);
  const ghostY = useMotionValue(0);

  const nameOf = (instanceId: string) => {
    const instance = activeWidgets().find((w) => w.instanceId === instanceId);
    return (instance && getWidget(instance.widgetId)?.name) ?? "Widget";
  };

  const announcePosition = (instanceId: string) => {
    const list = activeWidgets();
    const index = list.findIndex((w) => w.instanceId === instanceId);
    setAnnouncement(`${nameOf(instanceId)} moved to position ${index + 1} of ${list.length}.`);
  };

  /** The widget whose central area contains the point (edges are ignored to avoid flip-flopping). */
  const widgetAt = (x: number, y: number): string | null => {
    for (const el of gridRef.current?.querySelectorAll<HTMLElement>("[data-instance]") ?? []) {
      const r = el.getBoundingClientRect();
      const insetX = r.width * 0.15;
      const insetY = r.height * 0.15;
      if (x > r.left + insetX && x < r.right - insetX && y > r.top + insetY && y < r.bottom - insetY) {
        return el.dataset.instance ?? null;
      }
    }
    return null;
  };

  const startDrag = (instanceId: string, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const element = event.currentTarget.closest<HTMLElement>("[data-instance]");
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;
    let lastTarget: string | null = null;

    // Window listeners rather than pointer capture: reordering moves the
    // dragged element in the DOM, which would silently release a capture.
    const onMove = (e: PointerEvent) => {
      if (!active) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
        active = true;
        setDragging({ instanceId, width: rect.width, height: rect.height });
      }
      ghostX.set(e.clientX - offsetX);
      ghostY.set(e.clientY - offsetY);
      const target = widgetAt(e.clientX, e.clientY);
      if (target === instanceId) {
        lastTarget = null;
        return;
      }
      if (!target || target === lastTarget) return;
      lastTarget = target;
      useDashboard.getState().moveWidget(instanceId, activeWidgets().findIndex((w) => w.instanceId === target));
    };
    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      if (active) {
        setDragging(null);
        announcePosition(instanceId);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  const startResize = (instance: WidgetInstance, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !gridRef.current) return;
    event.stopPropagation();
    event.preventDefault();
    const gridWidth = gridRef.current.getBoundingClientRect().width;
    const columnStep = (gridWidth + GRID_GAP) / columns;
    const rowStep = GRID_ROW_HEIGHT + GRID_GAP;
    const unit = 12 / columns;
    const startSpan = columnSpan(instance.w, columns);
    const startX = event.clientX;
    const startY = event.clientY;

    const onMove = (e: PointerEvent) => {
      const span = startSpan + Math.round((e.clientX - startX) / columnStep);
      const h = instance.h + Math.round((e.clientY - startY) / rowStep);
      useDashboard.getState().resizeWidget(instance.instanceId, { w: span * unit, h });
    };
    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      const resized = activeWidgets().find((w) => w.instanceId === instance.instanceId);
      if (resized) setAnnouncement(`${nameOf(instance.instanceId)} resized to ${resized.w} by ${resized.h}.`);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  const onOverlayKeyDown = (instance: WidgetInstance, definition: WidgetDefinition | undefined, event: KeyboardEvent<HTMLElement>) => {
    const store = useDashboard.getState();
    const index = activeWidgets().findIndex((w) => w.instanceId === instance.instanceId);
    const unit = 12 / columns;
    const keys: Record<string, () => void> = event.shiftKey
      ? {
          ArrowRight: () => store.resizeWidget(instance.instanceId, { w: instance.w + unit, h: instance.h }),
          ArrowLeft: () => store.resizeWidget(instance.instanceId, { w: instance.w - unit, h: instance.h }),
          ArrowDown: () => store.resizeWidget(instance.instanceId, { w: instance.w, h: instance.h + 1 }),
          ArrowUp: () => store.resizeWidget(instance.instanceId, { w: instance.w, h: instance.h - 1 }),
        }
      : {
          ArrowLeft: () => store.moveWidget(instance.instanceId, Math.max(0, index - 1)),
          ArrowUp: () => store.moveWidget(instance.instanceId, Math.max(0, index - 1)),
          ArrowRight: () => store.moveWidget(instance.instanceId, index + 1),
          ArrowDown: () => store.moveWidget(instance.instanceId, index + 1),
          Delete: () => store.removeWidget(instance.instanceId),
          Backspace: () => store.removeWidget(instance.instanceId),
          Enter: () => definition && definition.configSchema.length > 0 && onConfigure(instance.instanceId),
        };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    action();
    if (event.key.startsWith("Arrow")) {
      focusOverlay(instance.instanceId);
      if (event.shiftKey) {
        const resized = activeWidgets().find((w) => w.instanceId === instance.instanceId);
        if (resized) setAnnouncement(`${nameOf(instance.instanceId)} resized to ${resized.w} by ${resized.h}.`);
      } else {
        announcePosition(instance.instanceId);
      }
    }
  };

  const draggedDefinition = dragging ? getWidget(activeWidgets().find((w) => w.instanceId === dragging.instanceId)?.widgetId ?? "") : undefined;

  return (
    <>
      <div
        ref={gridRef}
        className="grid grid-flow-row-dense"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridAutoRows: GRID_ROW_HEIGHT, gap: GRID_GAP }}
      >
        {widgets.map((instance, index) => {
          const definition = getWidget(instance.widgetId);
          const isDragged = dragging?.instanceId === instance.instanceId;
          return (
            <motion.div
              key={instance.instanceId}
              layout="position"
              data-instance={instance.instanceId}
              data-widget={instance.widgetId}
              style={{ gridColumn: `span ${columnSpan(instance.w, columns)}`, gridRow: `span ${instance.h}` }}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: isDragged ? 0.35 : 1, y: 0 }}
              transition={{
                layout: { type: "spring", stiffness: 520, damping: 42 },
                default: { delay: dragging ? 0 : Math.min(index, 8) * 0.04, duration: 0.3, ease: [0.22, 1, 0.36, 1] },
              }}
              className="relative min-w-0"
            >
              <div inert={editing} className={cn("h-full transition-opacity duration-200", editing && "pointer-events-none opacity-60 select-none")}>
                <WidgetBoundary name={definition?.name ?? "Widget"}>
                  {definition ? (
                    <WidgetConfigContext.Provider value={resolveConfig(definition.configSchema, instance.config)}>
                      <definition.component />
                    </WidgetConfigContext.Provider>
                  ) : (
                    <UnknownWidget widgetId={instance.widgetId} />
                  )}
                </WidgetBoundary>
              </div>

              {editing && (
                <div
                  data-edit-overlay
                  tabIndex={0}
                  role="group"
                  aria-roledescription="movable widget"
                  aria-label={`${definition?.name ?? "Unknown widget"}, ${instance.w} by ${instance.h}. Arrow keys move, Shift plus arrow keys resize, Delete removes${definition?.configSchema.length ? ", Enter opens settings" : ""}.`}
                  onPointerDown={(event) => startDrag(instance.instanceId, event)}
                  onKeyDown={(event) => onOverlayKeyDown(instance, definition, event)}
                  className={cn(
                    "absolute inset-0 z-10 cursor-grab touch-none rounded-widget border-2 border-dashed transition-colors active:cursor-grabbing",
                    "border-accent/45 bg-canvas/25 hover:border-accent/80 hover:bg-canvas/10 focus-visible:border-accent focus-visible:outline-none",
                    isDragged && "border-accent bg-accent/10",
                  )}
                >
                  <div className="absolute top-2.5 left-2.5 flex h-8 items-center gap-1.5 rounded-full border border-line-strong bg-canvas-raised pr-3 pl-2 text-[12px] font-medium text-fg shadow-[0_4px_12px_rgb(0_0_0/0.4)]">
                    <GripVertical size={13} className="text-fg-subtle" aria-hidden />
                    {definition?.name ?? "Unknown widget"}
                  </div>
                  <div className="absolute top-2.5 right-2.5 flex items-center gap-1" onPointerDown={(event) => event.stopPropagation()}>
                    <span className="mr-1 rounded-full border border-line bg-canvas-raised px-2 py-0.5 text-[11px] font-medium text-fg-muted tabular-nums">
                      {instance.w} × {instance.h}
                    </span>
                    {definition && definition.configSchema.length > 0 && (
                      <IconButton
                        size="sm"
                        label={`${definition.name} settings`}
                        onClick={() => onConfigure(instance.instanceId)}
                        className="border border-line bg-canvas-raised"
                      >
                        <Settings2 size={14} />
                      </IconButton>
                    )}
                    <IconButton
                      size="sm"
                      label={`Remove ${definition?.name ?? "widget"}`}
                      onClick={() => useDashboard.getState().removeWidget(instance.instanceId)}
                      className="border border-line bg-canvas-raised hover:bg-danger/20 hover:text-danger"
                    >
                      <X size={14} />
                    </IconButton>
                  </div>
                  <div
                    aria-hidden
                    onPointerDown={(event) => startResize(instance, event)}
                    className="absolute right-0 bottom-0 flex size-7 cursor-nwse-resize items-end justify-end p-1.5"
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" className="text-accent-text">
                      <path d="M9 1v8H1" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </div>
                </div>
              )}
            </motion.div>
          );
        })}
      </div>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {dragging &&
        createPortal(
          <motion.div
            aria-hidden
            style={{ x: ghostX, y: ghostY, width: dragging.width, height: dragging.height }}
            initial={{ scale: 1, rotate: 0 }}
            animate={{ scale: 1.03, rotate: 0.6 }}
            className="glass-strong pointer-events-none fixed top-0 left-0 z-50 flex items-center justify-center rounded-widget border-accent/60 shadow-[0_30px_80px_-20px_var(--nova-accent-glow)]"
          >
            {draggedDefinition && (
              <span className="flex items-center gap-2.5 text-[14px] font-medium text-fg">
                <draggedDefinition.icon size={18} className="text-accent-text" aria-hidden />
                {draggedDefinition.name}
              </span>
            )}
          </motion.div>,
          document.body,
        )}
    </>
  );
}

function UnknownWidget({ widgetId }: { widgetId: string }) {
  return (
    <WidgetFrame title="Unavailable widget" icon={CircleQuestionMark}>
      <p className="text-[12px] leading-relaxed text-fg-muted">
        “{widgetId}” isn't available in this version of NOVA. Remove it in Customize mode.
      </p>
    </WidgetFrame>
  );
}
