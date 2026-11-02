import { FolderSearch, History, Mic, MicOff, Minus, Monitor, MonitorOff, PlugZap, Settings, SquarePen, Volume2, VolumeX, X } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { Kbd } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { greetingFor } from "@/lib/time";
import { attachFile, captureScreen, captureTargets, clearAttachments } from "../api";
import { useConversation } from "../conversation";
import { shortcutLabels } from "../shortcut";
import type { AgentStatus, AssistantState, DotCorner, FinderStatus } from "../types";
import { listen, openVoiceSettings, stopListening, stopSpeaking, useVoice } from "../voice";
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

const SUGGESTIONS = ["Find my newest PDF", "What's slowing my PC down right now?", "Look at my screen and explain what I see", "Create a PDF packing list for a weekend trip"];

interface NovaPanelProps {
  /** Panel corner nearest the dot; the panel grows out of it. */
  origin: DotCorner;
  name: string;
  shortcut: string;
  shortcutError: string | null;
  agent: AgentStatus | null;
  finder: FinderStatus | null;
  /** The state shown in the header and on the dot (voice states included). */
  state: AssistantState;
  onCollapse: () => void;
  onOpenSettings: () => void;
  onOpenProviders: () => void;
  onIndexFolders: () => void;
  onToggleSpeech: () => void;
  /** Voice turns get spoken replies. */
  onVoiceTurn: () => void;
}

/** The expanded NOVA AI panel. */
export function NovaPanel(props: NovaPanelProps) {
  const { origin, agent, state, onCollapse, onOpenSettings, onOpenProviders, onToggleSpeech } = props;
  const { items, detail, busy, attachments, send, cancel, confirm, retry, reset, setAttachments } = useConversation();
  const voice = useVoice();
  const [view, setView] = useState<"chat" | "history">("chat");
  const [actionError, setActionError] = useState<string | null>(null);
  const opensUpward = origin.startsWith("bottom");
  const listening = voice.mode === "listening" || voice.mode === "processing";
  const speakReplies = agent?.prefs.speakReplies ?? false;

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

  return (
    <motion.section
      role="dialog"
      aria-label="NOVA AI"
      className="glass-overlay absolute inset-4 flex flex-col overflow-hidden rounded-[26px]"
      style={{ transformOrigin: TRANSFORM_ORIGIN[origin] }}
      initial={{ opacity: 0, scale: 0.55, y: opensUpward ? 18 : -18 }}
      animate={{ opacity: 1, scale: 1, y: 0, transition: { type: "spring", stiffness: 380, damping: 32, mass: 0.8 } }}
      exit={{ opacity: 0, scale: 0.8, y: opensUpward ? 12 : -12, transition: { duration: 0.16, ease: [0.4, 0, 1, 1] } }}
    >
      <header className="flex items-center gap-3 border-b border-line px-4 pt-3.5 pb-3">
        <NovaStatusOrb state={state} level={voice.level} />
        <div className="min-w-0 flex-1">
          <h1 className="text-[14px] leading-tight font-semibold text-fg">NOVA AI</h1>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11.5px] text-fg-muted" aria-live="polite">
            {state === "idle" || state === "completed" ? <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden /> : null}
            {state === "error" ? <span className="size-1.5 shrink-0 rounded-full bg-danger" aria-hidden /> : null}
            <span className="truncate">{statusLabel(state, detail)}</span>
          </p>
        </div>
        <div className="flex items-center gap-0.5">
          <IconButton label="New conversation" size="sm" disabled={items.length === 0} onClick={() => void reset().then(() => setView("chat"))}>
            <SquarePen size={15} aria-hidden />
          </IconButton>
          <IconButton label={view === "history" ? "Back to the conversation" : "Action history"} size="sm" aria-pressed={view === "history"} onClick={() => setView((v) => (v === "history" ? "chat" : "history"))}>
            <History size={15} aria-hidden className={view === "history" ? "text-accent-text" : undefined} />
          </IconButton>
          <IconButton label="Assistant settings" size="sm" onClick={onOpenSettings}>
            <Settings size={15} aria-hidden />
          </IconButton>
          <IconButton label="Minimize to the dot" size="sm" onClick={onCollapse}>
            <Minus size={16} aria-hidden />
          </IconButton>
          <IconButton label="Close (keeps the conversation)" size="sm" onClick={onCollapse}>
            <X size={16} aria-hidden />
          </IconButton>
        </div>
      </header>

      {view === "history" ? (
        <NovaHistory />
      ) : items.length === 0 ? (
        <EmptyState {...props} onSuggestion={(text) => void send(text)} />
      ) : (
        <NovaConversation items={items} onConfirm={(id, approved) => void confirm(id, approved).catch(report)} onRetry={() => void retry()} />
      )}

      {(voice.error || actionError) && (
        <div role="alert" className="mx-4 mb-1 flex items-start gap-2 rounded-[10px] bg-warning/10 px-3 py-1.5 text-[11.5px] text-warning">
          <span className="min-w-0 flex-1">{actionError ?? voice.error}</span>
          {!actionError && voice.errorSettings && (
            <button type="button" className="shrink-0 font-medium underline underline-offset-2 hover:text-fg" onClick={() => openVoiceSettings(voice.errorSettings!)}>
              Open settings
            </button>
          )}
        </div>
      )}

      <NovaInput
        busy={busy}
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
            title={listening ? "Stop listening" : "Talk to NOVA (push to talk)"}
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

      <footer className="flex items-center gap-2.5 px-4 pb-2.5 text-[11px] text-fg-subtle">
        <button type="button" onClick={onOpenProviders} className="min-w-0 truncate hover:text-fg-muted" title="AI provider (change in Settings)">
          {agent?.activeProvider ? `${agent.activeProvider} · ${agent.activeModel}` : "Local mode · no AI provider"}
        </button>
        <span className="ml-auto flex shrink-0 items-center gap-2.5">
          <button
            type="button"
            onClick={() => {
              if (speakReplies) stopSpeaking();
              onToggleSpeech();
            }}
            aria-pressed={speakReplies}
            title={speakReplies ? "Spoken replies on" : "Spoken replies off"}
            className="flex items-center gap-1 hover:text-fg-muted"
          >
            {speakReplies ? <Volume2 size={12} aria-hidden className="text-accent-text" /> : <VolumeX size={12} aria-hidden />}
            {voice.mode === "speaking" ? "Speaking" : "Voice"}
          </button>
          <span className={cn("flex items-center gap-1", listening && "text-accent-text")} title={listening ? "Microphone on" : "Microphone off"}>
            {listening ? <Mic size={12} aria-hidden /> : <MicOff size={12} aria-hidden />}
            <span className="sr-only">{listening ? "Microphone on" : "Microphone off"}</span>
          </span>
          <span className={cn("flex items-center gap-1", attachments.some((a) => a.kind === "image") && "text-accent-text")} title="Screen sharing">
            {attachments.some((a) => a.kind === "image") ? <Monitor size={12} aria-hidden /> : <MonitorOff size={12} aria-hidden />}
            <span className="sr-only">{attachments.some((a) => a.kind === "image") ? "Screenshot attached" : "Screen not shared"}</span>
          </span>
          <Kbd>Esc</Kbd>
        </span>
      </footer>
    </motion.section>
  );
}

