import { useQuery } from "@tanstack/react-query";
import { callNative, isDesktop } from "@/lib/native";

export type ChannelKind = "text" | "voice";

/** Mirrors `Alias` in src-tauri/src/relay.rs: a channel the user gave a name. */
export interface RelayAlias {
  name: string;
  channelId: string;
  channel: string;
  server: string;
  kind: ChannelKind;
}

/** Mirrors `RelayStatus` in src-tauri/src/relay.rs. */
export interface RelayStatus {
  configured: boolean;
  address: string | null;
  aliases: RelayAlias[];
}

export interface RelayServer {
  id: string;
  name: string;
  text: { id: string; name: string }[];
  voice: { id: string; name: string; people: number }[];
}

/** What the relay's GET /v1/channels answers. */
export interface RelayServers {
  servers: RelayServer[];
}

/** What the relay's GET /v1/me answers. */
export interface RelayMe {
  name: string;
  shownAs: string;
  /** Linked to the user's Discord account with `/nova`: messages carry its picture. */
  linked?: boolean;
  avatar?: string | null;
}

/** What `relay_link` answers: typed as `/nova code:<code>` in Discord within `expiresIn` seconds. */
export interface RelayLinkCode {
  code: string;
  expiresIn: number;
}

export const STATUS_KEY = ["relay"];
export const ME_KEY = ["relay", "me"];
export const CHANNELS_KEY = ["relay", "channels"];

export function useRelayStatus() {
  return useQuery({ queryKey: STATUS_KEY, queryFn: () => callNative<RelayStatus>("relay_status"), enabled: isDesktop() });
}

export function useRelayMe(enabled: boolean) {
  return useQuery({ queryKey: ME_KEY, queryFn: () => callNative<RelayMe>("relay_check"), enabled: enabled && isDesktop(), staleTime: 5 * 60_000, retry: false });
}

/** Live from the relay: who is in which call changes, so it refreshes while the page is open. */
export function useRelayChannels(enabled: boolean) {
  return useQuery({
    queryKey: CHANNELS_KEY,
    queryFn: () => callNative<RelayServers>("relay_channels"),
    enabled: enabled && isDesktop(),
    refetchInterval: 15_000,
    retry: false,
  });
}

const URL_PATTERN = /https:\/\/[^\s#"'<>]+/i;
const KEY_PATTERN = /nova_[0-9a-f]{8}_[A-Za-z0-9_-]{43}/;

/**
 * Reads whatever was pasted: an invite with address and key together (in any order, separated by
 * spaces, a line break or "#"), or just one of them.
 */
export function parseInvite(text: string): { address: string | null; key: string | null } {
  const key = text.match(KEY_PATTERN)?.[0] ?? null;
  const address = text.replace(KEY_PATTERN, " ").match(URL_PATTERN)?.[0]?.replace(/\/+$/, "") ?? null;
  return { address, key };
}

/** The relay's host for display: "abc.sslip.io" instead of the whole address. */
export function hostOf(address: string | null): string {
  if (!address) return "deinem Relay";
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

/** Example sentences that use the names the user actually gave. */
export function examples(aliases: RelayAlias[]): string[] {
  const text = aliases.find((a) => a.kind === "text")?.name;
  const voice = aliases.find((a) => a.kind === "voice")?.name;
  const out: string[] = [];
  if (text) out.push(`Schreib in ${text}, dass ich in 10 Minuten online komme.`);
  if (voice) out.push(`Sag im ${voice}-Call, dass ich gleich dazukomme.`);
  else out.push("Sag den Leuten im Call, dass ich gleich dazukomme.");
  if (text) out.push(`Frag in ${text}, wer heute Abend zocken will. Locker, mit Emojis.`);
  return out;
}
