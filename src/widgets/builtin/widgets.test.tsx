import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as native from "@/lib/native";
import { NativeUnavailableError } from "@/lib/native";
import { useMetricHistory } from "@/features/system/history";
import { renderWidget } from "@/test/render";
import { formatOffset, zoneOffsetMinutes } from "./ClockWidget";

const GB = 1024 ** 3;

const SNAPSHOT = {
  timestampMs: 1_793_000_000_000,
  cpuUsage: 37.4,
  cpuFrequencyMhz: 2000,
  memoryUsed: 6 * GB,
  memoryTotal: 8 * GB,
  swapUsed: 1 * GB,
  swapTotal: 4 * GB,
  uptimeSeconds: 7200,
};

const VOLUMES = [
  { name: "", mountPoint: "C:\\", fileSystem: "NTFS", totalBytes: 200 * GB, availableBytes: 50 * GB, kind: "ssd", removable: false },
  { name: "USB", mountPoint: "E:\\", fileSystem: "FAT32", totalBytes: 16 * GB, availableBytes: 8 * GB, kind: "unknown", removable: true },
];

function mockNative(responses: Record<string, unknown>) {
  vi.spyOn(native, "callNative").mockImplementation(async (command: string) => {
    if (command in responses) return responses[command];
    throw new Error(`unexpected command ${command}`);
  });
}

