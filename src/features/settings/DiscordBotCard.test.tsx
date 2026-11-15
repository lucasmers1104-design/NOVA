import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as native from "@/lib/native";
import { useSettings } from "@/stores/settings";
import { renderWithQuery } from "@/test/render";
import { DiscordBotCard, type DiscordBotStatus } from "./DiscordBotCard";

const TOKEN = "x".repeat(60);
const WEBHOOK = "https://discord.com/api/webhooks/1/abc";
const NONE: DiscordBotStatus = { configured: false, chat: false, bot: false, label: null };

describe("DiscordBotCard", () => {
  let status: DiscordBotStatus;
  let call: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    status = { ...NONE };
    useSettings.setState({ displayName: "Luca" });
    vi.spyOn(native, "isDesktop").mockReturnValue(true);
    call = vi.spyOn(native, "callNative").mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "discord_chat_set") status = { ...status, chat: Boolean(args?.webhook), label: String(args?.label || status.label || "") || null };
      if (command === "discord_bot_set") status = { ...status, bot: Boolean(args?.token) };
      if (command === "discord_bot_check") return "NOVA";
      status = { ...status, configured: status.chat || status.bot };
      return status;
    });
  });

  it("saves a shared chat webhook and shows the sender's name", async () => {
    const user = userEvent.setup();
    renderWithQuery(<DiscordBotCard />);
    await user.type(await screen.findByLabelText("Discord-Chat"), WEBHOOK);
    await user.type(screen.getByLabelText("Name des Kanals"), "die Jungs");
    await user.click(screen.getByRole("button", { name: "Chat speichern" }));
    expect(call).toHaveBeenCalledWith("discord_chat_set", { webhook: WEBHOOK, label: "die Jungs" });
    expect(await screen.findByText(/Gespeichert für die Jungs\. Deine Nachrichten erscheinen als „Luca · via Nova“/)).toBeInTheDocument();
  });

  it("checks and removes a saved chat", async () => {
    status = { configured: true, chat: true, bot: false, label: "die Jungs" };
    const user = userEvent.setup();
    renderWithQuery(<DiscordBotCard />);
    await user.click(await screen.findByRole("button", { name: "Prüfen" }));
    expect(call).toHaveBeenCalledWith("discord_bot_check");
    await user.click(screen.getByRole("button", { name: "Entfernen" }));
    expect(call).toHaveBeenCalledWith("discord_chat_set", { webhook: "", label: "" });
    expect(await screen.findByLabelText("Discord-Chat")).toBeInTheDocument();
  });

  it("sets up an own bot only once token and channel are filled in", async () => {
    const user = userEvent.setup();
    renderWithQuery(<DiscordBotCard />);
    await user.click(await screen.findByRole("button", { name: "Einrichten" }));
    await user.type(screen.getByLabelText("Discord-Bot"), TOKEN);
    expect(screen.getByRole("button", { name: "Bot speichern" })).toBeDisabled();
    await user.type(screen.getByLabelText("Kanal-ID"), "123456789012345678");
    await user.click(screen.getByRole("button", { name: "Bot speichern" }));
    expect(call).toHaveBeenCalledWith("discord_bot_set", { token: TOKEN, channelId: "123456789012345678", label: "" });
    expect(await screen.findByText(/Eigener Bot, nur auf diesem PC\. Nachrichten erscheinen unter dem Namen des Bots/)).toBeInTheDocument();
  });
});
