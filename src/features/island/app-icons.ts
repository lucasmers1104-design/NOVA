// App logos on Nova Island. A real logo comes from Rust (the PC's player) or the phone
// (a notification's app), always as a PNG or WebP data URL. Where none came, well-known
// apps get a colored badge with a generic glyph (no brand artwork), others their letter.

import { AtSign, Camera, Clapperboard, Cloud, Gamepad2, Ghost, Globe, type LucideIcon, Mail, MessageCircle, MessageSquare, Music, Music2, Phone, Play, Send, Tv, Users } from "lucide-react";

/** Longest data URL the island shows (a 64 px PNG from Windows is far below). */
const MOST_CHARS = 200_000;
const DATA_URL = /^data:image\/(?:png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * A logo the island may put in an <img>: a PNG or WebP data URL, nothing else. Bare
 * base64 (what older NOVA versions passed through from the phone) is named by its first
 * bytes: PNG starts "iVBORw0KGgo", WebP ("RIFF") "UklGR".
 */
export function iconSrc(icon: string | null | undefined): string | null {
  if (!icon || icon.length > MOST_CHARS) return null;
  if (icon.startsWith("data:")) return DATA_URL.test(icon) ? icon : null;
  if (!BASE64.test(icon)) return null;
  if (icon.startsWith("iVBORw0KGgo")) return `data:image/png;base64,${icon}`;
  if (icon.startsWith("UklGR")) return `data:image/webp;base64,${icon}`;
  return null;
}

export interface KnownApp {
  name: string;
  /** Badge color. */
  color: string;
  /** Glyph color on it. */
  ink: string;
  glyph: LucideIcon;
}

const app = (name: string, color: string, glyph: LucideIcon, ink = "#fff"): KnownApp => ({ name, color, ink, glyph });

// Android package names and Windows AppUserModelIds / exe names. More specific first.
const KNOWN_APPS: [RegExp, KnownApp][] = [
  [/spotify/i, app("Spotify", "#1db954", Music, "#0b0b0b")],
  [/zhiliaoapp\.musically|ss\.android\.ugc|tiktok/i, app("TikTok", "#111111", Music2)],
  [/whatsapp/i, app("WhatsApp", "#25d366", MessageCircle)],
  [/discord/i, app("Discord", "#5865f2", Gamepad2)],
  [/instagram/i, app("Instagram", "#e1306c", Camera)],
  [/youtube/i, app("YouTube", "#ff0000", Play)],
  [/telegram/i, app("Telegram", "#229ed9", Send)],
  [/thoughtcrime\.securesms|signal/i, app("Signal", "#3a76f0", MessageSquare)],
  [/facebook\.orca|messenger/i, app("Messenger", "#0084ff", MessageCircle)],
  [/facebook/i, app("Facebook", "#1877f2", Users)],
  [/snapchat/i, app("Snapchat", "#fffc00", Ghost, "#111")],
  [/twitter|^com\.x\.android$/i, app("X", "#111111", AtSign)],
  [/^com\.google\.android\.gm$|gmail/i, app("Gmail", "#ea4335", Mail)],
  [/outlook/i, app("Outlook", "#0078d4", Mail)],
  [/msteams|\.teams\b/i, app("Teams", "#6264a7", Users)],
  [/twitch/i, app("Twitch", "#9146ff", Tv)],
  [/netflix/i, app("Netflix", "#e50914", Clapperboard)],
  [/soundcloud/i, app("SoundCloud", "#ff5500", Cloud)],
  [/itunes|applemusic/i, app("Apple Music", "#fa243c", Music)],
  [/deezer/i, app("Deezer", "#a238ff", Music)],
  [/tidal/i, app("TIDAL", "#111111", Music)],
  [/zunemusic|mediaplayer/i, app("Media Player", "#e3008c", Music)],
  [/vlc/i, app("VLC", "#ff8800", Clapperboard)],
  [/msedge/i, app("Microsoft Edge", "#0c59a4", Globe)],
  [/chrome/i, app("Google Chrome", "#4285f4", Globe)],
  [/firefox|^308046b0af4a39cb$/i, app("Firefox", "#ff7139", Globe)],
  [/brave/i, app("Brave", "#fb542b", Globe)],
  [/opera/i, app("Opera", "#ff1b2d", Globe)],
  [/android\.dialer|incallui/i, app("Telefon", "#34c759", Phone)],
];

/** A well-known app by package name, AppUserModelId, exe or display name. */
export function knownApp(...ids: (string | null | undefined)[]): KnownApp | null {
  for (const id of ids) {
    if (!id) continue;
    for (const [pattern, known] of KNOWN_APPS) if (pattern.test(id)) return known;
  }
  return null;
}
