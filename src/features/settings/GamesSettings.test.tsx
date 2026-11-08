import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as native from "@/lib/native";
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
    expect(await screen.findByText(/36 MB to download once/)).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "Clip das!" }));
    expect(call).toHaveBeenCalledWith("replay_configure", { update: { enabled: true, discordName: "" } });
    expect(call).toHaveBeenCalledWith("replay_install");
    expect(await screen.findByText(/Downloading ffmpeg… 12 of 36 MB/)).toBeInTheDocument();
  });

  it("says how clips work once ready", async () => {
    status = { ...OFF, enabled: true, installed: true, encoder: "NVIDIA" };
    renderWithQuery(<GamesSettings />);
    expect(await screen.findByText(/recorded on your graphics card \(NVIDIA\)/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is recorded outside games/)).toBeInTheDocument();
  });

  it("saves a Discord channel and its name", async () => {
    const user = userEvent.setup();
    renderWithQuery(<GamesSettings />);
    await user.type(await screen.findByLabelText("What you call it"), "die Jungs");
    await user.tab();
    await waitFor(() => expect(call).toHaveBeenCalledWith("replay_configure", { update: { enabled: false, discordName: "die Jungs" } }));
    await user.type(screen.getByLabelText("Discord channel"), "https://discord.com/api/webhooks/1/abc");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(call).toHaveBeenCalledWith("replay_discord_set", { webhook: "https://discord.com/api/webhooks/1/abc" });
    expect(await screen.findByText(/Saved\. Say “Schick das an die Jungs”/)).toBeInTheDocument();
  });
});
