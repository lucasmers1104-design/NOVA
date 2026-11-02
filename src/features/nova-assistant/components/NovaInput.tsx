import { ArrowUp, Monitor, Paperclip, Square, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import type { AttachmentView, CaptureTarget, CaptureTargets } from "../types";

interface NovaInputProps {
  busy: boolean;
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
}

const iconButton = "flex size-8 shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-white/[0.08] hover:text-fg disabled:opacity-40";

/** Message box with attachments, screen sharing, voice and send/stop. */
export function NovaInput({ busy, attachments, onSend, onStop, onAttachFile, onLoadTargets, onCapture, onClearAttachments, mic, draft }: NovaInputProps) {
  const [text, setText] = useState("");
  const [targets, setTargets] = useState<CaptureTargets | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

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

  const submit = () => {
    if (busy || (!text.trim() && attachments.length === 0)) return;
    onSend(text);
    setText("");
  };

  return (
    <div className="border-t border-line px-3 pt-2.5 pb-2">
      {attachments.length > 0 && (
        <div className="mb-2 flex items-center gap-2" aria-label="Attached to your next message">
          {attachments.map((a) =>
            a.preview ? (
              <img key={a.label} src={a.preview} alt={a.label} title={a.label} className="h-10 max-w-20 rounded-[8px] border border-line object-cover" />
            ) : (
              <span key={a.label} className="max-w-40 truncate rounded-full border border-line bg-white/[0.04] px-2.5 py-1 text-[11px] text-fg-muted">
                📎 {a.label}
              </span>
            ),
          )}
          <span className="text-[11px] text-fg-subtle">Sent with your next message</span>
          <button type="button" className={cn(iconButton, "ml-auto size-6")} aria-label="Remove attachments" title="Remove attachments" onClick={onClearAttachments}>
            <X size={13} aria-hidden />
          </button>
        </div>
      )}
      <div className="relative flex items-end gap-1 rounded-[18px] border border-line bg-black/25 p-1.5 focus-within:border-line-strong">
        <button type="button" className={iconButton} aria-label="Attach a file" title="Attach a file" disabled={busy} onClick={onAttachFile}>
          <Paperclip size={16} aria-hidden />
        </button>
        <button
          type="button"
          className={iconButton}
          aria-label="Share your screen with NOVA"
          title="Share your screen with NOVA"
          aria-haspopup="menu"
          aria-expanded={targets !== null}
          disabled={busy}
          onClick={() => {
            if (targets) setTargets(null);
            else void onLoadTargets().then(setTargets, () => setTargets(null));
          }}
        >
          <Monitor size={16} aria-hidden />
        </button>
        {targets && (
          <div role="menu" className="glass-overlay absolute bottom-12 left-1 z-10 w-64 rounded-[14px] p-1.5">
            <p className="px-2.5 pt-1 pb-1.5 text-[11px] text-fg-subtle">Takes one screenshot now — NOVA's own windows are left out.</p>
            {[...targets.screens].sort((a, b) => Number(b.current) - Number(a.current)).map((screen) => (
              <button
                key={screen.index}
                type="button"
                role="menuitem"
                className="flex w-full items-center justify-between rounded-[10px] px-2.5 py-1.5 text-left text-[12.5px] text-fg hover:bg-white/[0.07]"
                onClick={() => {
                  setTargets(null);
                  onCapture({ kind: "screen", index: screen.index });
                }}
              >
                {screen.current && targets.screens.length > 1 ? "This screen" : screen.label}
                <span className="text-[10.5px] text-fg-subtle">
                  {screen.width}×{screen.height}
                </span>
              </button>
            ))}
            {targets.window && (
              <button
                type="button"
                role="menuitem"
                className="w-full truncate rounded-[10px] px-2.5 py-1.5 text-left text-[12.5px] text-fg hover:bg-white/[0.07]"
                onClick={() => {
                  setTargets(null);
                  onCapture({ kind: "window" });
                }}
              >
                Window: {targets.window}
              </button>
            )}
          </div>
        )}
        <textarea
          ref={area}
          rows={1}
          value={text}
          aria-label="Message NOVA"
          placeholder={busy ? "NOVA is working…" : "Ask NOVA anything…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className="max-h-33 min-h-8 flex-1 resize-none bg-transparent px-1.5 py-1.5 text-[13px] leading-snug text-fg outline-none select-text placeholder:text-fg-subtle"
        />
        {mic}
        {busy ? (
          <button type="button" className={cn(iconButton, "bg-white/[0.1] text-fg")} aria-label="Stop" title="Stop" onClick={onStop}>
            <Square size={13} fill="currentColor" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            className={cn(iconButton, "bg-accent text-on-accent hover:bg-accent-strong hover:text-on-accent")}
            aria-label="Send"
            title="Send (Enter)"
            disabled={!text.trim() && attachments.length === 0}
            onClick={submit}
          >
            <ArrowUp size={16} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