describe("system widgets", () => {
  beforeEach(() => useMetricHistory.getState().clear());

  it("explain that the desktop runtime is required in a plain browser", async () => {
    vi.spyOn(native, "callNative").mockRejectedValue(new NativeUnavailableError("system_snapshot"));
    renderWidget("memory");

    expect(await screen.findByText("Desktop runtime required")).toBeInTheDocument();
    // Retrying cannot help here, so no retry button is offered.
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("offer a retry for genuine failures", async () => {
    vi.spyOn(native, "callNative").mockRejectedValue(new Error("sensor read failed"));
    renderWidget("memory");

    expect(await screen.findByText("sensor read failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("render real memory figures from the native snapshot", async () => {
    mockNative({ system_snapshot: SNAPSHOT });
    renderWidget("memory");

    expect(await screen.findByText("75%")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Memory in use" })).toHaveAttribute("aria-valuenow", "75");
    expect(screen.getByText("Page file 1.0 GB of 4.0 GB")).toBeInTheDocument();
  });

  it("honor the memory widget's page-file setting", async () => {
    mockNative({ system_snapshot: SNAPSHOT });
    renderWidget("memory", { showPageFile: false });

    expect(await screen.findByText("75%")).toBeInTheDocument();
    expect(screen.queryByText(/Page file/)).not.toBeInTheDocument();
  });

  it("render CPU usage and record session history", async () => {
    mockNative({
      system_snapshot: SNAPSHOT,
      system_info: { cpuBrand: "Intel(R) Core(TM) i3-6006U CPU @ 2.00GHz", physicalCores: 2, logicalCores: 4 },
    });
    renderWidget("cpu");

    expect(await screen.findByText("37")).toBeInTheDocument();
    expect(await screen.findByText("Intel Core i3-6006U")).toBeInTheDocument();
    expect(screen.getByText("2.00 GHz")).toBeInTheDocument();
    expect(screen.getByLabelText("CPU usage over this session")).toBeInTheDocument();
    expect(useMetricHistory.getState().samples).toHaveLength(1);
  });

  it("hide the CPU chart when configured", async () => {
    mockNative({ system_snapshot: SNAPSHOT, system_info: { cpuBrand: null, physicalCores: null, logicalCores: 4 } });
    renderWidget("cpu", { showChart: false });

    expect(await screen.findByText("37")).toBeInTheDocument();
    expect(screen.queryByLabelText("CPU usage over this session")).not.toBeInTheDocument();
  });

  it("list storage volumes with free space, optionally hiding removable drives", async () => {
    mockNative({ storage_volumes: VOLUMES });
    const { unmount } = renderWidget("storage");

    expect(await screen.findByText("Local Disk (C:)")).toBeInTheDocument();
    expect(screen.getByText("50.0 GB free of 200.0 GB")).toBeInTheDocument();
    expect(screen.getByText("75% used")).toBeInTheDocument();
    expect(screen.getByText("USB (E:)")).toBeInTheDocument();
    unmount();

    renderWidget("storage", { showRemovable: false });
    expect(await screen.findByText("Local Disk (C:)")).toBeInTheDocument();
    expect(screen.queryByText("USB (E:)")).not.toBeInTheDocument();
  });

  it("hide the device name for screen sharing", async () => {
    mockNative({
      system_info: { hostName: "LAPTOP-123", osName: "Windows 10 Home", osVersion: "10", cpuBrand: null, totalMemory: 8 * GB, arch: "x86_64" },
      system_snapshot: SNAPSHOT,
    });
    renderWidget("device", { showDeviceName: false });

    expect(await screen.findByText("Windows 10 Home")).toBeInTheDocument();
    expect(screen.queryByText("LAPTOP-123")).not.toBeInTheDocument();
  });
});

describe("world clock", () => {
  it("computes zone offsets relative to local time", () => {
    const date = new Date();
    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(zoneOffsetMinutes(date, localZone)).toBe(0);
    // Kolkata never observes DST and is UTC+5:30.
    expect(zoneOffsetMinutes(date, "Asia/Kolkata")).toBe(330 + date.getTimezoneOffset());
  });

  it("formats offsets", () => {
    expect(formatOffset(0)).toBe("Same as local time");
    expect(formatOffset(360)).toBe("+6 h from local");
    expect(formatOffset(-330)).toBe("−5:30 h from local");
  });

  it("renders the configured city", () => {
    renderWidget("clock", { timeZone: "Asia/Tokyo" });
    expect(screen.getByRole("heading", { name: "Tokyo" })).toBeInTheDocument();
  });

  it("falls back to local time for an unknown zone", () => {
    renderWidget("clock", { timeZone: "Mars/Olympus_Mons" });
    expect(screen.getByRole("heading", { name: "Local time" })).toBeInTheDocument();
  });
});

describe("clock styles", () => {
  it("keep the digital look by default", () => {
    renderWidget("clock");
    expect(screen.getByRole("heading", { name: "Local time" })).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("fall back to digital for an unknown style", () => {
    renderWidget("clock", { style: "sundial" });
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("render every style in the world clock and the welcome widget", () => {
    vi.spyOn(native, "callNative").mockRejectedValue(new NativeUnavailableError("system_snapshot"));
    for (const widget of ["clock", "welcome"]) {
      for (const style of ["digital", "minimal", "analog", "flip"]) {
        const { unmount } = renderWidget(widget, { style });
        // The world clock's digital style is the one face without a time label.
        if (widget !== "clock" || style !== "digital") expect(screen.getByLabelText(/^Current time /), `${widget} ${style}`).toBeInTheDocument();
        unmount();
      }
      const { unmount } = renderWidget(widget, { style: "words" });
      expect(screen.getByText(/^It's /), `${widget} words`).toBeInTheDocument();
      unmount();
    }
  });

  it("show only the time in the minimal world clock", () => {
    renderWidget("clock", { style: "minimal", timeZone: "Asia/Tokyo" });
    expect(screen.getByRole("region", { name: "Tokyo" })).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});

describe("analog clock widget", () => {
  it("draws numbers and a second hand only when configured", () => {
    const { container, unmount } = renderWidget("analog-clock");
    expect(screen.getByRole("img", { name: /^Current time / })).toBeInTheDocument();
    expect(container.querySelector("[data-hand='second']")).toBeNull();
    expect(container.querySelectorAll("text")).toHaveLength(0);
    unmount();

    const configured = renderWidget("analog-clock", { showSeconds: true, showNumbers: true });
    expect(configured.container.querySelector("[data-hand='second']")).not.toBeNull();
    expect(configured.container.querySelectorAll("text")).toHaveLength(12);
  });

  it("names a configured zone", () => {
    renderWidget("analog-clock", { timeZone: "Asia/Tokyo" });
    expect(screen.getByText("Tokyo")).toBeInTheDocument();
  });
});
