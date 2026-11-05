import { describe, expect, it } from "vitest";
import { columnSpan } from "@/features/home/DashboardGrid";
import { profileFromName } from "@/features/profile/useProfile";
import { volumeLabel } from "@/widgets/builtin/StorageWidget";
import { clockParts } from "@/widgets/builtin/clocks/time";
import { buildMonthGrid, weekdayLabels } from "./calendar";
import { formatBytes, formatFrequency, formatUptime, prettifyCpuBrand, ratioPercent } from "./format";
import { dayOfYear, greetingFor, isoWeek } from "./time";

describe("format", () => {
  it("formats binary sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(8 * 1024 ** 3)).toBe("8.0 GB");
    expect(formatBytes(-1)).toBe("—");
  });

  it("guards ratio edge cases", () => {
    expect(ratioPercent(5, 0)).toBe(0);
    expect(ratioPercent(150, 100)).toBe(100);
    expect(ratioPercent(1, 4)).toBe(25);
  });

  it("formats uptime compactly", () => {
    expect(formatUptime(59)).toBe("0m");
    expect(formatUptime(3 * 3600 + 12 * 60)).toBe("3h 12m");
    expect(formatUptime(2 * 86400 + 5 * 3600)).toBe("2d 5h");
  });

  it("formats frequency", () => {
    expect(formatFrequency(2000)).toBe("2.00 GHz");
    expect(formatFrequency(800)).toBe("800 MHz");
    expect(formatFrequency(0)).toBe("—");
  });

  it("removes trademark noise from CPU names", () => {
    expect(prettifyCpuBrand("Intel(R) Core(TM) i3-6006U CPU @ 2.00GHz")).toBe("Intel Core i3-6006U");
    expect(prettifyCpuBrand("AMD Ryzen 7 5800X 8-Core Processor")).toBe("AMD Ryzen 7 5800X 8-Core Processor");
  });
});

describe("time", () => {
  it("greets by time of day", () => {
    expect(greetingFor(new Date(2026, 10, 1, 8))).toBe("Good morning");
    expect(greetingFor(new Date(2026, 10, 1, 14))).toBe("Good afternoon");
    expect(greetingFor(new Date(2026, 10, 1, 20))).toBe("Good evening");
    expect(greetingFor(new Date(2026, 10, 1, 2))).toBe("Good night");
  });

  it("computes ISO weeks, including year boundaries", () => {
    expect(isoWeek(new Date(2026, 10, 1))).toBe(44);
    expect(isoWeek(new Date(2021, 0, 3))).toBe(53);
    expect(isoWeek(new Date(2024, 11, 30))).toBe(1);
  });

  it("computes day of year", () => {
    expect(dayOfYear(new Date(2026, 0, 1))).toBe(1);
    expect(dayOfYear(new Date(2026, 10, 1))).toBe(305);
  });

  it("splits clock parts for 24h and 12h formats", () => {
    const date = new Date(2026, 10, 1, 18, 5, 9);
    expect(clockParts(date, true, "en-GB")).toEqual({ time: "18:05", hour: "18", minute: "05", seconds: "09", period: null });
    expect(clockParts(date, false, "en-US")).toMatchObject({ time: "6:05", period: "PM" });
  });
});

describe("calendar", () => {
  it("builds a Monday-first 6-week grid", () => {
    const grid = buildMonthGrid(2026, 10, 1, new Date(2026, 10, 1));
    expect(grid).toHaveLength(42);
    // 1 Nov 2026 is a Sunday, so the grid starts on Monday 26 Oct.
    expect(grid[0]!.date.getDate()).toBe(26);
    expect(grid[0]!.inMonth).toBe(false);
    expect(grid.filter((d) => d.isToday)).toHaveLength(1);
    expect(grid[6]!.isToday).toBe(true);
  });

  it("builds a Sunday-first grid", () => {
    const grid = buildMonthGrid(2026, 10, 0, new Date(2026, 10, 15));
    expect(grid[0]!.date.getDate()).toBe(1);
    expect(grid[0]!.isWeekend).toBe(true);
  });

  it("labels weekdays from the week start", () => {
    expect(weekdayLabels("en-GB", 1)[0]).toBe("M");
    expect(weekdayLabels("en-US", 0)[0]).toBe("S");
  });
});

describe("dashboard helpers", () => {
  it("maps 12-column widths onto narrower grids", () => {
    expect(columnSpan(8, 12)).toBe(8);
    expect(columnSpan(8, 6)).toBe(4);
    expect(columnSpan(4, 6)).toBe(2);
    expect(columnSpan(12, 6)).toBe(6);
    expect(columnSpan(1, 6)).toBe(1);
  });

  it("derives profile names and initials", () => {
    expect(profileFromName("Luca Warmers")).toEqual({ fullName: "Luca Warmers", firstName: "Luca", initials: "LW" });
    expect(profileFromName("  ada ")).toEqual({ fullName: "ada", firstName: "ada", initials: "A" });
    expect(profileFromName("")).toEqual({ fullName: null, firstName: null, initials: "N" });
  });

  it("labels volumes like Explorer", () => {
    expect(volumeLabel({ name: "", mountPoint: "C:\\" })).toBe("Local Disk (C:)");
    expect(volumeLabel({ name: "Data", mountPoint: "D:\\" })).toBe("Data (D:)");
  });
});
