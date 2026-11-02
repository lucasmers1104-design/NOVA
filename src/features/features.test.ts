import { describe, expect, it } from "vitest";
import { parseBlocks } from "@/components/ui/Markdown";
import { searchApps, sanitizeAppPreferences } from "@/features/apps/api";
import { describeWeather, mergeFeeds, parseFeedDate } from "@/features/live/api";
import { formatTrackTime, sourceAppName } from "@/features/media/api";
import { useNotifications } from "@/features/notifications/store";
import { addDays, dueReminders, groupTasks, isOverdue, noteTitle, relativeDueLabel, reminderKey, searchTasks, type Task, toISODate } from "@/features/productivity/model";
import { newTask } from "@/features/productivity/store";
import { sanitizeProfiles } from "@/features/profiles/store";
import { primaryGpuUsage } from "@/features/system/history";
import { sortProcesses } from "@/features/system/ProcessTable";
import { formatBitRate } from "@/lib/format";
import { sanitizeSettings } from "@/stores/settings";
import { progressOf } from "@/widgets/builtin/LiveInfoWidgets";

const NOW = new Date(2026, 10, 1, 14, 30); // Sun 1 Nov 2026, 14:30 local

function task(partial: Partial<Task>): Task {
  return { ...newTask({ title: "Task" }), createdAt: 1, updatedAt: 1, ...partial };
}

describe("markdown parser", () => {
  it("parses common blocks", () => {
    const blocks = parseBlocks("# Title\n\nSome **bold** text\nwraps.\n\n- one\n- two\n\n1. first\n\n> quote\n\n---\n\n```ts\nconst x = 1;\n```");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "list", "list", "quote", "rule", "code"]);
    expect(blocks[2]).toEqual({ type: "list", ordered: false, items: ["one", "two"] });
    expect(blocks[6]).toEqual({ type: "code", language: "ts", code: "const x = 1;" });
  });

  it("tolerates an unterminated code fence while streaming", () => {
    expect(parseBlocks("```py\nprint(1)")).toEqual([{ type: "code", language: "py", code: "print(1)" }]);
  });
});

describe("tasks", () => {
  it("groups by due state", () => {
    const today = toISODate(NOW);
    const groups = groupTasks(
      [
        task({ id: "a", dueDate: addDays(today, -1) }),
        task({ id: "b", dueDate: today, dueTime: "09:00" }),
        task({ id: "c", dueDate: today, dueTime: "18:00" }),
        task({ id: "d", dueDate: addDays(today, 3) }),
        task({ id: "e" }),
        task({ id: "f", completedAt: 5 }),
      ],
      NOW,
    );
    expect(groups.overdue.map((t) => t.id)).toEqual(["a", "b"]);
    expect(groups.today.map((t) => t.id)).toEqual(["c"]);
    expect(groups.upcoming.map((t) => t.id)).toEqual(["d"]);
    expect(groups.someday.map((t) => t.id)).toEqual(["e"]);
    expect(groups.completed.map((t) => t.id)).toEqual(["f"]);
  });

  it("treats date-only tasks as due at the end of the day", () => {
    expect(isOverdue(task({ dueDate: toISODate(NOW) }), NOW)).toBe(false);
    expect(isOverdue(task({ dueDate: addDays(toISODate(NOW), -1) }), NOW)).toBe(true);
  });

  it("finds due reminders once per due moment", () => {
    const today = toISODate(NOW);
    const due = task({ id: "r", dueDate: today, dueTime: "14:00", remind: true });
    const future = task({ id: "s", dueDate: today, dueTime: "15:00", remind: true });
    const stale = task({ id: "t", dueDate: addDays(today, -2), dueTime: "10:00", remind: true });
    expect(dueReminders([due, future, stale], NOW, new Set()).map((t) => t.id)).toEqual(["r"]);
    expect(dueReminders([due], NOW, new Set([reminderKey(due)]))).toEqual([]);
    // Rescheduling produces a new key, so it reminds again.
    expect(reminderKey({ ...due, dueTime: "14:15" })).not.toBe(reminderKey(due));
  });

  it("labels due dates relative to today", () => {
    const today = toISODate(NOW);
    expect(relativeDueLabel({ dueDate: today, dueTime: "09:00" }, NOW, "en-GB")).toBe("Today 09:00");
    expect(relativeDueLabel({ dueDate: addDays(today, 1), dueTime: null }, NOW, "en-GB")).toBe("Tomorrow");
    expect(relativeDueLabel({ dueDate: null, dueTime: null }, NOW, "en-GB")).toBeNull();
  });

  it("searches titles and notes", () => {
    const list = [task({ id: "1", title: "Buy milk" }), task({ id: "2", title: "Call", notes: "about milk" }), task({ id: "3", title: "Run" })];
    expect(searchTasks(list, "MILK").map((t) => t.id)).toEqual(["1", "2"]);
  });

  it("derives note titles", () => {
    expect(noteTitle({ title: "", body: "# Plan\nmore" })).toBe("Plan");
    expect(noteTitle({ title: "", body: "" })).toBe("Untitled note");
  });
});

