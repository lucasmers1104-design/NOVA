import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { AnimatePresence, MotionConfig } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { MotionPreference } from "@/stores/settings";
import { agentStatus, collapseAssistant, configureAgent, finderAddStandardFolders, finderStatus, openNova, panelHidden, panelReady } from "../api";
import { useAssistantAppearance } from "../appearance";
import { NovaPanel } from "../components/NovaPanel";
import { onReply, useConversation } from "../conversation";
import { ReplyDirector } from "../speech/director";
import { ASSISTANT_EVENTS, type AgentStatus, type AssistantState, type DotCorner, type FinderStatus, type WakeCall } from "../types";
import { installNovaVoice, listen as listenOnce, prepareNovaLines, speechActive, stopListening, stopSpeaking, useVoice, watchNovaVoice } from "../voice";

// Dev builds: a handle for end-to-end checks over the DevTools protocol (scripts/cdp.mjs).
if (import.meta.env.DEV && typeof window !== "undefined") {
  Object.assign(window, {
    __novaDev: {
      conversation: useConversation,
      voice: useVoice,
      wake: (listen = false) => emit(ASSISTANT_EVENTS.wake, { source: "clap", listen, chime: true }),
      listen: (german = true) => listenOnce(german),
    },
  });
}

const REDUCED_MOTION: Record<MotionPreference, "user" | "always" | "never"> = { system: "user", reduced: "always", full: "never" };

/** What the header and the dot show: voice states win over the conversation's. */
export function displayedState(conversation: AssistantState, voice: ReturnType<typeof useVoice.getState>["mode"]): AssistantState {
  return voice === "idle" ? conversation : voice;
}

/**
 * The assistant panel window. Rust shows and hides the window; this
 * component plays the matching enter and exit animations, reports back when
 * the exit has finished, and keeps the dot informed about what NOVA is doing.
 */
export function PanelApp() {
  const appearance = useAssistantAppearance();
  const [open, setOpen] = useState(false);
  const [origin, setOrigin] = useState<DotCorner>("bottomRight");
  // Each opening is a fresh mount, so it always plays the entrance.
  const [session, setSession] = useState(0);
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [finder, setFinder] = useState<FinderStatus | null>(null);
  const [wake, setWake] = useState<{ id: number; call: WakeCall } | null>(null);
  const wakes = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;
  const pendingHide = useRef<number | null>(null);

  const conversationState = useConversation((s) => s.state);
  const voiceMode = useVoice((s) => s.mode);
  const level = useVoice((s) => s.level);
  const state = displayedState(conversationState, voiceMode);
  const novaVoice = useVoice((s) => s.novaVoice);

  useEffect(() => watchNovaVoice(), []);
  // NOVA's own voice is downloaded once, in the background, when it will be used.
  const usesNovaVoice = agent ? agent.prefs.voice === "" || agent.prefs.voice.startsWith("nova:") : false;
  useEffect(() => {
    if (usesNovaVoice && novaVoice?.state === "missing") void installNovaVoice();
  }, [usesNovaVoice, novaVoice?.state]);
  // Greetings play right after a wake-up instead of being made then.
  const language = agent?.prefs.language;
  const rate = agent?.prefs.speechRate;
  const voicePref = agent?.prefs.voice;
  useEffect(() => {
    if (usesNovaVoice && novaVoice?.state === "ready" && language !== undefined && rate !== undefined) void prepareNovaLines(language, rate, voicePref, () => useConversation.getState().busy);
  }, [usesNovaVoice, novaVoice?.state, language, rate, voicePref]);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      agentStatus().then((s) => alive && setAgent(s), () => {});
      finderStatus().then((s) => alive && setFinder(s), () => {});
    };
    const woken = (call: WakeCall | null) => setWake(call && { id: ++wakes.current, call });
    const show = (from: DotCorner, call: WakeCall | null) => {
      pendingHide.current = null;
      woken(call);
      setOrigin(from);
      setSession((n) => n + 1);
      setOpen(true);
      refresh();
    };
    const subscriptions = [
      listen<{ origin: DotCorner; wake: WakeCall | null }>(ASSISTANT_EVENTS.expand, (event) => show(event.payload.origin, event.payload.wake)),
      listen<WakeCall>(ASSISTANT_EVENTS.wake, (event) => woken(event.payload)),
      listen<{ generation: number }>(ASSISTANT_EVENTS.collapse, (event) => {
        // Closing isn't "send what I said so far".
        stopListening(true);
        if (!openRef.current) {
          void panelHidden(event.payload.generation);
          return;
        }
        pendingHide.current = event.payload.generation;
        setOpen(false);
      }),
      listen<AgentStatus>(ASSISTANT_EVENTS.agent, (event) => setAgent(event.payload)),
      listen<FinderStatus["progress"]>(ASSISTANT_EVENTS.finder, () => finderStatus().then((s) => alive && setFinder(s), () => {})),
    ];
    panelReady().then(
      (view) => alive && view.open && show(view.origin, view.wake),
      (error: unknown) => console.error("NOVA panel:", error),
    );
    return () => {
      alive = false;
      for (const subscription of subscriptions) void subscription.then((stop) => stop());
    };
  }, []);

  // Esc stops speech first, then closes.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (speechActive()) stopSpeaking();
      else void collapseAssistant();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Tell the dot what NOVA is doing (only while it changes).
  useEffect(() => {
    void emitTo("dot", ASSISTANT_EVENTS.activity, { state, level: state === "listening" || state === "speaking" ? level : 0 }).catch(() => {});
  }, [state, level]);

  // "Done" settles back to "Ready".
  useEffect(() => {
    if (conversationState !== "completed") return;
    const timer = setTimeout(() => useConversation.getState().setState("idle"), 2200);
    return () => clearTimeout(timer);
  }, [conversationState]);

  // Replies are read aloud while they stream in: spoken requests always, typed ones when spoken replies are on.
  const agentRef = useRef(agent);
  agentRef.current = agent;
  useEffect(() => {
    const director = new ReplyDirector();
    const stop = onReply((event) => director.handle(event, agentRef.current?.prefs));
    return () => {
      stop();
      director.cancel();
    };
  }, []);

  return (
    <MotionConfig reducedMotion={REDUCED_MOTION[appearance.motion]}>
      <AnimatePresence
        onExitComplete={() => {
          const generation = pendingHide.current;
          pendingHide.current = null;
          if (generation !== null) void panelHidden(generation);
        }}
      >
        {open && (
          <NovaPanel
            key={session}
            origin={origin}
            name={appearance.displayName}
            agent={agent}
            wake={wake}
            finder={finder}
            state={state}
            onCollapse={() => void collapseAssistant()}
            onOpenSettings={() => void openNova("assistant")}
            onOpenProviders={() => void openNova(agent?.activeProvider ? "assistant" : "ai")}
            onIndexFolders={() => void finderAddStandardFolders().then(setFinder, () => {})}
            onToggleSpeech={() => {
              if (!agent) return;
              void configureAgent({ ...agent.prefs, speakReplies: !agent.prefs.speakReplies }).then(setAgent, () => {});
            }}
          />
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}
