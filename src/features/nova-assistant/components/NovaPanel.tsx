import { ArrowLeft, ArrowUpRight, Ellipsis, FolderSearch, History, Mic, PlugZap, Settings, SquarePen, Volume2, VolumeX, X } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { cn } from "@/lib/cn";
import { greetingFor } from "@/lib/time";
import { attachFile, captureScreen, captureTargets, clearAttachments } from "../api";
import { useConversation } from "../conversation";
import type { AgentStatus, AssistantState, DotCorner, FinderStatus, WakeCall } from "../types";
import { listen, openVoiceSettings, stopListening, stopSpeaking, useVoice } from "../voice";
import { playChime } from "../wake";
import { NovaConversation } from "./NovaConversation";
import { NovaHistory } from "./NovaHistory";
import { NovaInput } from "./NovaInput";
import { NovaStatusOrb, NovaVoiceVisualizer, statusLabel } from "./NovaStatus";

const TRANSFORM_ORIGIN: Record<DotCorner, string> = {
  bottomRight: "100% 100%",
  bottomLeft: "0% 100%",
  topRight: "100% 0%",
  topLeft: "0% 0%",
};

const SUGGESTIONS = ["Find my newest PDF", "What's slowing my PC down?", "Explain what's on my screen"];
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
  /** Voice turns get spoken replies. */
  onVoiceTurn: () => void;
}

/** The expanded NOVA AI panel: a quiet header, the conversation and one input. */
export function NovaPanel(props: NovaPanelProps) {
  const { origin, agent, state, wake, onCollapse, onOpenSettings, onOpenProviders, onToggleSpeech } = props;
  const { items, detail, busy, attachments, send, cancel, confirm, retry, reset, setAttachments } = useConversation();
  const voice = useVoice();
  const [view, setView] = useState<"chat" | "history">("chat");
  const [actionError, setActionError] = useState<string | null>(null);
  const opensUpward = origin.startsWith("bottom");
  const listening = voice.mode === "listening" || voice.mode === "processing";
  const speakReplies = agent?.prefs.speakReplies ?? false;
  const working = state !== "idle" && state !== "completed";

  const report = (error: unknown) => setActionError(error instanceof Error ? error.message : String(error));
  const startVoice = async () => {
    if (listening) {
      stopListening();
      return;
    }
    setActionError(null);
    const text = await listen();
    if (text) {
      props.onVoiceTurn();
      setView("chat");
      void send(text);
    }
  };

  // Woken by "Hey NOVA" or a double clap: a chime, then listen (or wait for typing).
  const startVoiceRef = useRef(startVoice);
  startVoiceRef.current = startVoice;
  useEffect(() => {
    if (!wake) return;
    let cancelled = false;
    void (async () => {
      if (wake.call.chime) await playChime();
      if (!cancelled && wake.call.listen && !useConversation.getState().busy && useVoice.getState().mode === "idle") void startVoiceRef.current();
    })();
    return () => {
      cancelled = true;
    };
  }, [wake?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const model = agent?.activeProvider ? `${agent.activeProvider} · ${agent.activeModel}` : null;

  return (
    <motion.section
      role="dialog"
      aria-label="NOVA AI"
      className="glass-overlay absolute inset-4 flex flex-col overflow-hidden rounded-[24px]"
      style={{ transformOrigin: TRANSFORM_ORIGIN[origin] }}
      initial={{ opacity: 0, scale: 0.6, y: opensUpward ? 16 : -16 }}
      animate={{ opacity: 1, scale: 1, y: 0, transition: { type: "spring", stiffness: 400, damping: 34, mass: 0.8 } }}
      exit={{ opacity: 0, scale: 0.85, y: opensUpward ? 10 : -10, transition: { duration: 0.15, ease: [0.4, 0, 1, 1] } }}
    >
      <header className="flex h-12 shrink-0 items-center gap-2.5 pr-2 pl-4">
        {view === "history" ? (
          <IconButton label="Back to the conversation" size="sm" className="-ml-1.5" onClick={() => setView("chat")}>
            <ArrowLeft size={15} aria-hidden />
          </IconButton>
        ) : (
          <NovaStatusOrb state={state} level={voice.level} size={20} />
        )}
        <h1 className="text-[13.5px] font-semibold text-fg">{view === "history" ? "What NOVA did" : "NOVA"}</h1>
        <p className={cn("min-w-0 flex-1 truncate text-[12px] text-fg-muted transition-opacity", !working && "opacity-0")} aria-live="polite">
          {statusLabel(state, detail)}
        </p>
        {view === "chat" && items.length > 0 && (
          <IconButton label="New conversation" size="sm" onClick={() => void reset()}>
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
              icon: speakReplies ? <Volume2 size={14} aria-hidden /> : <VolumeX size={14} aria-hidden />,
              onSelect: () => {
                if (speakReplies) stopSpeaking();
                onToggleSpeech();
              },
            },
            { kind: "item", id: "history", label: "Action history", icon: <History size={14} aria-hidden />, onSelect: () => setView("history") },
            { kind: "separator", id: "line" },
            { kind: "item", id: "provider", label: model ?? "Connect an AI provider", icon: <PlugZap size={14} aria-hidden />, onSelect: onOpenProviders },
            { kind: "item", id: "settings", label: "Assistant settings", icon: <Settings size={14} aria-hidden />, onSelect: onOpenSettings },
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
        <NovaConversation items={items} onConfirm={(id, approved) => void confirm(id, approved).catch(report)} onRetry={() => void retry()} />
      )}

      {(voice.error || actionError) && (
        <p role="alert" className="mx-5 mb-1.5 flex items-start gap-2 text-[12px] leading-snug text-warning">
          <span className="min-w-0 flex-1">{actionError ?? voice.error}</span>
          {!actionError && voice.errorSettings && (
            <button type="button" className="shrink-0 font-medium underline underline-offset-2 hover:text-fg" onClick={() => openVoiceSettings(voice.errorSettings!)}>
              Open settings
            </button>
          )}
        </p>
      )}

      <NovaInput
        busy={busy}
        listening={listening}
        attachments={attachments}
        draft={listening ? voice.transcript : undefined}
        onSend={(text) => {
          stopSpeaking();
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
        onClearAttachments={() => void clearAttachments().then(() => setAttachments([]), report)}
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
              listening ? "bg-accent/20 text-accent-text" : "text-fg-muted hover:bg-white/[0.08] hover:text-fg",
            )}
          >
            {listening ? <NovaVoiceVisualizer level={voice.level} active={voice.mode === "listening"} /> : <Mic size={16} aria-hidden />}
          </button>
        }
      />
    </motion.section>
  );
}

