import { beforeEach, describe, expect, it, vi } from "vitest";
import * as native from "@/lib/native";
import { clampSize, resolveConfig } from "@/widgets/config";
import { getWidget, WIDGETS } from "@/widgets/registry";
import { createLayout, defaultWidgets, moveItem, sanitizeLayout } from "./layouts";
import { flushDashboardSaves, useDashboard } from "./store";

const LAYOUTS_KEY = "nova.dashboard.layouts";

function storedLayouts(): { id: string; name: string; widgets: { widgetId: string; instanceId: string; w: number; h: number; config: object }[] }[] {
  return JSON.parse(localStorage.getItem(LAYOUTS_KEY) ?? "[]");
}

function active() {
  const { layouts, activeId } = useDashboard.getState();
  return layouts.find((l) => l.id === activeId)!;
}

async function freshStore() {
  useDashboard.setState({ status: "idle", layouts: [], activeId: "", editing: false, lastRemoved: null, storageError: null });
  await useDashboard.getState().load();
}

describe("layout helpers", () => {
  it("moves items", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b"], 5, 0)).toEqual(["a", "b"]);
  });

  it("duplicates layouts with fresh instance ids", () => {
    const source = createLayout("Work", "default");
    const copy = createLayout("Copy", "duplicate", source);
    expect(copy.widgets.map((w) => w.widgetId)).toEqual(source.widgets.map((w) => w.widgetId));
    expect(copy.widgets.some((w, i) => w.instanceId === source.widgets[i]!.instanceId)).toBe(false);
    expect(createLayout("  ", "empty").name).toBe("Untitled layout");
  });

  it("drops malformed widgets but keeps the layout", () => {
    const layout = sanitizeLayout({
      id: "abc",
      name: "Home",
      widgets: [
        { instanceId: "w1", widgetId: "cpu", w: 4, h: 3, config: { showChart: false } },
        { instanceId: "w2", widgetId: "cpu", w: 40, h: 3 },
        { instanceId: "w1", widgetId: "memory", w: 4, h: 3 },
        { instanceId: "bad id", widgetId: "cpu", w: 4, h: 3 },
        "garbage",
      ],
    });
    expect(layout?.widgets).toEqual([{ instanceId: "w1", widgetId: "cpu", w: 4, h: 3, config: { showChart: false } }]);
    expect(sanitizeLayout({ id: "../x", name: "x", widgets: [] })).toBeNull();
  });

  it("every default widget exists in the registry", () => {
    for (const widget of defaultWidgets()) expect(getWidget(widget.widgetId), widget.widgetId).toBeDefined();
  });
});

describe("widget config", () => {
  it("resolves defaults and rejects invalid values", () => {
    const clock = getWidget("clock")!;
    expect(resolveConfig(clock.configSchema, undefined)).toEqual({ style: "digital", timeZone: "local", showSeconds: false });
    expect(resolveConfig(clock.configSchema, { timeZone: "Asia/Tokyo", showSeconds: "yes", extra: 1 })).toEqual({
      style: "digital",
      timeZone: "Asia/Tokyo",
      showSeconds: false,
    });
    expect(resolveConfig(clock.configSchema, { timeZone: "Nowhere/City" }).timeZone).toBe("local");
  });

  it("clamps sizes to the widget's bounds", () => {
    const cpu = getWidget("cpu")!;
    expect(clampSize(cpu, { w: 1, h: 99 })).toEqual({ w: cpu.minSize.w, h: cpu.maxSize.h });
  });

  it("every widget declares coherent sizes and unique config keys", () => {
    for (const widget of WIDGETS) {
      expect(widget.minSize.w).toBeLessThanOrEqual(widget.defaultSize.w);
      expect(widget.defaultSize.w).toBeLessThanOrEqual(widget.maxSize.w);
      expect(widget.minSize.h).toBeLessThanOrEqual(widget.defaultSize.h);
      expect(widget.defaultSize.h).toBeLessThanOrEqual(widget.maxSize.h);
      const keys = widget.configSchema.map((f) => f.key);
      expect(new Set(keys).size, widget.id).toBe(keys.length);
    }
  });
});