describe("apps", () => {
  const apps = [
    { id: "1", name: "Visual Studio Code", category: "Apps", source: "start-menu" as const },
    { id: "2", name: "Calculator", category: "Apps", source: "start-menu" as const },
    { id: "3", name: "Microsoft Edge", category: "Apps", source: "start-menu" as const },
  ];

  it("ranks prefix and word-start matches first", () => {
    expect(searchApps(apps, "code").map((a) => a.id)).toEqual(["1"]);
    // Prefix (Calculator) > word start (Code) > plain substring (Mi-c-rosoft).
    expect(searchApps(apps, "c").map((a) => a.id)).toEqual(["2", "1", "3"]);
    expect(searchApps(apps, "zzz")).toEqual([]);
  });

  it("sanitizes stored preferences", () => {
    expect(sanitizeAppPreferences({ favorites: ["a", "a", 3], recents: [{ id: "b", at: 1 }, { id: 2 }] })).toEqual({
      favorites: ["a"],
      recents: [{ id: "b", at: 1 }],
    });
  });
});

describe("media", () => {
  it("names common players", () => {
    expect(sourceAppName("Spotify.exe")).toBe("Spotify");
    expect(sourceAppName("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic")).toBe("Media Player");
    expect(sourceAppName("MSEdge")).toBe("Microsoft Edge");
    expect(sourceAppName("foobar2000.exe")).toBe("Foobar2000");
  });

  it("formats track times", () => {
    expect(formatTrackTime(65_000)).toBe("1:05");
    expect(formatTrackTime(3_725_000)).toBe("1:02:05");
  });
});

describe("live information", () => {
  it("maps WMO weather codes", () => {
    expect(describeWeather(0).label).toBe("Clear");
    expect(describeWeather(63).label).toBe("Rain");
    expect(describeWeather(81).label).toBe("Rain showers");
    expect(describeWeather(75).label).toBe("Snow");
    expect(describeWeather(99).label).toBe("Thunderstorm with hail");
  });

  it("merges feeds newest first", () => {
    const feeds = [
      { url: "https://a.example/feed", title: "A" },
      { url: "https://b.example/feed", title: "B" },
    ];
    const merged = mergeFeeds(feeds, [
      { title: "A", items: [{ title: "old", link: null, published: "Sun, 01 Nov 2026 08:00:00 GMT" }] },
      { title: "B", items: [{ title: "new", link: "https://b.example/1", published: "2026-11-01T10:00:00Z" }] },
    ]);
    expect(merged.map((i) => [i.title, i.source])).toEqual([
      ["new", "B"],
      ["old", "A"],
    ]);
    expect(parseFeedDate("not a date")).toBe(0);
  });

  it("computes time progress", () => {
    const p = progressOf(new Date(2026, 0, 1, 12, 0));
    expect(p.day).toBeCloseTo(50, 5);
    expect(p.year).toBeGreaterThan(0);
    expect(p.year).toBeLessThan(1);
  });
});

