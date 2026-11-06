import {
  ArrowLeft,
  ArrowUpRight,
  Ellipsis,
  FolderSearch,
  History,
  Mic,
  PlugZap,
  Settings,
  SquarePen,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { cn } from "@/lib/cn";
import { greetingFor } from "@/lib/time";
import {
  attachFile,
  captureScreen,
  captureTargets,
  clearAttachments,
  prewarmAssistant,
} from "../api";
import { replyText, useConversation } from "../conversation";
import type {
  AgentStatus,
  AssistantState,
  DotCorner,
  FinderStatus,
  WakeCall,
} from "../types";
import {
  listen,
  openVoiceSettings,
  speak,
  speaksGerman,
  stopListening,
  stopSpeaking,
  useVoice,
  voiceLine,
} from "../voice";
import { beginTurn, discardTurn, mark } from "../speech/timings";
import { playChime } from "../wake";
import { NovaConversation } from "./NovaConversation";
import { NovaHistory } from "./NovaHistory";
import { NovaInput } from "./NovaInput";
import { NovaStatusOrb, NovaVoiceVisualizer, statusLabel } from "./NovaStatus";
import { NovaVoiceLine } from "./NovaVoiceLine";
import { Sparkle } from "./Sparkle";

const TRANSFORM_ORIGIN: Record<DotCorner, string> = {
  bottomRight: "100% 100%",
  bottomLeft: "0% 100%",
  topRight: "100% 0%",
  topLeft: "0% 0%",
};

const SUGGESTIONS = [
  "Find my newest PDF",
  "What's slowing my PC down?",
  "Explain what's on my screen",
];
const LOCAL_SUGGESTIONS = ["Find my newest PDF", "Open the calculator"];

interface NovaPanelProps {
  /** Panel corner nearest the dot; the panel grows out of it. */
  origin: DotCorner;
  name: string;
  agent: AgentStatus | null;
  finder: FinderStatus | null;
  /** The state shown in the header and on the dot (voice states included). */
  state: AssistantState;
  /** "Hey NOVA" or a double clap; a new `id` each time. */
  wake?: { id: number; call: WakeCall } | null;
  onCollapse: () => void;
  onOpenSettings: () => void;
  onOpenProviders: () => void;
  onIndexFolders: () => void;
  onToggleSpeech: () => void;
}

/** The expanded NOVA AI panel: a quiet header, the conversation and one input. */
export function NovaPanel(props: NovaPanelProps) {
  const {
    origin,
    agent,
    state,
    wake,
    onCollapse,
    onOpenSettings,
    onOpenProviders,
    onToggleSpeech,
  } = props;
  const {
    items,
    detail,
    busy,
    attachments,
    send,
    cancel,
    confirm,
    retry,
    reset,
    setAttachments,
  } = useConversation();
  const voice = useVoice();
  const [view, setView] = useState<"chat" | "history">("chat");
  const [actionError, setActionError] = useState<string | null>(null);
  const opensUpward = origin.startsWith("bottom");
  const listening = voice.mode === "listening" || voice.mode === "processing";
  const speakReplies = agent?.prefs.speakReplies ?? false;
  const working = state !== "idle" && state !== "completed";
  const language = agent?.prefs.language ?? "auto";
  const german = speaksGerman(language);
  // What NOVA just said around a spoken turn (a greeting, "one moment").
  const line = voice.line;
  const setLine = (text: string | null) => useVoice.setState({ line: text });
  const discard = useRef(false);

  const report = (error: unknown) =>
    setActionError(error instanceof Error ? error.message : String(error));
  /** Shows and speaks a short line; resolves when it has been said. */
  const say = (text: string, label?: string) => {
    setLine(text);
    return speak(
      text,
      agent?.prefs ?? { voice: "", speechRate: 1, speechVolume: 1 },
      label,
      german,
    );
  };
  const startVoice = async () => {
    if (listening) {
      stopListening();
      return;
    }
    setActionError(null);
    discard.current = false;
    beginTurn("voice");
    // Warm the AI provider while the user speaks (skipped when the panel just did).
    void prewarmAssistant();
    const text = await listen(german);
    if (text && !discard.current) {
      setView("chat");
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
      // Said before the microphone opens, so NOVA doesn't hear itself. A greeting
      // whose audio never ends must not keep the microphone closed.
      const greeted = sayRef.current(voiceLine("greet", language), "greet");
      const late = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), 15_000));
      if ((await Promise.race([greeted, late])) === "late") stopSpeaking();
      if (
        !cancelled &&
        wake.call.listen &&
        !useConversation.getState().busy &&
        useVoice.getState().mode === "idle"
      )
        void startVoiceRef.current();
    })();
    return () => {
      cancelled = true;
    };
  }, [wake?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The line goes once the reply is there.
  useEffect(() => {
    if (!busy && line && voice.mode !== "speaking" && !listening) {
      const timer = setTimeout(() => setLine(null), 2500);
      return () => clearTimeout(timer);
    }
  }, [busy, line, voice.mode, listening]);

  // Ctrl+N starts over, Ctrl+Shift+C copies the last finished reply. Other keys are left to the input.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const letter = event.code.startsWith("Key")
        ? event.code.slice(3).toLowerCase()
        : event.key.toLowerCase();
      const conversation = useConversation.getState();
      if (letter === "n" && !event.shiftKey) {
        event.preventDefault();
        if (
          view === "chat" &&
          conversation.items.length > 0 &&
          !conversation.busy
        )
          void conversation.reset();
      } else if (letter === "c" && event.shiftKey) {
        const reply = conversation.items.findLast(
          (i) =>
            i.kind === "assistant" &&
            !i.streaming &&
            replyText(i).trim() !== "",
        );
        if (reply?.kind !== "assistant") return;
        event.preventDefault();
        void navigator.clipboard.writeText(replyText(reply)).catch(report);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [view]);

  const model = agent?.activeProvider
    ? `${agent.activeProvider} · ${agent.activeModel}`
    : null;

  return (
    <motion.section
      role="dialog"
      aria-label="NOVA AI"
      className="glass-overlay absolute inset-4 flex flex-col overflow-hidden rounded-[24px]"
      style={{ transformOrigin: TRANSFORM_ORIGIN[origin] }}
      initial={{ opacity: 0, scale: 0.6, y: opensUpward ? 16 : -16 }}
      animate={{
        opacity: 1,
        scale: 1,
        y: 0,
        transition: { type: "spring", stiffness: 400, damping: 34, mass: 0.8 },
      }}
      exit={{
        opacity: 0,
        scale: 0.85,
        y: opensUpward ? 10 : -10,
        transition: { duration: 0.15, ease: [0.4, 0, 1, 1] },
      }}
    >
      <header className="flex h-12 shrink-0 items-center gap-2.5 pr-2 pl-4">
        {view === "history" ? (
          <IconButton
            label="Back to the conversation"
            size="sm"
            className="-ml-1.5"
            onClick={() => setView("chat")}
          >
            <ArrowLeft size={15} aria-hidden />
          </IconButton>
        ) : (
          <NovaStatusOrb state={state} level={voice.level} size={20} />
        )}
        <h1 className="text-[13.5px] font-semibold text-fg">
          {view === "history" ? "What NOVA did" : "NOVA"}
        </h1>
        <p
          className={cn(
            "min-w-0 flex-1 truncate text-[12px] text-fg-muted transition-opacity",
            !working && "opacity-0",
          )}
          aria-live="polite"
        >
          {statusLabel(state, detail)}
        </p>
        {view === "chat" && items.length > 0 && (
          <IconButton
            label="New conversation"
            title="New conversation (Ctrl+N)"
            size="sm"
            onClick={() => void reset()}
          >
            <SquarePen size={15} aria-hidden />
          </IconButton>
        )}
        <Menu
          label="More"
          align="end"
          trigger={(menu) => (
            <IconButton label="More" size="sm" {...menu}>
              <Ellipsis size={16} aria-hidden />
            </IconButton>
          )}
          entries={[
            {
              kind: "item",
              id: "speech",
              label: "Read replies aloud",
              checked: speakReplies,
              icon: speakReplies ? (
                <Volume2 size={14} aria-hidden />
              ) : (
                <VolumeX size={14} aria-hidden />
              ),
              onSelect: () => {
                if (speakReplies) stopSpeaking();
                onToggleSpeech();
              },
            },
            {
              kind: "item",
              id: "history",
              label: "Action history",
              icon: <History size={14} aria-hidden />,
              onSelect: () => setView("history"),
            },
            { kind: "separator", id: "line" },
            {
              kind: "item",
              id: "provider",
              label: model ?? "Connect an AI provider",
              icon: <PlugZap size={14} aria-hidden />,
              onSelect: onOpenProviders,
            },
            {
              kind: "item",
              id: "settings",
              label: "Assistant settings",
              icon: <Settings size={14} aria-hidden />,
              onSelect: onOpenSettings,
            },
          ]}
        />
        <IconButton label="Close" size="sm" onClick={onCollapse}>
          <X size={16} aria-hidden />
        </IconButton>
      </header>

      {view === "history" ? (
        <NovaHistory />
      ) : items.length === 0 ? (
        <EmptyState {...props} onSuggestion={(text) => void send(text)} />
      ) : (
        <NovaConversation
          items={items}
          onConfirm={(id, approved) => void confirm(id, approved).catch(report)}
          onRetry={() => void retry()}
        />
      )}

      {(voice.error || actionError) && (
        <p
          role="alert"
          className="mx-5 mb-1.5 flex items-start gap-2 text-[12px] leading-snug text-warning"
        >
          <span className="min-w-0 flex-1">{actionError ?? voice.error}</span>
          {!actionError && voice.errorSettings && (
            <button
              type="button"
              className="shrink-0 font-medium underline underline-offset-2 hover:text-fg"
              onClick={() => openVoiceSettings(voice.errorSettings!)}
            >
              Open settings
            </button>
          )}
          {actionError && (
            <button
              type="button"
              aria-label="Dismiss"
              title="Dismiss"
              className="-mt-0.5 shrink-0 rounded-full p-0.5 text-fg-muted hover:text-fg"
              onClick={() => setActionError(null)}
            >
              <X size={13} aria-hidden />
            </button>
          )}
        </p>
      )}

      {line && (
        <p
          className="mx-5 mb-2 flex items-start gap-2 text-[12.5px] leading-snug text-fg-muted"
          aria-live="polite"
        >
          <Sparkle className="mt-[1px] size-3.5 shrink-0 text-accent-text" />
          <span className="min-w-0 flex-1">{line}</span>
        </p>
      )}

      {listening ? (
        <NovaVoiceLine
          level={voice.level}
          active={voice.mode === "listening"}
          ready={voice.ready}
          transcript={voice.transcript}
          german={german}
          onDone={() => stopListening()}
          onCancel={() => {
            discard.current = true;
            setLine(null);
            stopListening(true);
          }}
        />
      ) : (
        <NovaInput
          busy={busy}
          listening={listening}
          attachments={attachments}
          draft={listening ? voice.transcript : undefined}
          lastMessage={items.findLast((i) => i.kind === "user")?.text}
          onSend={(text) => {
            stopSpeaking();
            setActionError(null);
            setView("chat");
            void send(text);
          }}
          onStop={() => {
            stopSpeaking();
            void cancel();
          }}
          onAttachFile={() => void attachFile().then(setAttachments, report)}
          onLoadTargets={captureTargets}
          onCapture={(target) => {
            setActionError(null);
            void captureScreen(target).then(setAttachments, report);
          }}
          onClearAttachments={() =>
            void clearAttachments().then(() => setAttachments([]), report)
          }
          mic={
            <button
              type="button"
              onClick={() => void startVoice()}
              aria-label={listening ? "Stop listening" : "Talk to NOVA"}
              aria-pressed={listening}
              title={listening ? "Stop listening" : "Talk to NOVA"}
              disabled={busy}
              className={cn(
                "flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full px-2 transition-colors disabled:opacity-40",
                listening
                  ? "bg-accent/20 text-accent-text"
                  : "text-fg-muted hover:bg-white/[0.08] hover:text-fg",
              )}
            >
              {listening ? (
                <NovaVoiceVisualizer
                  level={voice.level}
                  active={voice.mode === "listening"}
                />
              ) : (
                <Mic size={16} aria-hidden />
              )}
            </button>
          }
        />
      )}
    </motion.section>
  );
}