function EmptyState({ name, agent, finder, shortcut, shortcutError, onOpenProviders, onIndexFolders, onSuggestion }: NovaPanelProps & { onSuggestion: (text: string) => void }) {
  const keys = shortcutError ? [] : shortcutLabels(shortcut);
  const local = agent !== null && !agent.activeProvider;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-3">
      <h2 className="text-[22px] leading-tight font-semibold tracking-tight text-fg">
        {greetingFor(new Date())}
        {name && `, ${name}`}
      </h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-fg-muted">
        {local
          ? "Local mode: I can find files and open apps. Connect an AI provider for conversations, documents and screen help."
          : "Ask me anything — I can find files, open apps, write documents and, with your OK, look at your screen."}
      </p>
      {local && (
        <Button size="sm" variant="primary" className="mt-3" icon={<PlugZap size={14} aria-hidden />} onClick={onOpenProviders}>
          Connect an AI provider
        </Button>
      )}

      <div className="mt-4 flex flex-wrap gap-1.5">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" onClick={() => onSuggestion(s)} className="rounded-full border border-line bg-white/[0.035] px-3 py-1.5 text-left text-[12px] text-fg-muted transition-colors hover:border-line-strong hover:text-fg">
            {s}
          </button>
        ))}
      </div>

      {finder && finder.folders.length === 0 && (
        <div className="mt-4 rounded-[16px] border border-line bg-white/[0.025] p-3.5">
          <p className="flex items-center gap-2 text-[12.5px] font-medium text-fg">
            <FolderSearch size={15} className="text-accent-text" aria-hidden /> Make file search smarter
          </p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-fg-muted">
            NOVA Finder can index your Documents, Desktop, Downloads, Pictures, Music and Videos — names, dates and the text inside documents. The index stays on this PC.
          </p>
          <Button size="sm" variant="secondary" className="mt-2.5" onClick={onIndexFolders}>
            Index my folders
          </Button>
        </div>
      )}

      <p className="mt-4 text-[11.5px] leading-relaxed text-fg-subtle">
        {keys.length > 0 ? (
          <>
            Press{" "}
            <span className="inline-flex gap-0.5 align-middle">
              {keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </span>{" "}
            anywhere to open NOVA AI. Click the microphone to talk. NOVA never listens or looks at your screen unless you ask.
          </>
        ) : (
          "Click the microphone to talk. NOVA never listens or looks at your screen unless you ask."
        )}
      </p>
    </div>
  );
}
