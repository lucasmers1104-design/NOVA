import { X } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { Kbd } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "AltGraph", "OS"]);
const KEY_NAMES: Record<string, string> = { " ": "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Escape: "Esc" };

/**
 * The key a shortcut is named after. Modifiers change what a key types (Ctrl+Alt+Q is
 * "@" on a German keyboard, Shift+1 is "!"), and a shortcut is the key, not that
 * character: so a letter or digit key whose character is neither goes by its position.
 */
function keyName(event: Pick<KeyboardEvent, "key"> & { code?: string }): string {
  const named = KEY_NAMES[event.key];
  if (named) return named;
  if (event.key.length !== 1) return event.key;
  if (/^[a-z0-9]$/i.test(event.key)) return event.key.toUpperCase();
  const position = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code ?? "");
  return position?.[1] ?? position?.[2] ?? event.key.toUpperCase();
}

/** The pressed keys as a shortcut such as "Ctrl+Alt+N"; `null` while only modifiers are down. */
export function shortcutFromEvent(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"> & { code?: string }): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Win");
  parts.push(keyName(event));
  return parts.join("+");
}

interface ShortcutRecorderProps {
  label: string;
  /** e.g. "Ctrl+Alt+N"; `null` while none is set. */
  value: string | null;
  onChange: (value: string | null) => void;
  /** A lone letter would fire while typing, so a modifier (or an F-key) is required by default. */
  requireModifier?: boolean;
  /** Shows a button that removes the shortcut. */
  clearable?: boolean;
  disabled?: boolean;
}

/** Click, press the keys, done. Escape leaves the shortcut as it was. */
export function ShortcutRecorder({ label, value, onChange, requireModifier = true, clearable = false, disabled = false }: ShortcutRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const onKeyDown = (event: KeyboardEvent) => {
    if (!recording) return;
    // Tab still leaves the field, so the keyboard never gets stuck here.
    if (event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecording(false);
      setHint(null);
      return;
    }
    const shortcut = shortcutFromEvent(event);
    if (!shortcut) return;
    const plain = !event.ctrlKey && !event.altKey && !event.metaKey && !/^F\d{1,2}$/.test(event.key);
    if (requireModifier && plain) {
      setHint("Mit Strg, Alt oder der Windows-Taste kombinieren");
      return;
    }
    onChange(shortcut);
    setRecording(false);
    setHint(null);
  };

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span className="inline-flex items-center gap-1.5">
        <button
          type="button"
          aria-label={recording ? `${label}: Tasten drücken` : `${label}: ${value ?? "nicht belegt"}. Ändern`}
          disabled={disabled}
          onClick={() => setRecording((now) => !now)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            setRecording(false);
            setHint(null);
          }}
          className={cn(
            "flex h-9 min-w-36 items-center justify-center gap-1 rounded-control border px-3 text-[12.5px] transition-colors disabled:opacity-45",
            recording ? "border-accent bg-accent/10 text-accent-text" : "border-line bg-black/25 text-fg hover:border-line-strong",
          )}
        >
          {recording ? "Tasten drücken …" : value ? value.split("+").map((key) => <Kbd key={key}>{key}</Kbd>) : <span className="text-fg-subtle">Nicht belegt</span>}
        </button>
        {clearable && value && !recording && (
          <button
            type="button"
            aria-label={`${label} entfernen`}
            title="Entfernen"
            disabled={disabled}
            onClick={() => onChange(null)}
            className="flex size-7 items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-white/[0.07] hover:text-fg"
          >
            <X size={13} aria-hidden />
          </button>
        )}
      </span>
      {hint && (
        <span role="alert" className="text-[11.5px] text-warning">
          {hint}
        </span>
      )}
    </span>
  );
}
