import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Bot, Check, Copy, KeyRound, MessageSquare, Pencil, Plus, Sparkles, Square, Trash } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Page } from "@/components/layout/PageHeader";
import { Button, IconButton } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Markdown } from "@/components/ui/Markdown";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { notifyError } from "@/features/notifications/store";
import { cn } from "@/lib/cn";
import { callNative } from "@/lib/native";
import { useUi } from "@/stores/ui";
import {
  aiKeys,
  cancelChat,
  type ChatMessage,
  type Conversation,
  PROVIDERS,
  type ProviderId,
  providerInfo,
  streamChat,
  useAiPreferences,
  useConversations,
  useKeyStatus,
  useMessages,
  useModels,
} from "./api";

interface Streaming {
  requestId: string;
  conversationId: string | null;
  userText: string;
  reply: string;
}

export default function AiPage() {
  const client = useQueryClient();
  const { data: conversations, error: listError } = useConversations();
  const { data: keys } = useKeyStatus();
  const prefs = useAiPreferences();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { data: messages } = useMessages(activeId);
  const navigate = useUi((s) => s.navigate);

  const hasKey = keys?.[prefs.provider] ?? false;
  const anyKey = keys ? Object.values(keys).some(Boolean) : false;
  const model = prefs.models[prefs.provider];

  const send = async (text: string) => {
    if (!model) {
      setFailure(`Choose a ${providerInfo(prefs.provider).name} model first.`);
      return;
    }
    const requestId = crypto.randomUUID();
    setFailure(null);
    setStreaming({ requestId, conversationId: activeId, userText: text, reply: "" });
    try {
      await streamChat(
        { requestId, conversationId: activeId, provider: prefs.provider, model, message: text, systemPrompt: prefs.systemPrompt, temperature: prefs.temperature },
        {
          onStarted: (conversationId) => {
            setActiveId(conversationId);
            setStreaming((s) => (s ? { ...s, conversationId } : s));
          },
          onDelta: (delta) => setStreaming((s) => (s ? { ...s, reply: s.reply + delta } : s)),
          onDone: () => {},
          onFailed: (error) => setFailure(error),
        },
      );
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setStreaming(null);
      void client.invalidateQueries({ queryKey: aiKeys.conversations });
      void client.invalidateQueries({ queryKey: ["ai", "messages"] });
    }
  };

  return (
    <Page>
      <div className="grid h-[calc(100vh-6.5rem)] min-h-[520px] grid-cols-[260px_minmax(0,1fr)] gap-4">
        <ConversationList
          conversations={conversations ?? []}
          error={listError}
          activeId={activeId}
          onSelect={(id) => {
            setActiveId(id);
            setFailure(null);
          }}
          onNew={() => {
            setActiveId(null);
            setFailure(null);
          }}
        />
        <section aria-label="Chat" className="glass flex min-h-0 flex-col rounded-[24px]">
          <ChatHeader hasKey={hasKey} />
          {!anyKey && keys ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
              <span className="accent-gradient flex size-14 items-center justify-center rounded-[18px] text-on-accent">
                <KeyRound size={24} aria-hidden />
              </span>
              <p className="text-[16px] font-semibold text-fg">Connect an AI provider</p>
              <p className="max-w-md text-[13px] text-fg-muted">
                Add an API key for Anthropic, OpenAI or Google Gemini. Keys are stored in Windows Credential Manager and never leave this PC except to
                authenticate with the provider you chose.
              </p>
              <Button variant="primary" size="sm" onClick={() => navigate("settings")}>
                Open AI provider settings
              </Button>
            </div>
          ) : (
            <MessageList messages={activeId ? messages ?? [] : []} streaming={streaming} failure={failure} />
          )}
          <Composer disabled={!hasKey} busy={streaming !== null} onSend={(t) => void send(t)} onStop={() => streaming && void cancelChat(streaming.requestId)} />
        </section>
      </div>
    </Page>
  );
}

