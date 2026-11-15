import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayStatus } from "@/features/settings/GamesSettings";
import * as native from "@/lib/native";
import { renderWithQuery } from "@/test/render";
import { ClipDiscordCard } from "./ClipDiscordCard";

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

describe("ClipDiscordCard", () => {
  let status: ReplayStatus;
  let call: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    status = { ...OFF };
    vi.spyOn(native, "isDesktop").mockReturnValue(true);
    call = vi.spyOn(native, "callNative").mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "replay_configure") status = { ...status, ...(args?.update as object) };
      if (command === "replay_discord_set") {
        if (!String(args?.webhook).startsWith("https://discord.com/api/webhooks/")) throw new Error("That isn't a Discord webhook address.");
        status = { ...status, discordSet: true };
      }
      return status;
    });
  });

  it("saves the clip channel and its name", async () => {
    const user = userEvent.setup();
    renderWithQuery(<ClipDiscordCard />);
    await user.type(await screen.findByLabelText("So nennst du ihn"), "die Jungs");
    await user.tab();
    await waitFor(() => expect(call).toHaveBeenCalledWith("replay_configure", { update: { enabled: false, discordName: "die Jungs" } }));
    await user.type(screen.getByLabelText("Discord-Kanal"), "https://discord.com/api/webhooks/1/abc");
    await user.click(screen.getByRole("button", { name: "Speichern" }));
    expect(call).toHaveBeenCalledWith("replay_discord_set", { webhook: "https://discord.com/api/webhooks/1/abc" });
    expect(await screen.findByText(/Gespeichert\. Sag „Schick das an die Jungs“/)).toBeInTheDocument();
  });
});
