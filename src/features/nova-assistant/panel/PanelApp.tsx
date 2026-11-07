import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { AnimatePresence, MotionConfig } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { callNative } from "@/lib/native";
import type { MotionPreference } from "@/stores/settings";
import { agentStatus, assistantStatus, collapseAssistant, configureAgent, finderAddStandardFolders, finderStatus, openNova, panelHidden, panelReady, pinPanel, unmovePanel } from "../api";
import { useAssistantAppearance } from "../appearance";
import { NovaPanel } from "../components/NovaPanel";
import { onReply, useConversation } from "../conversation";
import { ReplyDirector } from "../speech/director";
import { watchScan } from "../scan";
import { ASSISTANT_EVENTS, type AgentPrefs, type AgentStatus, type AssistantState, type AssistantStatus, type DotCorner, type FinderStatus, type WakeCall } from "../types";
import { installNovaVoice, isOnlineVoice, listen as listenOnce, prepareNovaLines, speak, speaksGerman, speechActive, speechAudible, stopListening, stopSpeaking, useVoice, voiceLine, watchNovaVoice } from "../voice";
import { playChime } from "../wake";
import { HeadlessVoice } from "./HeadlessVoice";

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
  const [pinned, setPinned] = useState(false);
  const [wake, setWake] = useState<{ id: number; call: WakeCall } | null>(null);
  // Woken in a game: a voice turn without the panel.
  const [headless, setHeadless] = useState<{ id: number; call: WakeCall } | null>(null);
  const headlessDone = useCallback(() => {
    setHeadless(null);
    void callNative("assistant_headless_done").catch(() => {});
  }, []);
  const wakes = useRef(0);
  const agentRef = useRef(agent);
  agentRef.current = agent;
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
    const canPrepare = (usesNovaVoice && novaVoice?.state === "ready") || isOnlineVoice(voicePref ?? "");
    if (canPrepare && language !== undefined && rate !== undefined) void prepareNovaLines(language, rate, voicePref, () => useConversation.getState().busy);
  }, [usesNovaVoice, novaVoice?.state, language, rate, voicePref]);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      agentStatus().then((s) => alive && setAgent(s), () => {});
      finderStatus().then((s) => alive && setFinder(s), () => {});
    };
    const woken = (call: WakeCall | null) => {
      const start = () => {
        if (!alive) return;
        if (call?.headless) setHeadless({ id: ++wakes.current, call });
        else setWake(call && { id: ++wakes.current, call });
      };
      if (call?.headless) refresh();
      // The first wake after starting: without the settings the reply wouldn't be read aloud.
      if (!call || agentRef.current) {
        start();
        return;
      }
      agentStatus().then(
        (status) => {
          if (alive) setAgent(status);
          start();
        },
        start,
      );
    };
    const show = (from: DotCorner, call: WakeCall | null) => {
      pendingHide.current = null;
      // Opened during a voice turn in a game: the panel takes over, and it must not start again on closing.
      setHeadless(null);
      woken(call && { ...call, headless: false });
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
      listen<AssistantStatus>(ASSISTANT_EVENTS.prefs, (event) => setPinned(event.payload.panelPinned)),
      listen<FinderStatus["progress"]>(ASSISTANT_EVENTS.finder, () => finderStatus().then((s) => alive && setFinder(s), () => {})),
    ];
    assistantStatus().then((status) => alive && setPinned(status.panelPinned), () => {});
    panelReady().then(
      (view) => {
        if (alive && view.open) show(view.origin, view.wake);
        else if (alive && view.wake?.headless) woken(view.wake);
      },
      (error: unknown) => console.error("NOVA panel:", error),
    );
    return () => {
      alive = false;
      for (const subscription of subscriptions) void subscription.then((stop) => stop());
    };
  }, []);

  // Esc stops speech first, then closes; pinned, only the ✕ closes.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (speechAudible()) stopSpeaking();
      else if (!pinned) void collapseAssistant();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, pinned]);

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
  useEffect(() => {
    const director = new ReplyDirector();
    const stop = onReply((event) => director.handle(event, agentRef.current?.prefs));
    return () => {
      stop();
      director.cancel();
    };
  }, []);

  // A timer has run out: a sound always, and what it was for unless NOVA is talking right now.
  useEffect(() => {
    const stop = listen<{ label: string }>(ASSISTANT_EVENTS.timer, ({ payload }) => {
      void (async () => {
        await playChime();
        const prefs = agentRef.current?.prefs;
        if (prefs && !speechActive() && useVoice.getState().mode === "idle") {
          const german = speaksGerman(prefs.language);
          const said = german ? `Dein Timer ist um${payload.label ? `: ${payload.label}` : "."}` : `Your timer is up${payload.label ? `: ${payload.label}` : "."}`;
          await speak(said, prefs, "timer", german);
        }
        // Rust kept the page awake for this; with the panel closed it can rest again.
        if (!openRef.current) void callNative("assistant_headless_done").catch(() => {});
      })();
    });
    return () => void stop.then((unlisten) => unlisten());
  }, []);

  // A virus scan asked for out loud also ends out loud, when nothing else is being said.
  const spokenScan = useRef(false);
  useEffect(() => onReply((event) => {
    if (event.type === "toolStarted" && event.name === "virus_scan" && event.voice) spokenScan.current = true;
  }), []);
  useEffect(
    () =>
      watchScan((status) => {
        const prefs = agentRef.current?.prefs;
        if (!spokenScan.current || !prefs) return;
        spokenScan.current = false;
        if (status.state === "cancelled" || speechActive() || useVoice.getState().mode !== "idle") return;
        const kind = status.state === "clean" ? "scanClean" : status.state === "threats" ? "scanThreats" : "scanFailed";
        void speak(voiceLine(kind, prefs.language), prefs, "scan", speaksGerman(prefs.language));
      }),
    [],
  );

  return (
    <MotionConfig reducedMotion={REDUCED_MOTION[appearance.motion]}>
      {headless && !open && <HeadlessVoice agent={agent} wake={headless} onDone={headlessDone} />}
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
            pinned={pinned}
            onPin={(next) => void pinPanel(next).then((status) => setPinned(status.panelPinned), () => {})}
            onUnmove={() => void unmovePanel().then((status) => setPinned(status.panelPinned), () => {})}
            onPrefs={(patch: Partial<AgentPrefs>) => {
              if (!agent) return;
              void configureAgent({ ...agent.prefs, ...patch }).then(setAgent, () => {});
            }}
          />
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}