function EmptyState({ name, agent, finder, onOpenProviders, onIndexFolders, onSuggestion }: NovaPanelProps & { onSuggestion: (text: string) => void }) {
  const local = agent !== null && !agent.activeProvider;
  const unindexed = finder !== null && finder.folders.length === 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto px-5 pb-6">
      <h2 className="text-[21px] leading-tight font-semibold tracking-tight text-fg">
        {greetingFor(new Date())}
        {name && `, ${name}`}
      </h2>
      <p className="mt-1 text-[13px] text-fg-muted">{local ? "I can find files and open apps for you." : "How can I help?"}</p>
      <ul className="mt-4 -mx-2.5 space-y-0.5" aria-label="Suggestions">
        {(local ? LOCAL_SUGGESTIONS : SUGGESTIONS).map((suggestion) => (
          <li key={suggestion}>
            <button
              type="button"
              onClick={() => onSuggestion(suggestion)}
              className="group flex w-full items-center justify-between rounded-[12px] px-2.5 py-2 text-left text-[13px] text-fg-muted transition-colors hover:bg-white/[0.05] hover:text-fg"
            >
              {suggestion}
              <ArrowUpRight size={14} className="opacity-0 transition-opacity group-hover:opacity-60" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      {(local || unindexed) && (
        <div className="mt-3 space-y-1.5 border-t border-line pt-3">
          {local && (
            <button type="button" onClick={onOpenProviders} className="flex items-center gap-2 text-[12px] text-fg-muted hover:text-fg">
              <PlugZap size={13} className="text-accent-text" aria-hidden /> Connect an AI provider for conversations and documents
            </button>
          )}
          {unindexed && (
            <button type="button" onClick={onIndexFolders} className="flex items-center gap-2 text-[12px] text-fg-muted hover:text-fg">
              <FolderSearch size={13} className="text-accent-text" aria-hidden /> Index my folders for smarter file search
            </button>
          )}
        </div>
      )}
    </div>
  );
}
