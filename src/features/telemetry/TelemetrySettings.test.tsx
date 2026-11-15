import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRecentSettings } from "@/features/settings/recent";
import * as native from "@/lib/native";
import { renderWithQuery } from "@/test/render";
import type { TelemetryStatus } from "./api";
import { TelemetrySettings } from "./TelemetrySettings";

const OFF: TelemetryStatus = { needsDecision: false, accepted: false, decidedAt: null, installId: null, displayName: null, lastSent: null, lastError: null, waiting: 0, privacyUrl: "https://example.test/privacy", host: "example.test" };

describe("the statistics switch in Settings", () => {
  let status: TelemetryStatus;
  let call: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    status = { ...OFF };
    useRecentSettings.setState({ recent: [] });
    vi.spyOn(native, "isDesktop").mockReturnValue(true);
    call = vi.spyOn(native, "callNative").mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "telemetry_decide") status = { ...status, accepted: args?.accepted === true, decidedAt: Date.UTC(2026, 10, 11, 12) };
      else if (command === "telemetry_name") status = { ...status, displayName: (args?.name as string | null) ?? null };
      else if (command === "telemetry_recent") return [];
      else if (command !== "telemetry_status") throw new Error(`unexpected ${command}`);
      return status;
    });
  });

  it("turns statistics on at once, and asks before it stops and deletes", async () => {
    const user = userEvent.setup();
    renderWithQuery(<TelemetrySettings />);
    expect(await screen.findByText("Aus. NOVA sendet keine Statistik.")).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Nutzungsstatistik senden" }));
    expect(call).toHaveBeenCalledWith("telemetry_decide", { accepted: true });
    expect(await screen.findByText(/Geht an example\.test/)).toBeInTheDocument();
    expect(useRecentSettings.getState().recent[0]).toMatchObject({ section: "privacy", label: "Nutzungsstatistik senden" });

    // Off is asked first; backing out changes nothing.
    useRecentSettings.setState({ recent: [] });
    await user.click(screen.getByRole("switch", { name: "Nutzungsstatistik senden" }));
    expect(screen.getByText(/löscht die Daten dieses PCs/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(status.accepted).toBe(true);
    expect(useRecentSettings.getState().recent).toEqual([]);

    await user.click(screen.getByRole("switch", { name: "Nutzungsstatistik senden" }));
    await user.click(screen.getByRole("button", { name: "Stoppen und löschen" }));
    await waitFor(() => expect(status.accepted).toBe(false));
    expect(call).toHaveBeenCalledWith("telemetry_decide", { accepted: false });
  });

  it("shows what is sent only when asked", async () => {
    status = { ...OFF, accepted: true, decidedAt: Date.UTC(2026, 10, 11, 12) };
    const user = userEvent.setup();
    renderWithQuery(<TelemetrySettings />);
    const show = await screen.findByRole("button", { name: "Zeigen, was gesendet wird" });
    expect(call).not.toHaveBeenCalledWith("telemetry_recent");
    await user.click(show);
    expect(await screen.findByText("Noch nichts.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gesendetes ausblenden" })).toHaveAttribute("aria-expanded", "true");
  });
});
