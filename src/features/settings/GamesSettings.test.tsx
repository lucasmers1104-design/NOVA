import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as native from "@/lib/native";
import { useUi } from "@/stores/ui";
import { renderWithQuery } from "@/test/render";
import { GamesSettings, type ReplayStatus } from "./GamesSettings";

const OFF: ReplayStatus = {
  enabled: false,
  installed: false,
  downloading: null,
  downloadSize: 35_563_623,
  recording: false,
  encoder: null,
  error: null,
  folder: "C:\\Users\\Luca\\Videos\\NOVA Clips",
  discordName: "",
  discordSet: false,
};

describe("GamesSettings", () => {
  let status: ReplayStatus;
  let call: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    status = { ...OFF };
    vi.spyOn(native, "isDesktop").mockReturnValue(true);
    call = vi.spyOn(native, "callNative").mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "replay_status") return status;
      if (command === "replay_configure") status = { ...status, ...(args?.update as object) };
      if (command === "replay_install") status = { ...status, downloading: 12_000_000 };
      if (command === "replay_discord_set") {
        if (!String(args?.webhook).startsWith("https://discord.com/api/webhooks/")) throw new Error("That isn't a Discord webhook address.");
        status = { ...status, discordSet: true };
      }
      return status;
    });
  });

  it("turns clips on and downloads ffmpeg once", async () => {
    const user = userEvent.setup();
    renderWithQuery(<GamesSettings />);
    expect(await screen.findByText(/36 MB, einmal herunterzuladen/)).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Clip das!" }));
    expect(call).toHaveBeenCalledWith("replay_configure", { update: { enabled: true, discordName: "" } });
    expect(call).toHaveBeenCalledWith("replay_install");
    expect(await screen.findByText(/ffmpeg wird geladen … 12 von 36 MB/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "ffmpeg wird geladen" })).toHaveAttribute("aria-valuenow", "34");
  });

  it("says how clips work once ready", async () => {
    status = { ...OFF, enabled: true, installed: true, encoder: "NVIDIA" };
    renderWithQuery(<GamesSettings />);
    expect(await screen.findByText(/aufgenommen über deine Grafikkarte \(NVIDIA\)/)).toBeInTheDocument();
    expect(screen.getByText(/Außerhalb von Spielen wird nichts aufgenommen/)).toBeInTheDocument();
  });

  it("points to the Discord tab for sending clips", async () => {
    const user = userEvent.setup();
    renderWithQuery(<GamesSettings />);
    await user.click(await screen.findByRole("button", { name: "Zum Discord-Tab" }));
    expect(useUi.getState().route).toBe("discord");
  });
});
