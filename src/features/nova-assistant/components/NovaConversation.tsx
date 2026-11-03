import { ArrowDown, Check, Copy, RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/ui/Markdown";
import { cn } from "@/lib/cn";
import { type AssistantItem, type Item, replyText, type UsageInfo } from "../conversation";
import { NovaToolCard } from "./NovaToolCard";

function formatTokens(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** "claude-opus-5-5 · 1.2k in · 340 out · ≈ $0.004" for one reply (all its rounds). */
export function usageLine(usage: UsageInfo[]): string | null {
  if (usage.length === 0) return null;
  const input = usage.reduce((s, u) => s + u.inputTokens, 0);
  const output = usage.reduce((s, u) => s + u.outputTokens, 0);
  const priced = usage.every((u) => u.costUsd !== null);
  const cost = usage.reduce((s, u) => s + (u.costUsd ?? 0), 0);
  const parts = [usage.at(-1)!.model, `${formatTokens(input)} in`, `${formatTokens(output)} out`];
  if (priced) parts.push(`≈ $${cost.toFixed(cost < 1 ? 4 : 2)}`);
  return parts.join(" · ");
}

function UserMessage({ item }: { item: Extract<Item, { kind: "user" }> }) {
  return (
    <div className="flex flex-col items-end gap-1.5">
      {item.attachments.map((a) =>
        a.preview ? (
          <img key={a.label} src={a.preview} alt={a.label} className="max-h-28 max-w-[70%] rounded-[12px] border border-line object-contain" />
        ) : (
          <span key={a.label} className="rounded-full bg-white/[0.06] px-2.5 py-0.5 text-[11px] text-fg-muted">
            {a.label}
          </span>
        ),
      )}
      {item.text && <p className="max-w-[85%] rounded-[18px] rounded-br-[6px] bg-white/[0.07] px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap text-fg select-text">{item.text}</p>}
    </div>
  );
}

function AssistantMessage({ item, onConfirm, onRetry, last }: { item: AssistantItem; onConfirm: (id: string, approved: boolean) => void; onRetry: () => void; last: boolean }) {
  const usage = usageLine(item.usage);
  const empty = item.segments.length === 0;
  const text = replyText(item).trim();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="group text-[13.5px] leading-relaxed text-fg" aria-busy={item.streaming}>
      {item.segments.map((segment, index) =>
        segment.type === "text" ? (
          <div key={index} className="select-text">
            <Markdown source={segment.text} className="nova-markdown" />
          </div>
        ) : (
          <NovaToolCard key={segment.tool.id} tool={segment.tool} onConfirm={(approved) => onConfirm(segment.tool.id, approved)} />
        ),
      )}
      {item.streaming && empty && (
        <span className="inline-flex gap-1 py-1" aria-label="NOVA is thinking">
          {[0, 1, 2].map((i) => (
            <span key={i} className="size-1.5 animate-[nova-pulse_1.2s_ease-in-out_infinite] rounded-full bg-accent-text" style={{ animationDelay: `${i * 0.15}s` }} />
          ))}
        </span>
      )}
      {item.error && (
        <div role="alert" className="mt-1.5 flex items-start gap-2 rounded-[12px] bg-danger/[0.08] px-3 py-2 text-[12px] text-fg">
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-danger" aria-hidden />
          <span className="min-w-0 flex-1">{item.error}</span>
          {last && (
            <button type="button" onClick={onRetry} className="flex shrink-0 items-center gap-1 font-medium text-accent-text hover:underline">
              <RotateCcw size={12} aria-hidden /> Retry
            </button>
          )}
        </div>
      )}
      {!item.streaming && (text || usage) && (
        <div className={cn("mt-1 -ml-1 flex items-center gap-1.5 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100", copied ? "opacity-100" : "opacity-0")}>
          {text && (
            <button
              type="button"
              aria-label={copied ? "Copied" : "Copy reply"}
              title={copied ? "Copied" : "Copy reply"}
              onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}
              className="flex size-6 items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-white/[0.08] hover:text-fg"
            >
              {copied ? <Check size={12} className="text-success" aria-hidden /> : <Copy size={12} aria-hidden />}
            </button>
          )}
          {usage && <p className="text-[10.5px] text-fg-subtle tabular-nums">{usage}</p>}
        </div>
      )}
    </div>
  );
}

interface NovaConversationProps {
  items: Item[];
  onConfirm: (id: string, approved: boolean) => void;
  onRetry: () => void;
}

/** The message list. Follows new content while the user is at the bottom. */
export function NovaConversation({ items, onConfirm, onRetry }: NovaConversationProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastUser = useRef<string | null>(null);
  const [away, setAway] = useState(false);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // A new message from the user always brings the view back down.
    const userId = items.findLast((i) => i.kind === "user")?.id ?? null;
    if (userId !== lastUser.current) {
      lastUser.current = userId;
      pinned.current = true;
      setAway(false);
    }
    if (pinned.current) el.scrollTop = el.scrollHeight;
  });

  const jumpToLatest = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = true;
    setAway(false);
    if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  };

  const lastAssistant = items.findLastIndex((i) => i.kind === "assistant");
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        role="log"
        aria-live="polite"
        aria-label="Conversation with NOVA"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          setAway(!pinned.current);
        }}
        className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pt-2 pb-3"
      >
        {items.map((item, index) =>
          item.kind === "user" ? (
            <UserMessage key={item.id} item={item} />
          ) : (
            <AssistantMessage key={item.id} item={item} onConfirm={onConfirm} onRetry={onRetry} last={index === lastAssistant} />
          ),
        )}
      </div>
      {away && (
        <button
          type="button"
          aria-label="Jump to latest"
          title="Jump to latest"
          onClick={jumpToLatest}
          className="glass-overlay absolute bottom-2 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full text-fg-muted transition-colors hover:text-fg"
        >
          <ArrowDown size={15} aria-hidden />
        </button>
      )}
    </div>
  );
}