function ChatHeader({ hasKey }: { hasKey: boolean }) {
  const prefs = useAiPreferences();
  const { data: models, error, isFetching } = useModels(prefs.provider, hasKey);
  const options = useMemo(() => {
    const list = models?.map((m) => m.id) ?? providerInfo(prefs.provider).suggestedModels;
    const current = prefs.models[prefs.provider];
    return current && !list.includes(current) ? [current, ...list] : list;
  }, [models, prefs.provider, prefs.models]);

  // Pick a sensible default once the provider's list is known.
  useEffect(() => {
    if (!prefs.models[prefs.provider] && models?.length) {
      const preferred = models.find((m) => /sonnet|gpt|pro|flash/i.test(m.id)) ?? models[0]!;
      prefs.setModel(prefs.provider, preferred.id);
    }
  }, [models, prefs]);

  const select = "h-8 rounded-full border border-white/[0.1] bg-white/[0.06] px-3 text-[12.5px] text-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] outline-none focus:border-line-strong [&>option]:bg-canvas-raised";
  return (
    <header className="flex items-center gap-2 border-b border-line px-5 py-3">
      <Sparkles size={16} className="text-accent-text" aria-hidden />
      <h1 className="mr-auto text-[15px] font-semibold text-fg">NOVA AI</h1>
      <label className="sr-only" htmlFor="ai-provider">
        Provider
      </label>
      <select id="ai-provider" value={prefs.provider} onChange={(e) => prefs.setProvider(e.target.value as ProviderId)} className={select}>
        {PROVIDERS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor="ai-model">
        Model
      </label>
      <select
        id="ai-model"
        value={prefs.models[prefs.provider]}
        onChange={(e) => prefs.setModel(prefs.provider, e.target.value)}
        disabled={!hasKey || options.length === 0}
        className={cn(select, "max-w-56")}
        title={error ? `Couldn't load models: ${error instanceof Error ? error.message : String(error)}` : undefined}
      >
        {options.length === 0 && <option value="">{isFetching ? "Loading models…" : hasKey ? "No models found" : "Add a key first"}</option>}
        {options.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </header>
  );
}

function ConversationList({
  conversations,
  error,
  activeId,
  onSelect,
  onNew,
}: {
  conversations: Conversation[];
  error: unknown;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const client = useQueryClient();
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<Conversation | null>(null);

  const refresh = () => void client.invalidateQueries({ queryKey: aiKeys.conversations });

  return (
    <aside aria-label="Conversations" className="glass flex min-h-0 flex-col rounded-[24px] p-3">
      <Button variant="primary" size="md" icon={<Plus size={15} />} onClick={onNew} className="mb-3 w-full rounded-full">
        New chat
      </Button>
      {error ? (
        <StatusMessage error={error} subject="conversations" compact />
      ) : conversations.length === 0 ? (
        <p className="px-2 py-6 text-center text-[12.5px] text-fg-muted">Your conversations are saved here, on this PC.</p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {conversations.map((c) => (
            <li key={c.id} className="group relative">
              {renaming?.id === c.id ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void callNative("ai_conversation_rename", { id: c.id, title: renaming.title })
                      .then(refresh)
                      .catch((err) => notifyError("Couldn't rename", err));
                    setRenaming(null);
                  }}
                >
                  <input
                    autoFocus
                    value={renaming.title}
                    onChange={(e) => setRenaming({ id: c.id, title: e.target.value })}
                    onBlur={() => setRenaming(null)}
                    maxLength={80}
                    aria-label="Conversation title"
                    className="h-9 w-full rounded-control border border-line-strong bg-black/30 px-3 text-[13px] text-fg outline-none select-text"
                  />
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  aria-current={c.id === activeId ? "true" : undefined}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-[12px] px-3 py-2 pr-16 text-left transition-colors",
                    c.id === activeId ? "bg-white/[0.08]" : "hover:bg-white/[0.04]",
                  )}
                >
                  <MessageSquare size={13} className="shrink-0 text-fg-subtle" aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] text-fg">{c.title || "Untitled chat"}</span>
                    <span className="block truncate text-[11px] text-fg-subtle">
                      {providerInfo(c.provider)?.name ?? c.provider} · {new Date(c.updatedAt).toLocaleDateString()}
                    </span>
                  </span>
                </button>
              )}
              {renaming?.id !== c.id && (
                <span className="absolute top-2 right-1.5 flex opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                  <IconButton size="sm" label={`Rename ${c.title}`} onClick={() => setRenaming({ id: c.id, title: c.title })}>
                    <Pencil size={12} />
                  </IconButton>
                  <IconButton size="sm" label={`Delete ${c.title}`} onClick={() => setDeleting(c)} className="hover:text-danger">
                    <Trash size={12} />
                  </IconButton>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this conversation?"
        description={`“${deleting?.title ?? ""}” and all of its messages will be removed from this PC.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (!deleting) return;
          void callNative("ai_conversation_delete", { id: deleting.id })
            .then(() => {
              if (deleting.id === activeId) onNew();
              refresh();
            })
            .catch((err) => notifyError("Couldn't delete", err));
        }}
        onClose={() => setDeleting(null)}
      />
    </aside>
  );
}

function MessageList({ messages, streaming, failure }: { messages: ChatMessage[]; streaming: Streaming | null; failure: string | null }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const pendingUser = streaming && !messages.some((m) => m.role === "user" && m.content === streaming.userText && m.createdAt > Date.now() - 60_000);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming?.reply, failure]);

  if (messages.length === 0 && !streaming) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
        <span className="flex size-12 items-center justify-center rounded-[16px] border border-line bg-white/[0.04] text-accent-text">
          <Bot size={22} aria-hidden />
        </span>
        <p className="text-[15px] font-medium text-fg">How can I help?</p>
        <p className="max-w-sm text-[13px] text-fg-muted">Only what you type here is sent to the provider. NOVA never attaches files or system data.</p>
        {failure && <p className="mt-2 max-w-md text-[13px] text-danger">{failure}</p>}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
      aria-live="polite"
    >
      <div className="mx-auto max-w-3xl space-y-5">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {pendingUser && <MessageBubble message={{ id: "pending", role: "user", content: streaming.userText, error: null, createdAt: Date.now() }} />}
        {streaming && (
          <MessageBubble message={{ id: "streaming", role: "assistant", content: streaming.reply, error: null, createdAt: Date.now() }} streaming />
        )}
        {failure && !streaming && (
          <p role="alert" className="rounded-[12px] border border-danger/30 bg-danger/10 px-4 py-3 text-[13px] text-danger">
            {failure}
          </p>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ message, streaming }: { message: ChatMessage; streaming?: boolean }) {
  const [copied, setCopied] = useState(false);
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[80%] rounded-[20px] rounded-br-[6px] bg-accent px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap text-on-accent select-text">
          {message.content}
        </p>
      </div>
    );
  }
  return (
    <div className="group flex gap-3">
      <span className="accent-gradient mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-on-accent">
        <Sparkles size={14} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] text-fg-muted select-text">
          {message.content ? <Markdown source={message.content} /> : <span className="inline-block h-4 w-2 animate-[nova-pulse_1s_ease-in-out_infinite] bg-fg-muted" />}
        </div>
        {message.error && <p className="mt-2 text-[12px] text-warning">Stopped early: {message.error}</p>}
        {!streaming && message.content && (
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard?.writeText(message.content).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
            className="mt-1.5 flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/[0.06] hover:text-fg focus-visible:opacity-100"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
    </div>
  );
}

function Composer({ disabled, busy, onSend, onStop }: { disabled: boolean; busy: boolean; onSend: (text: string) => void; onStop: () => void }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || busy || disabled) return;
    onSend(trimmed);
    setText("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-line p-4">
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-[22px] border border-line bg-black/25 py-2 pr-2 pl-4 focus-within:border-line-strong">
        <label className="sr-only" htmlFor="ai-composer">
          Message
        </label>
        <textarea
          id="ai-composer"
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={disabled ? "Add an API key for this provider in Settings" : "Message NOVA AI — Enter to send, Shift+Enter for a new line"}
          className="max-h-[200px] min-h-[24px] flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-relaxed text-fg outline-none select-text placeholder:text-fg-subtle disabled:opacity-50"
        />
        {busy ? (
          <button type="button" onClick={onStop} aria-label="Stop generating" className="flex size-9 shrink-0 items-center justify-center rounded-full bg-fg text-canvas">
            <Square size={13} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!text.trim() || disabled}
            aria-label="Send message"
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition-opacity disabled:opacity-30"
          >
            <ArrowUp size={17} strokeWidth={2.4} />
          </button>
        )}
      </div>
    </div>
  );
}
