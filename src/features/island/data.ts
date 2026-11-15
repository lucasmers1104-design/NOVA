// What the island shows at one moment, as plain data. The island's window fills it
// from Rust and the panel (IslandApp), Island Studio fills it from its scenes
// (scenes.ts); IslandView draws either without knowing which.

import type { LyricLine, MediaAction, MediaState } from "@/features/media/api";
import type { Media, SystemLoad } from "./hooks";
import { type Arrangement, aiBusy, arrange } from "./priority";
import type { AiActivity, AiNote, IslandPrefs, PhoneCall, PhoneNotice } from "./types";

export interface IslandData {
  media: Media;
  load: SystemLoad;
  /** The call to show: a ringing one before a running one. */
  call: PhoneCall | null;
  /** When the running call was first seen active. */
  callSince: number | null;
  /** Why answering or declining didn't work, if it didn't. */
  callError: string | null;
  notice: PhoneNotice | null;
  /** When the notification came on screen; its time runs from here. */
  noticeShownAt: number | null;
  ai: AiActivity;
  aiNote: AiNote;
  /** NOVA AI's last reply is fresh enough to show. */
  aiReplyShown: boolean;
}

export const EMPTY_DATA: IslandData = {
  media: { state: null, artwork: null },
  load: { snapshot: null, hottest: null },
  call: null,
  callSince: null,
  callError: null,
  notice: null,
  noticeShownAt: null,
  ai: { state: "idle", level: 0 },
  aiNote: { reply: "", task: null },
  aiReplyShown: false,
};

/** What the island's controls do. The window calls Rust; the stage plays along with its demo. */
export interface IslandActions {
  mediaControl: (action: MediaAction) => void;
  /** The lyrics of what plays; an empty list when there are none. */
  lyrics: (state: MediaState) => Promise<LyricLine[]>;
  callAction: (callId: string, action: "accept" | "decline") => void;
  /** The microphone on the opened island. */
  talk: () => void;
  /** NOVA AI's panel: a click on the island's dot, or on an island with nothing to show. */
  openAssistant: () => void;
  /** NOVA's menu on a right-click. */
  menu: () => void;
}

export interface IslandLayout {
  arrangement: Arrangement;
  /** A ringing call leads: the island opens by itself and stays open. */
  ringing: boolean;
  /** The NOVA dot sits in the island. */
  showDot: boolean;
  /** Music is on screen, leading or as the small indicator. */
  musicOnScreen: boolean;
}

/** Who leads and who stands beside, for these preferences and this moment. */
export function layoutOf(prefs: IslandPrefs, data: IslandData): IslandLayout {
  const status = data.media.state?.status;
  const arrangement = arrange({
    modules: prefs.modules,
    order: prefs.order,
    callsFirst: prefs.callsFirst,
    call: data.call,
    ai: data.ai.state,
    aiReply: data.aiReplyShown && !aiBusy(data.ai.state),
    notification: data.notice,
    music: status === "playing" ? "playing" : status === "paused" ? "paused" : null,
  });
  return {
    arrangement,
    ringing: arrangement.primary === "call" && data.call?.state === "ringing",
    showDot: prefs.mode === "islandOnly" && prefs.dotInIsland,
    musicOnScreen: arrangement.primary === "music" || arrangement.secondary === "music",
  };
}
