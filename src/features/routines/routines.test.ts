import { describe, expect, it } from "vitest";
import { clockTime, relativeDueLabel } from "@/features/productivity/model";
import { conditionText, scheduleText, stepText } from "./RoutinesPage";

describe("routines page", () => {
  it("says steps in a few words", () => {
    expect(stepText({ tool: "open_app", input: { name: "Discord" } })).toBe("Open Discord");
    expect(stepText({ tool: "app_volume", input: { action: "set", program: "discord", level: 30 } })).toBe("Volume set discord 30");
    expect(stepText({ tool: "wait", input: { seconds: 5 } })).toBe("Wait 5");
    expect(stepText({ tool: "something_new", input: null })).toBe("something_new");
  });

  it("says what a watcher waits for", () => {
    expect(conditionText({ type: "gameReady", game: "Fortnite" })).toContain("Fortnite");
    expect(conditionText({ type: "cpuAbove", percent: 90 })).toContain("90 %");
    expect(conditionText({ type: "downloadsDone" })).toContain("downloads");
    expect(conditionText({ type: "newVideo", channel: "MrBeast" })).toContain("MrBeast");
  });

  it("says when a routine runs, on the user's clock", () => {
    expect(scheduleText({ time: null, days: [] }, true, "en-GB")).toBeNull();
    expect(scheduleText({ time: "08:00", days: [] }, true, "en-GB")).toBe("Every day at 08:00");
    expect(scheduleText({ time: "14:30", days: [1, 3] }, false, "en-US")).toMatch(/^Mon, Wed at 2:30\sPM$/);
  });
});

describe("the 24-hour setting", () => {
  it("shows task times as the user's clock does", () => {
    expect(clockTime("14:30", true, "en-US")).toBe("14:30");
    expect(clockTime("14:30", false, "en-US")).toMatch(/^2:30\sPM$/);
    expect(clockTime("00:05", false, "en-US")).toMatch(/^12:05\sAM$/);
    const now = new Date(2026, 10, 7, 9, 0);
    expect(relativeDueLabel({ dueDate: "2026-11-07", dueTime: "14:30" }, now, "en-US", false)).toMatch(/^Today 2:30\sPM$/);
    expect(relativeDueLabel({ dueDate: "2026-11-07", dueTime: "14:30" }, now, "en-US")).toBe("Today 14:30");
  });
});