function EmptyState({
  name,
  agent,
  finder,
  onOpenProviders,
  onIndexFolders,
  onSuggestion,
}: NovaPanelProps & { onSuggestion: (text: string) => void }) {
  const local = agent !== null && !agent.activeProvider;
  const unindexed = finder !== null && finder.folders.length === 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto px-5 pb-6">
      <h2 className="text-[21px] leading-tight font-semibold tracking-tight text-fg">
        {greetingFor(new Date())}
        {name && `, ${name}`}
      </h2>
      <p className="mt-1 text-[13px] text-fg-muted">
        {local ? "I can find files and open apps for you." : "How can I help?"}
      </p>
      <ul className="mt-4 -mx-2.5 space-y-0.5" aria-label="Suggestions">
        {(local ? LOCAL_SUGGESTIONS : SUGGESTIONS).map((suggestion) => (
          <li key={suggestion}>
            <button
              type="button"
              onClick={() => onSuggestion(suggestion)}
              className="group flex w-full items-center justify-between rounded-[12px] px-2.5 py-2 text-left text-[13px] text-fg-muted transition-colors hover:bg-white/[0.05] hover:text-fg"
            >
              {suggestion}
              <ArrowUpRight
                size={14}
                className="opacity-0 transition-opacity group-hover:opacity-60"
                aria-hidden
              />
            </button>
          </li>
        ))}
      </ul>
      {(local || unindexed) && (
        <div className="mt-3 space-y-1.5 border-t border-line pt-3">
          {local && (
            <button
              type="button"
              onClick={onOpenProviders}
              className="flex items-center gap-2 text-[12px] text-fg-muted hover:text-fg"
            >
              <PlugZap size={13} className="text-accent-text" aria-hidden />{" "}
              Connect an AI provider for conversations and documents
            </button>
          )}
          {unindexed && (
            <button
              type="button"
              onClick={onIndexFolders}
              className="flex items-center gap-2 text-[12px] text-fg-muted hover:text-fg"
            >
              <FolderSearch
                size={13}
                className="text-accent-text"
                aria-hidden
              />{" "}
              Index my folders for smarter file search
            </button>
          )}
        </div>
      )}
    </div>
  );
}
