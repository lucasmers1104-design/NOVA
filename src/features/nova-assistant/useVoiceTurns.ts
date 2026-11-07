import { useIsPresent } from "motion/react";
import { type RefObject, useEffect, useRef } from "react";
import { prewarmAssistant } from "./api";
import { useConversation } from "./conversation";
import { beginTurn, discardTurn, mark } from "./speech/timings";
import type { AgentStatus, WakeCall } from "./types";
import { listen, speak, speaksGerman, stopListening, stopSpeaking, useVoice, voiceLine } from "./voice";
import { playChime } from "./wake";

interface VoiceTurnsOptions {
  agent: AgentStatus | null;
  /** "Hey NOVA" or a double clap; a new `id` each time. */
  wake?: { id: number; call: WakeCall } | null;
  /** Something is being typed, so the microphone doesn't open by itself. */
  typing?: RefObject<boolean>;
  /** A voice turn begins. */
  onStart?: () => void;
  /** What was said goes to NOVA AI. */
  onSend?: () => void;
}

/**
 * Talking with NOVA, with or without its window: greeting after a wake-up,
 * listening, sending what was said, and listening again after a spoken reply.
 */
export function useVoiceTurns({ agent, wake, typing, onStart, onSend }: VoiceTurnsOptions) {
  const language = agent?.prefs.language ?? "auto";
  const german = speaksGerman(language);
  const send = useConversation((s) => s.send);
  const followUps = useVoice((s) => s.followUps);
  const discard = useRef(false);
  // The panel plays its exit animation: nothing may open the microphone anymore.
  const present = useIsPresent();
  const presentRef = useRef(present);
  presentRef.current = present;

  /** Shows and speaks a short line; resolves when it has been said. */
  const say = (text: string, label?: string) => {
    useVoice.setState({ line: text });
    return speak(text, agent?.prefs ?? { voice: "", speechRate: 1, speechVolume: 1 }, label, german);
  };

  /** `followUp`: the microphone opens by itself after a reply. */
  const startVoice = async (followUp = false) => {
    const mode = useVoice.getState().mode;
    if (mode === "listening" || mode === "processing") {
      stopListening();
      return;
    }
    onStart?.();
    if (followUp) useVoice.setState({ line: null });
    discard.current = false;
    beginTurn("voice");
    // Warm the AI provider while the user speaks (skipped when the panel just did).
    void prewarmAssistant();
    const text = await listen(german, undefined, followUp);
    if (text && !discard.current) {
      onSend?.();
      // The reply is read aloud as it arrives; "one moment" plays only if it takes a while.
      void send(text, { voice: true, ack: voiceLine("ack", language) });
    } else {
      discardTurn();
    }
  };

  // Woken by "Hey NOVA" or a double clap: a chime and a greeting, then listen (or wait for typing).
  const startVoiceRef = useRef(startVoice);
  startVoiceRef.current = startVoice;
  const sayRef = useRef(say);
  sayRef.current = say;
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  useEffect(() => {
    if (!wake) return;
    let cancelled = false;
    void (async () => {
      beginTurn("wake");
      mark("wake");
      if (wake.call.chime) await playChime();
      mark("chimeEnd");
      if (cancelled) return;
      // A reply is still running: the greeting would cut it off and nobody could answer.
      if (useConversation.getState().busy) return;
      // "Hey NOVA, wie spät ist es?": the request is already there.
      if (wake.call.request) {
        onSendRef.current?.();
        const unasked = wake.call.source === "schedule";
        void useConversation.getState().send(wake.call.request, { voice: true, ack: unasked ? undefined : voiceLine("ack", language), unasked });
        return;
      }
      // Said before the microphone opens, so NOVA doesn't hear itself. A greeting
      // whose audio never ends must not keep the microphone closed.
      const greeted = sayRef.current(voiceLine("greet", language), "greet");
      const late = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), 15_000));
      if ((await Promise.race([greeted, late])) === "late") stopSpeaking();
      // Typing instead of talking: the input stays, with what is in it.
      if (!cancelled && presentRef.current && !typing?.current && wake.call.listen && !useConversation.getState().busy && useVoice.getState().mode === "idle") void startVoiceRef.current();
    })();
    return () => {
      cancelled = true;
    };
  }, [wake?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A spoken reply has been said: the microphone opens again, unless something else is going on.
  const followUpsSeen = useRef(followUps);
  useEffect(() => {
    if (followUps === followUpsSeen.current) return;
    followUpsSeen.current = followUps;
    // A moment later, so the end of the reply doesn't reach the microphone.
    const timer = setTimeout(() => {
      if (presentRef.current && !typing?.current && !useConversation.getState().busy && useVoice.getState().mode === "idle") void startVoiceRef.current(true);
    }, 300);
    return () => clearTimeout(timer);
  }, [followUps, typing]);

  return { startVoice, say, discard, german, language };
}