describe("dashboard store", () => {
  beforeEach(async () => {
    await freshStore();
  });

  it("creates and persists a default layout on first run", async () => {
    await flushDashboardSaves();
    expect(active().name).toBe("Default");
    expect(active().widgets.map((w) => w.widgetId)).toEqual(["welcome", "calendar", "cpu", "memory", "device", "storage"]);
    expect(storedLayouts()).toHaveLength(1);
  });

  it("adds, configures, resizes and moves widgets, persisting every change", async () => {
    const store = useDashboard.getState();
    const id = store.addWidget("clock")!;
    store.updateWidgetConfig(id, { timeZone: "Asia/Tokyo" });
    store.resizeWidget(id, { w: 99, h: 1 });
    store.moveWidget(id, 0);
    await flushDashboardSaves();

    const saved = storedLayouts()[0]!.widgets[0]!;
    expect(saved).toMatchObject({ instanceId: id, widgetId: "clock", w: 6, h: 2, config: { timeZone: "Asia/Tokyo" } });
  });

  it("ignores unknown widget types when adding", () => {
    expect(useDashboard.getState().addWidget("not-a-widget")).toBeNull();
  });

  it("removes a widget and can undo it in place", async () => {
    const target = active().widgets[2]!;
    useDashboard.getState().removeWidget(target.instanceId);
    expect(active().widgets).toHaveLength(5);

    useDashboard.getState().undoRemove();
    expect(active().widgets[2]).toEqual(target);
    expect(useDashboard.getState().lastRemoved).toBeNull();
  });

  it("manages multiple layouts and remembers the active one", async () => {
    const store = useDashboard.getState();
    const firstId = active().id;
    const emptyId = store.createLayout("Focus", "empty");
    expect(active().id).toBe(emptyId);
    expect(active().widgets).toEqual([]);

    useDashboard.getState().renameLayout(emptyId, "Deep focus");
    await flushDashboardSaves();
    expect(storedLayouts().map((l) => l.name)).toEqual(["Default", "Deep focus"]);

    // A fresh session restores both layouts and the active one.
    await freshStore();
    expect(useDashboard.getState().layouts).toHaveLength(2);
    expect(active().id).toBe(emptyId);

    useDashboard.getState().deleteLayout(emptyId);
    expect(active().id).toBe(firstId);
    await flushDashboardSaves();
    expect(storedLayouts()).toHaveLength(1);
  });

  it("never deletes the last layout", () => {
    useDashboard.getState().deleteLayout(active().id);
    expect(useDashboard.getState().layouts).toHaveLength(1);
  });

  it("falls back to an in-memory layout when storage is unavailable", async () => {
    vi.spyOn(native, "isDesktop").mockReturnValue(true);
    vi.spyOn(native, "callNative").mockRejectedValue(new Error("database is locked"));
    await freshStore();

    expect(active().widgets.length).toBeGreaterThan(0);
    expect(useDashboard.getState().storageError).toMatch(/database is locked/);
  });

  it("serializes saves so the latest state always wins", async () => {
    const save = vi.fn(async (_args?: Record<string, unknown>) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    vi.spyOn(native, "isDesktop").mockReturnValue(true);
    vi.spyOn(native, "callNative").mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "dashboard_layout_save") return save(args);
      return command === "dashboard_layouts_list" ? [createLayout("Default", "default")] : null;
    });
    await freshStore();

    const id = active().widgets[0]!.instanceId;
    for (let i = 0; i < 10; i++) useDashboard.getState().moveWidget(id, i % 3);
    await flushDashboardSaves();

    // One in-flight save plus one follow-up with the final state.
    expect(save).toHaveBeenCalledTimes(2);
    const lastLayout = (save.mock.calls.at(-1) as unknown as [{ layout: { widgets: { instanceId: string }[] } }])[0].layout;
    expect(lastLayout.widgets.map((w) => w.instanceId)).toEqual(active().widgets.map((w) => w.instanceId));
  });
});