describe("system helpers", () => {
  it("picks the busiest reporting GPU", () => {
    expect(primaryGpuUsage({ gpus: [] })).toBeNull();
    expect(
      primaryGpuUsage({
        gpus: [
          { name: "A", vendor: null, usage: null, memoryUsed: null, memoryTotal: null },
          { name: "B", vendor: null, usage: 42, memoryUsed: null, memoryTotal: null },
        ],
      }),
    ).toBe(42);
  });

  it("sorts and filters processes", () => {
    const list = [
      { pid: 1, name: "b.exe", cpu: 5, memory: 10 },
      { pid: 2, name: "a.exe", cpu: 20, memory: 5 },
      { pid: 3, name: "c.exe", cpu: 20, memory: 50 },
    ];
    expect(sortProcesses(list, "cpu", true, "").map((p) => p.pid)).toEqual([2, 3, 1]);
    expect(sortProcesses(list, "memory", true, "").map((p) => p.pid)).toEqual([3, 1, 2]);
    expect(sortProcesses(list, "name", false, "").map((p) => p.name)).toEqual(["a.exe", "b.exe", "c.exe"]);
    expect(sortProcesses(list, "cpu", true, "C.EXE").map((p) => p.pid)).toEqual([3]);
    expect(sortProcesses(list, "cpu", true, "1").map((p) => p.pid)).toEqual([1]);
  });

  it("formats network rates in bits", () => {
    expect(formatBitRate(125_000)).toBe("1.0 Mbit/s");
    expect(formatBitRate(0)).toBe("0 bit/s");
  });
});

describe("profiles", () => {
  it("restores presets and drops invalid entries", () => {
    const profiles = sanitizeProfiles([{ id: "x", name: "Bad", kind: "hacker" }, { id: "c1", name: "Mine", kind: "custom", layoutId: null, accent: { kind: "preset", id: "cyan" }, transparency: true, sidebarCollapsed: false }]);
    expect(profiles.some((p) => p.id === "preset-gaming")).toBe(true);
    expect(profiles.some((p) => p.id === "x")).toBe(false);
    expect(profiles.find((p) => p.id === "c1")?.wallpaperBackdrop).toBe(true);
    expect(sanitizeProfiles("garbage").length).toBe(4);
  });
});

describe("settings for new modules", () => {
  it("validates weather places and feeds", () => {
    expect(sanitizeSettings({ weatherPlace: { name: "Berlin", latitude: 52.5, longitude: 13.4 } }).weatherPlace).toMatchObject({ name: "Berlin", country: "" });
    expect(sanitizeSettings({ weatherPlace: { name: "X", latitude: 300, longitude: 0 } }).weatherPlace).toBeUndefined();
    expect(sanitizeSettings({ weatherPlace: null }).weatherPlace).toBeNull();
    expect(sanitizeSettings({ newsFeeds: [{ url: "javascript:alert(1)", title: "x" }, { url: "https://ok.example/rss", title: "OK" }] }).newsFeeds).toEqual([
      { url: "https://ok.example/rss", title: "OK" },
    ]);
  });
});

describe("notification center", () => {
  it("keeps history, toasts briefly and tracks unread", () => {
    const store = useNotifications.getState();
    store.clear();
    store.notify({ title: "One" });
    store.notify({ title: "Two", toast: false });
    const state = useNotifications.getState();
    expect(state.items.map((i) => i.title)).toEqual(["Two", "One"]);
    expect(state.toasts).toHaveLength(1);
    expect(state.items.every((i) => !i.read)).toBe(true);
    state.setCenterOpen(true);
    expect(useNotifications.getState().items.every((i) => i.read)).toBe(true);
    state.setCenterOpen(false);
  });
});
