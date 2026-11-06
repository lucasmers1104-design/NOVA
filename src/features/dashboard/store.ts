import { create } from "zustand";
import { clampSize } from "@/widgets/config";
import { getWidget } from "@/widgets/registry";
import type { WidgetInstance, WidgetSize } from "@/widgets/types";
import { createLayout, type DashboardLayout, type LayoutTemplate, MAX_WIDGETS_PER_LAYOUT, moveItem, newId, sanitizeLayout } from "./layouts";
import { dashboardRepository } from "./repository";

interface RemovedWidget {
  layoutId: string;
  index: number;
  widget: WidgetInstance;
}

interface DashboardState {
  status: "idle" | "loading" | "ready";
  /** Set when layouts could not be loaded or saved; the UI keeps working in memory. */
  storageError: string | null;
  layouts: DashboardLayout[];
  activeId: string;
  editing: boolean;
  lastRemoved: RemovedWidget | null;

  load: () => Promise<void>;
  setActive: (id: string) => void;
  setEditing: (editing: boolean) => void;
  createLayout: (name: string, template: LayoutTemplate) => string;
  /** Adds a layout built from widget templates without switching to it. */
  importLayout: (name: string, widgets: readonly Omit<WidgetInstance, "instanceId">[]) => string;
  renameLayout: (id: string, name: string) => void;
  deleteLayout: (id: string) => void;
  resetActiveLayout: () => void;
  addWidget: (widgetId: string) => string | null;
  removeWidget: (instanceId: string) => void;
  undoRemove: () => void;
  moveWidget: (instanceId: string, toIndex: number) => void;
  resizeWidget: (instanceId: string, size: WidgetSize) => void;
  updateWidgetConfig: (instanceId: string, patch: Record<string, unknown>) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- Save serialization -----------------------------------------------------
// At most one save per layout is in flight. Changes made meanwhile mark the
// layout dirty and trigger exactly one follow-up save of the latest state, so
// rapid edits (drag, resize) can never be written out of order.
const saves = new Map<string, { running: Promise<void>; dirty: boolean }>();

function scheduleSave(layoutId: string) {
  const existing = saves.get(layoutId);
  if (existing) {
    existing.dirty = true;
    return;
  }
  const entry = { running: Promise.resolve(), dirty: true };
  entry.running = (async () => {
    while (entry.dirty) {
      entry.dirty = false;
      const layout = useDashboard.getState().layouts.find((l) => l.id === layoutId);
      if (!layout) break;
      try {
        await dashboardRepository().save(layout);
        if (useDashboard.getState().storageError) useDashboard.setState({ storageError: null });
      } catch (error) {
        useDashboard.setState({ storageError: `Changes couldn't be saved: ${errorMessage(error)}` });
      }
    }
    saves.delete(layoutId);
  })();
  saves.set(layoutId, entry);
}

/** Resolves once every pending layout save has finished. */
export async function flushDashboardSaves(): Promise<void> {
  while (saves.size > 0) await Promise.all([...saves.values()].map((s) => s.running));
}

function persistActiveId(id: string) {
  dashboardRepository()
    .setActiveId(id)
    .catch(() => {
      // Non-critical: the first layout is used if this preference is lost.
    });
}

export const useDashboard = create<DashboardState>()((set, get) => {
  /** Applies `update` to the active layout and persists the result. */
  const mutateActive = (update: (widgets: WidgetInstance[]) => WidgetInstance[]) => {
    const { activeId, layouts } = get();
    const current = layouts.find((layout) => layout.id === activeId)?.widgets;
    if (!current) return;
    const next = update(current);
    // Pointer-driven resizes call this on every move; skip writes when nothing changed.
    if (next.length === current.length && next.every((widget, i) => widget === current[i])) return;
    set({
      layouts: layouts.map((layout) => (layout.id === activeId ? { ...layout, widgets: next } : layout)),
    });
    scheduleSave(activeId);
  };

  return {
    status: "idle",
    storageError: null,
    layouts: [],
    activeId: "",
    editing: false,
    lastRemoved: null,

    load: async () => {
      set({ status: "loading" });
      const repository = dashboardRepository();
      try {
        const stored = (await repository.list()).map(sanitizeLayout).filter((l): l is DashboardLayout => l !== null);
        let layouts = stored;
        if (layouts.length === 0) {
          const initial = createLayout("Default", "default");
          await repository.save(initial);
          layouts = [initial];
        }
        const storedActive = await repository.getActiveId();
        const activeId = layouts.some((l) => l.id === storedActive) ? storedActive! : layouts[0]!.id;
        set({ layouts, activeId, status: "ready", storageError: null });
      } catch (error) {
        // Home must still work if storage is broken: run on an in-memory default.
        const fallback = createLayout("Default", "default");
        set({
          layouts: [fallback],
          activeId: fallback.id,
          status: "ready",
          storageError: `Layouts couldn't be loaded: ${errorMessage(error)}`,
        });
      }
    },

    setActive: (id) => {
      if (!get().layouts.some((l) => l.id === id)) return;
      set({ activeId: id, lastRemoved: null });
      persistActiveId(id);
    },

    setEditing: (editing) => set({ editing, lastRemoved: editing ? get().lastRemoved : null }),

    createLayout: (name, template) => {
      const { layouts, activeId } = get();
      const layout = createLayout(name, template, layouts.find((l) => l.id === activeId));
      set({ layouts: [...layouts, layout], activeId: layout.id, lastRemoved: null });
      scheduleSave(layout.id);
      persistActiveId(layout.id);
      return layout.id;
    },

    importLayout: (name, widgets) => {
      const layout: DashboardLayout = {
        ...createLayout(name, "empty"),
        widgets: widgets.map((w) => ({ ...w, config: { ...w.config }, instanceId: newId() })),
      };
      set({ layouts: [...get().layouts, layout] });
      scheduleSave(layout.id);
      return layout.id;
    },

    renameLayout: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      set({ layouts: get().layouts.map((l) => (l.id === id ? { ...l, name: trimmed.slice(0, 40) } : l)) });
      scheduleSave(id);
    },

    deleteLayout: (id) => {
      const { layouts, activeId } = get();
      if (layouts.length <= 1) return;
      const remaining = layouts.filter((l) => l.id !== id);
      const nextActive = id === activeId ? remaining[0]!.id : activeId;
      set({ layouts: remaining, activeId: nextActive, lastRemoved: null });
      dashboardRepository()
        .remove(id)
        .catch((error) => set({ storageError: `Layout couldn't be deleted: ${errorMessage(error)}` }));
      persistActiveId(nextActive);
    },

    resetActiveLayout: () => {
      mutateActive(() => createLayout("", "default").widgets);
      set({ lastRemoved: null });
    },

    addWidget: (widgetId) => {
      const definition = getWidget(widgetId);
      const active = get().layouts.find((l) => l.id === get().activeId);
      if (!definition || !active || active.widgets.length >= MAX_WIDGETS_PER_LAYOUT) return null;
      const instance: WidgetInstance = { instanceId: newId(), widgetId, ...definition.defaultSize, config: {} };
      mutateActive((widgets) => [...widgets, instance]);
      return instance.instanceId;
    },

    removeWidget: (instanceId) => {
      const { activeId, layouts } = get();
      const widgets = layouts.find((l) => l.id === activeId)?.widgets ?? [];
      const index = widgets.findIndex((w) => w.instanceId === instanceId);
      if (index === -1) return;
      set({ lastRemoved: { layoutId: activeId, index, widget: widgets[index]! } });
      mutateActive((current) => current.filter((w) => w.instanceId !== instanceId));
    },

    undoRemove: () => {
      const removed = get().lastRemoved;
      const active = get().layouts.find((l) => l.id === get().activeId);
      if (!removed || !active || removed.layoutId !== active.id || active.widgets.length >= MAX_WIDGETS_PER_LAYOUT) return;
      set({ lastRemoved: null });
      mutateActive((widgets) => {
        const next = [...widgets];
        next.splice(Math.min(removed.index, next.length), 0, removed.widget);
        return next;
      });
    },

    moveWidget: (instanceId, toIndex) => {
      mutateActive((widgets) => {
        const from = widgets.findIndex((w) => w.instanceId === instanceId);
        return from === -1 || from === toIndex ? widgets : moveItem(widgets, from, toIndex);
      });
    },

    resizeWidget: (instanceId, size) => {
      mutateActive((widgets) =>
        widgets.map((widget) => {
          if (widget.instanceId !== instanceId) return widget;
          const definition = getWidget(widget.widgetId);
          // An unavailable widget still has to fit what a layout may hold.
          const next = clampSize(definition ?? { minSize: { w: 1, h: 1 }, maxSize: { w: 12, h: 8 } }, size);
          return next.w === widget.w && next.h === widget.h ? widget : { ...widget, ...next };
        }),
      );
    },

    updateWidgetConfig: (instanceId, patch) => {
      mutateActive((widgets) =>
        widgets.map((widget) => (widget.instanceId === instanceId ? { ...widget, config: { ...widget.config, ...patch } } : widget)),
      );
    },
  };
});

export function useActiveLayout(): DashboardLayout | undefined {
  return useDashboard((s) => s.layouts.find((l) => l.id === s.activeId));
}
