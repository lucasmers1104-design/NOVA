import { AppWindow, ArrowUp, Monitor, Paperclip, Plus, Square, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import type { AttachmentView, CaptureTarget, CaptureTargets } from "../types";

interface NovaInputProps {
  busy: boolean;
  /** The microphone is open; the box shows the live transcript. */
  listening?: boolean;
  attachments: AttachmentView[];
  onSend: (text: string) => void;
  onStop: () => void;
  onAttachFile: () => void;
  onLoadTargets: () => Promise<CaptureTargets>;
  onCapture: (target: CaptureTarget) => void;
  onClearAttachments: () => void;
  /** The microphone button (voice input). */
  mic?: ReactNode;
  /** Text to put in the box, e.g. a transcript to review. */
  draft?: string;
  /** The user's previous message; Up in an empty box brings it back to edit. */
  lastMessage?: string;
}

const iconButton = "flex size-8 shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-white/[0.08] hover:text-fg disabled:opacity-40";
const menuItem = "flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left text-[12.5px] text-fg hover:bg-white/[0.07]";

/** One quiet message box: add (file or screenshot), text, voice, send/stop. */
export function NovaInput({ busy, listening = false, attachments, onSend, onStop, onAttachFile, onLoadTargets, onCapture, onClearAttachments, mic, draft, lastMessage }: NovaInputProps) {
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const [targets, setTargets] = useState<CaptureTargets | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (draft !== undefined) setText(draft);
  }, [draft]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);

  useEffect(() => {
    area.current?.focus();
  }, []);

  // The add menu closes on a click elsewhere or Esc.
  useEffect(() => {
    if (!adding) return;
    void onLoadTargets().then(setTargets, () => setTargets(null));
    const onPointerDown = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setAdding(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setAdding(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [adding, onLoadTargets]);

  const submit = () => {
    if (busy || (!text.trim() && attachments.length === 0)) return;
    onSend(text);
    setText("");
  };
  const ready = text.trim().length > 0 || attachments.length > 0;

  return (
    <div className="px-3 pt-1 pb-3">
      {attachments.length > 0 && (
        <div className="mb-2 flex items-center gap-2 px-1" aria-label="Attached to your next message">
          {attachments.map((a) =>
            a.preview ? (
              <img key={a.label} src={a.preview} alt={a.label} title={a.label} className="h-9 max-w-16 rounded-[8px] border border-line object-cover" />
            ) : (
              <span key={a.label} className="max-w-40 truncate rounded-full bg-white/[0.06] px-2.5 py-1 text-[11px] text-fg-muted">
                {a.label}
              </span>
            ),
          )}
          <button type="button" className={cn(iconButton, "ml-auto size-6")} aria-label="Remove attachments" title="Remove attachments" onClick={onClearAttachments}>
            <X size={13} aria-hidden />
          </button>
        </div>
      )}
      <div ref={menu} className="relative flex items-end gap-0.5 rounded-[20px] bg-white/[0.055] p-1.5 ring-1 ring-white/[0.06] transition-shadow focus-within:ring-white/[0.14]">
        <button
          type="button"
          className={cn(iconButton, adding && "bg-white/[0.08] text-fg")}
          aria-label="Add a file or a screenshot"
          title="Add a file or a screenshot"
          aria-haspopup="menu"
          aria-expanded={adding}
          disabled={busy}
          onClick={() => setAdding((open) => !open)}
        >
          <Plus size={17} aria-hidden className={cn("transition-transform", adding && "rotate-45")} />
        </button>
        {adding && (
          <div role="menu" aria-label="Add" className="glass-overlay absolute bottom-12 left-0 z-10 w-64 rounded-[14px] p-1.5">
            <button
              type="button"
              role="menuitem"
              className={menuItem}
              onClick={() => {
                setAdding(false);
                onAttachFile();
              }}
            >
              <Paperclip size={14} className="text-fg-muted" aria-hidden /> Attach a file…
            </button>
            {targets && (
              <>
                <p className="px-2.5 pt-2 pb-1 text-[10.5px] text-fg-subtle">Screenshot now (NOVA's windows are left out)</p>
                {[...targets.screens]
                  .sort((a, b) => Number(b.current) - Number(a.current))
                  .map((screen) => (
                    <button
                      key={screen.index}
                      type="button"
                      role="menuitem"
                      className={menuItem}
                      onClick={() => {
                        setAdding(false);
                        onCapture({ kind: "screen", index: screen.index });
                      }}
                    >
                      <Monitor size={14} className="text-fg-muted" aria-hidden />
                      <span className="flex-1">{screen.current && targets.screens.length > 1 ? "This screen" : targets.screens.length > 1 ? screen.label : "My screen"}</span>
                      <span className="text-[10.5px] text-fg-subtle">
                        {screen.width}×{screen.height}
                      </span>
                    </button>
                  ))}
                {targets.window && (
                  <button
                    type="button"
                    role="menuitem"
                    className={menuItem}
                    onClick={() => {
                      setAdding(false);
                      onCapture({ kind: "window" });
                    }}
                  >
                    <AppWindow size={14} className="shrink-0 text-fg-muted" aria-hidden />
                    <span className="truncate">{targets.window}</span>
                  </button>
                )}
              </>
            )}
          </div>
        )}
        <textarea
          ref={area}
          rows={1}
          value={text}
          aria-label="Message NOVA"
          placeholder={listening ? "Listening…" : busy ? "NOVA is working…" : "Ask NOVA…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            } else if (e.key === "ArrowUp" && !text && lastMessage && !busy) {
              e.preventDefault();
              setText(lastMessage);
            }
          }}
          className="max-h-33 min-h-8 flex-1 resize-none bg-transparent px-1.5 py-1.5 text-[13.5px] leading-snug text-fg outline-none select-text placeholder:text-fg-subtle"
        />
        {mic}
        {busy ? (
          <button type="button" className={cn(iconButton, "bg-white/[0.1] text-fg")} aria-label="Stop" title="Stop" onClick={onStop}>
            <Square size={12} fill="currentColor" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            className={cn(iconButton, ready && "bg-accent text-on-accent hover:bg-accent-strong hover:text-on-accent")}
            aria-label="Send"
            title="Send (Enter)"
            disabled={!ready}
            onClick={submit}
          >
            <ArrowUp size={16} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
