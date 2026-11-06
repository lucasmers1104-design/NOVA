import { useEffect } from "react";
import { useConversation } from "../conversation";
import type { AgentStatus, WakeCall } from "../types";
import { useVoiceTurns } from "../useVoiceTurns";
import { speechActive, useVoice } from "../voice";

/** Seconds of nothing going on before the voice turn in a game counts as over. */
const QUIET_SECONDS = 5;

/**
 * Talking to NOVA in a game: everything the panel does for a spoken turn,
 * without the panel, because a window would get in the way of playing.
 */
export function HeadlessVoice({ agent, wake, onDone }: { agent: AgentStatus | null; wake: { id: number; call: WakeCall }; onDone: () => void }) {
  useVoiceTurns({ agent, wake });
  useEffect(() => {
    let quiet = 0;
    const timer = setInterval(() => {
      const idle = !useConversation.getState().busy && useVoice.getState().mode === "idle" && !speechActive();
      quiet = idle ? quiet + 1 : 0;
      if (quiet >= QUIET_SECONDS) onDone();
    }, 1000);
    return () => clearInterval(timer);
  }, [wake.id, onDone]);
  return null;
}
