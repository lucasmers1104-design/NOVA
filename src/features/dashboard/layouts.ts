import type { WidgetInstance } from "@/widgets/types";

export interface DashboardLayout {
  id: string;
  name: string;
  widgets: WidgetInstance[];
}

export type LayoutTemplate = "default" | "empty" | "duplicate";

export const MAX_LAYOUT_NAME = 40;
export const MAX_WIDGETS_PER_LAYOUT = 48;

export function newId(): string {
  return crypto.randomUUID();
}

/**
 * The initial dashboard. Placement relies on dense auto-flow:
 *   [ welcome (8×2)        ][ calendar (4×4) ]
 *   [ cpu (4×3) ][ memory (4×3) ][          ]
 *   [ storage (8×2)        ][ device (4×3)   ]
 */
const DEFAULT_WIDGETS: readonly Omit<WidgetInstance, "instanceId">[] = [
  { widgetId: "welcome", w: 8, h: 2, config: {} },
  { widgetId: "calendar", w: 4, h: 4, config: {} },
  { widgetId: "cpu", w: 4, h: 3, config: {} },
  { widgetId: "memory", w: 4, h: 3, config: {} },
  { widgetId: "device", w: 4, h: 3, config: {} },
  { widgetId: "storage", w: 8, h: 2, config: {} },
];

export function defaultWidgets(): WidgetInstance[] {
  return DEFAULT_WIDGETS.map((widget) => ({ ...widget, config: {}, instanceId: newId() }));
}

export function createLayout(name: string, template: LayoutTemplate, source?: DashboardLayout): DashboardLayout {
  const widgets =
    template === "default"
      ? defaultWidgets()
      : template === "duplicate" && source
        ? source.widgets.map((widget) => ({ ...widget, config: { ...widget.config }, instanceId: newId() }))
        : [];
  return { id: newId(), name: name.trim().slice(0, MAX_LAYOUT_NAME) || "Untitled layout", widgets };
}

const IDENTIFIER = /^[A-Za-z0-9_-]{1,64}$/;

function sanitizeWidget(raw: unknown): WidgetInstance | null {
  if (typeof raw !== "object" || raw === null) return null;
  const w = raw as Record<string, unknown>;
  if (typeof w.instanceId !== "string" || !IDENTIFIER.test(w.instanceId)) return null;
  if (typeof w.widgetId !== "string" || !IDENTIFIER.test(w.widgetId)) return null;
  const size = (v: unknown, max: number) => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max ? v : null);
  const width = size(w.w, 12);
  const height = size(w.h, 8);
  if (width === null || height === null) return null;
  const config = typeof w.config === "object" && w.config !== null && !Array.isArray(w.config) ? (w.config as Record<string, unknown>) : {};
  return { instanceId: w.instanceId, widgetId: w.widgetId, w: width, h: height, config };
}

/** Validates a layout loaded from storage; malformed widgets are dropped, never the whole layout. */
export function sanitizeLayout(raw: unknown): DashboardLayout | null {
  if (typeof raw !== "object" || raw === null) return null;
  const l = raw as Record<string, unknown>;
  if (typeof l.id !== "string" || !IDENTIFIER.test(l.id)) return null;
  const name = typeof l.name === "string" && l.name.trim() ? l.name.trim().slice(0, MAX_LAYOUT_NAME) : "Untitled layout";
  const seen = new Set<string>();
  const widgets = (Array.isArray(l.widgets) ? l.widgets : [])
    .map(sanitizeWidget)
    .filter((w): w is WidgetInstance => w !== null && !seen.has(w.instanceId) && (seen.add(w.instanceId), true))
    .slice(0, MAX_WIDGETS_PER_LAYOUT);
  return { id: l.id, name, widgets };
}

/** Returns a copy of `items` with the element at `from` moved to `to`. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const result = [...items];
  if (from < 0 || from >= result.length) return result;
  const [item] = result.splice(from, 1);
  result.splice(Math.max(0, Math.min(result.length, to)), 0, item!);
  return result;
}
