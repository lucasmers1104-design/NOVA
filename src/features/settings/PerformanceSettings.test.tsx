import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as native from "@/lib/native";
import { useUi } from "@/stores/ui";
import { renderWithQuery } from "@/test/render";
import { megabytes, MEMORY_POLL_MS, type MemoryReport, PerformanceSettings, type PerformanceStatus } from "./PerformanceSettings";
import { searchSettings } from "./SettingsPage";

const MB = 1024 * 1024;

const IDLE: MemoryReport = {
  privateBytes: 356 * MB,
  workingBytes: 210 * MB,
  processes: 6,
  parts: [
    { part: "nova", processes: 1, privateBytes: 48 * MB, workingBytes: 60 * MB },
    { part: "webView", processes: 5, privateBytes: 308 * MB, workingBytes: 150 * MB },
  ],
};

describe("PerformanceSettings", () => {
  let status: PerformanceStatus;
  let memory: MemoryReport;
  let call: ReturnType<typeof vi.spyOn>;
  /** How often `command` went to Rust. */
  const sent = (command: string) => call.mock.calls.filter((args: unknown[]) => args[0] === command).length;

  beforeEach(() => {
    status = { prefs: { releaseMainWindow: true, panelIdleMinutes: 5 }, timings: { mainReopenMs: null, panelOpenMs: null } };
    memory = IDLE;
    vi.spyOn(native, "isDesktop").mockReturnValue(true);
    call = vi.spyOn(native, "callNative").mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "performance_memory") return memory;
      if (command === "performance_configure") status = { ...status, prefs: args?.prefs as PerformanceStatus["prefs"] };
      return status;
    });
  });

  it("shows what NOVA uses, part by part", async () => {
    renderWithQuery(<PerformanceSettings />);
    expect(await screen.findByText("356 MB")).toBeInTheDocument();
    expect(screen.getByText(/in 6 Prozesse · davon gerade im RAM: 210 MB/)).toBeInTheDocument();
    expect(screen.getByText("48 MB")).toBeInTheDocument();
    expect(screen.getByText("308 MB")).toBeInTheDocument();
    expect(screen.getByText(/5 Prozesse/)).toBeInTheDocument();
    expect(screen.getByText(/Gerade ist nichts geladen/)).toBeInTheDocument();
  });

  it("says when the speech processes hold memory", async () => {
    memory = { ...IDLE, privateBytes: 1056 * MB, processes: 7, parts: [...IDLE.parts, { part: "speech", processes: 1, privateBytes: 700 * MB, workingBytes: 690 * MB }] };
    renderWithQuery(<PerformanceSettings />);
    expect(await screen.findByText("1,03 GB")).toBeInTheDocument();
    expect(screen.getByText(/Gerade geladen: 700 MB in 1 Prozess\./)).toBeInTheDocument();
  });

  it("measures again every two seconds, and only while the section is shown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { unmount } = renderWithQuery(<PerformanceSettings />);
      await screen.findByText("356 MB");
      const readings = () => sent("performance_memory");
      expect(readings()).toBe(1);
      memory = { ...IDLE, privateBytes: 361 * MB };
      await vi.advanceTimersByTimeAsync(MEMORY_POLL_MS + 50);
      expect(await screen.findByText("361 MB")).toBeInTheDocument();
      expect(readings()).toBe(2);
      // Not faster than that, however often the page draws.
      await vi.advanceTimersByTimeAsync(MEMORY_POLL_MS - 200);
      expect(readings()).toBe(2);
      unmount();
      await vi.advanceTimersByTimeAsync(MEMORY_POLL_MS * 5);
      expect(readings()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the main window stay in memory if the user wants that", async () => {
    const user = userEvent.setup();
    renderWithQuery(<PerformanceSettings />);
    const release = await screen.findByRole("switch", { name: "Hauptfenster beim Schließen freigeben" });
    expect(release).toBeChecked();
    await user.click(release);
    expect(release).not.toBeChecked();
    await waitFor(() => expect(call).toHaveBeenCalledWith("performance_configure", { prefs: { releaseMainWindow: false, panelIdleMinutes: 5 } }));
  });

  it("sets how long the closed panel stays, down to never ending it", async () => {
    renderWithQuery(<PerformanceSettings />);
    const slider = await screen.findByRole("slider", { name: "NOVA-AI-Fenster freigeben nach" });
    expect(slider).toHaveAttribute("aria-valuetext", "5 min");
    // Dragged over several values: the slider follows at once, and one save follows the last.
    for (const value of ["12", "3", "0"]) fireEvent.change(slider, { target: { value } });
    expect(slider).toHaveAttribute("aria-valuetext", "Nie");
    await waitFor(() => expect(call).toHaveBeenCalledWith("performance_configure", { prefs: { releaseMainWindow: true, panelIdleMinutes: 0 } }));
    expect(sent("performance_configure")).toBe(1);
  });

  it("saves a change that still waits when the page is left", async () => {
    const { unmount } = renderWithQuery(<PerformanceSettings />);
    fireEvent.change(await screen.findByRole("slider", { name: "NOVA-AI-Fenster freigeben nach" }), { target: { value: "20" } });
    unmount();
    expect(call).toHaveBeenCalledWith("performance_configure", { prefs: { releaseMainWindow: true, panelIdleMinutes: 20 } });
  });

  it("shows how long the windows took to come back", async () => {
    status = { ...status, timings: { mainReopenMs: 312, panelOpenMs: 1240 } };
    renderWithQuery(<PerformanceSettings />);
    expect(await screen.findByText(/Zuletzt wieder da nach 312 ms\./)).toBeInTheDocument();
    expect(screen.getByText(/Zuletzt neu geöffnet in 1\.240 ms\./)).toBeInTheDocument();
  });

  it("leads to the speech mode", async () => {
    const user = userEvent.setup();
    renderWithQuery(<PerformanceSettings />);
    await user.click(await screen.findByRole("button", { name: "Modus ändern" }));
    expect(useUi.getState().settingsSection).toBe("local-ai");
  });

  it("needs the desktop app", () => {
    vi.spyOn(native, "isDesktop").mockReturnValue(false);
    renderWithQuery(<PerformanceSettings />);
    expect(screen.getByText("Das gibt es in der NOVA-Desktop-App.")).toBeInTheDocument();
    expect(call).not.toHaveBeenCalled();
  });

  it("is found by the search, by the names its rows show", () => {
    expect(searchSettings("ram")[0]?.section).toBe("performance");
    expect(searchSettings("arbeitsspeicher").map((s) => s.label)).toEqual(["Arbeitsspeicher"]);
    expect(megabytes(0)).toBe("0 MB");
    expect(megabytes(1023.6 * MB)).toBe("1.024 MB");
    expect(megabytes(2048 * MB)).toBe("2,00 GB");
  });
});
