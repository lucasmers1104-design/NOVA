import { emitTo, listen } from "@tauri-apps/api/event";
import { AnimatePresence, MotionConfig } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { MotionPreference } from "@/stores/settings";
import { agentStatus, assistantStatus, collapseAssistant, configureAgent, finderAddStandardFolders, finderStatus, openNova, panelHidden, panelReady } from "../api";
import { useAssistantAppearance } from "../appearance";
import { NovaPanel } from "../components/NovaPanel";
import { type AssistantItem, replyText, useConversation } from "../conversation";
import { ASSISTANT_EVENTS, type AgentStatus, type AssistantState, type AssistantStatus, type DotCorner, type FinderStatus } from "../types";
import { speak, stopListening, stopSpeaking, useVoice } from "../voice";

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
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [finder, setFinder] = useState<FinderStatus | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const pendingHide = useRef<number | null>(null);
  const voiceTurn = useRef(false);

  const conversationState = useConversation((s) => s.state);
  const busy = useConversation((s) => s.busy);
  const voiceMode = useVoice((s) => s.mode);
  const level = useVoice((s) => s.level);
  const state = displayedState(conversationState, voiceMode);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      assistantStatus().then((s) => alive && setStatus(s), () => {});
      agentStatus().then((s) => alive && setAgent(s), () => {});
      finderStatus().then((s) => alive && setFinder(s), () => {});
    };
    const show = (from: DotCorner) => {
      pendingHide.current = null;
      setOrigin(from);
      setSession((n) => n + 1);
      setOpen(true);
      refresh();
    };
    const subscriptions = [
      listen<{ origin: DotCorner }>(ASSISTANT_EVENTS.expand, (event) => show(event.payload.origin)),
      listen<{ generation: number }>(ASSISTANT_EVENTS.collapse, (event) => {
        stopListening();
        if (!openRef.current) {
          void panelHidden(event.payload.generation);
          return;
        }
        pendingHide.current = event.payload.generation;
        setOpen(false);
      }),
      listen<AssistantStatus>(ASSISTANT_EVENTS.prefs, (event) => setStatus(event.payload)),
      listen<AgentStatus>(ASSISTANT_EVENTS.agent, (event) => setAgent(event.payload)),
      listen<FinderStatus["progress"]>(ASSISTANT_EVENTS.finder, () => finderStatus().then((s) => alive && setFinder(s), () => {})),
    ];
    panelReady().then(
      (view) => alive && view.open && show(view.origin),
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
      if (useVoice.getState().mode === "speaking") stopSpeaking();
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

  // Speak finished replies when spoken replies are on, or when the user spoke.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      const last = useConversation.getState().items.findLast((i): i is AssistantItem => i.kind === "assistant");
      const shouldSpeak = (agent?.prefs.speakReplies ?? false) || voiceTurn.current;
      voiceTurn.current = false;
      if (last && !last.error && shouldSpeak) {
        const text = replyText(last);
        if (text && agent) void speak(text, agent.prefs);
      }
    }
    wasBusy.current = busy;
  }, [busy, agent]);

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
            shortcut={status?.shortcut ?? ""}
            shortcutError={status?.shortcutError ?? null}
            agent={agent}
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
            onVoiceTurn={() => {
              voiceTurn.current = true;
            }}
          />
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}
