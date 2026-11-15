import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as native from "@/lib/native";
import { renderWithQuery } from "@/test/render";
import { examples, hostOf, parseInvite, type RelayServers, type RelayStatus } from "./api";
import DiscordPage from "./DiscordPage";

const KEY = `nova_0123abcd_${"k".repeat(43)}`;
const ADDRESS = "https://relay.example.test";
const SERVERS: RelayServers = {
  servers: [
    {
      id: "222222222222222222",
      name: "Zocken Gang",
      text: [{ id: "111111111111111111", name: "allgemein" }],
      voice: [{ id: "333333333333333333", name: "Lobby", people: 2 }],
    },
  ],
};

describe("parseInvite", () => {
  it("finds address and key together, in any order", () => {
    expect(parseInvite(`${ADDRESS} ${KEY}`)).toEqual({ address: ADDRESS, key: KEY });
    expect(parseInvite(`Schlüssel: ${KEY}\nAdresse: ${ADDRESS}/`)).toEqual({ address: ADDRESS, key: KEY });
    expect(parseInvite(`${ADDRESS}#${KEY}`)).toEqual({ address: ADDRESS, key: KEY });
  });

  it("finds one part alone, and nothing in rubbish", () => {
    expect(parseInvite(KEY)).toEqual({ address: null, key: KEY });
    expect(parseInvite(ADDRESS)).toEqual({ address: ADDRESS, key: null });
    expect(parseInvite("http://plain.example nova_x")).toEqual({ address: null, key: null });
  });

  it("shows hosts and examples with the user's own names", () => {
    expect(hostOf(`${ADDRESS}/`)).toBe("relay.example.test");
    expect(hostOf(null)).toBe("deinem Relay");
    const sentences = examples([{ name: "die Jungs", channelId: "1", channel: "allgemein", server: "Z", kind: "text" }]);
    expect(sentences[0]).toBe("Schreib in die Jungs, dass ich in 10 Minuten online komme.");
  });
});

describe("DiscordPage", () => {
  let status: RelayStatus;
  let call: ReturnType<typeof vi.spyOn>;
  let linked: boolean;

  beforeEach(() => {
    linked = false;
    status = { configured: false, address: null, aliases: [] };
    vi.spyOn(native, "isDesktop").mockReturnValue(true);
    call = vi.spyOn(native, "callNative").mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "relay_set") status = args?.address ? { ...status, configured: true, address: String(args.address) } : { configured: false, address: null, aliases: status.aliases };
      if (command === "relay_check") return { name: "Luca", shownAs: "Luca · via Nova", linked, avatar: linked ? "https://cdn.discordapp.com/avatars/1/a.png" : null };
      if (command === "relay_link") return { code: "123456", expiresIn: 600 };
      if (command === "relay_unlink") linked = false;
      if (command === "relay_channels") return SERVERS;
      if (command === "relay_aliases_set") status = { ...status, aliases: args?.aliases as RelayStatus["aliases"] };
      if (command === "replay_status") return { discordSet: false, discordName: "", enabled: false };
      if (command === "discord_bot_status") return { configured: false, chat: false, bot: false, label: null };
      return status;
    });
  });

  it("walks through the setup: paste an invite, name channels, link the picture, done", async () => {
    const user = userEvent.setup();
    renderWithQuery(<DiscordPage />);

    // Pasting address and key together fills both fields.
    const address = await screen.findByLabelText(/Relay-Adresse/);
    await user.click(address);
    await user.paste(`${ADDRESS}\n${KEY}`);
    expect(address).toHaveValue(ADDRESS);
    expect(screen.getByLabelText(/Dein Schlüssel/)).toHaveValue(KEY);
    await user.click(screen.getByRole("button", { name: "Verbinden" }));
    expect(call).toHaveBeenCalledWith("relay_set", { address: ADDRESS, key: KEY });
    expect(await screen.findByText("Hey Luca! 👋")).toBeInTheDocument();

    // Channels: click a chip, give it a name (a suggestion is one click), go on.
    const server = await screen.findByRole("region", { name: "Zocken Gang" }, { timeout: 4000 });
    expect(within(server).getByText("2")).toBeInTheDocument();
    await user.click(within(server).getByRole("button", { name: /^allgemein \(Text\)/ }));
    await user.click(screen.getByRole("button", { name: "die Jungs" }));
    await user.click(screen.getByRole("button", { name: "Fertig" }));
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("relay_aliases_set", {
        aliases: [{ name: "die Jungs", channelId: "111111111111111111", channel: "allgemein", server: "Zocken Gang", kind: "text" }],
      }),
    );

    // No test message: a preview, and the user's own picture through a code typed in Discord.
    expect(await screen.findByRole("figure", { name: "Vorschau in Discord" })).toHaveTextContent("Luca · via Nova");
    expect(screen.queryByRole("button", { name: /Testnachricht/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Profilbild verknüpfen" }));
    expect(await screen.findByText("/nova code:123456")).toBeInTheDocument();
    linked = true;
    expect(await screen.findByText(/tragen dein Discord-Profilbild/, {}, { timeout: 5000 })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Weiter" }));

    expect(await screen.findByText("Alles bereit!")).toBeInTheDocument();
    expect(screen.getByText(/Schreib in die Jungs, dass ich in 10 Minuten online komme/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Zur Übersicht" }));
    expect(await screen.findByRole("region", { name: "Deine Kanäle" })).toHaveTextContent("die Jungs");
   }, 20_000);

  it("shows the overview once set up: who you are, your channels and who is in a call", async () => {
    status = {
      configured: true,
      address: ADDRESS,
      aliases: [
        { name: "die Jungs", channelId: "111111111111111111", channel: "allgemein", server: "Zocken Gang", kind: "text" },
        { name: "Zocken", channelId: "333333333333333333", channel: "Lobby", server: "Zocken Gang", kind: "voice" },
      ],
    };
    const user = userEvent.setup();
    renderWithQuery(<DiscordPage />);
    expect(await screen.findByText("Luca · via Nova")).toBeInTheDocument();
    expect(screen.getByText("Verbunden mit relay.example.test")).toBeInTheDocument();
    const calls = screen.getByRole("region", { name: "Gerade im Call" });
    expect(await within(calls).findByText("Lobby")).toBeInTheDocument();
    expect(within(calls).getByText("2 Leute")).toBeInTheDocument();

    // Inviting friends is the admin's plugin now, not part of everyone's tab.
    expect(screen.queryByText("Freunde einladen")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Profilbild verknüpfen" })).toBeInTheDocument();

    // Disconnecting needs a second click.
    await user.click(screen.getByRole("button", { name: "Trennen" }));
    await user.click(screen.getByRole("button", { name: "Wirklich trennen?" }));
    expect(call).toHaveBeenCalledWith("relay_set", { address: "", key: "" });
    expect(await screen.findByRole("button", { name: "Verbinden" })).toBeInTheDocument();
  });
});
