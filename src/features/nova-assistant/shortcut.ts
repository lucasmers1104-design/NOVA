/**
 * Keyboard shortcuts in the accelerator format the Rust side registers,
 * e.g. "Ctrl+Alt+Space" or "Super+Shift+N".
 */

const MODIFIER_CODES = new Set(["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight", "OSLeft", "OSRight"]);

export type ShortcutCapture =
  | { kind: "pending" }
  | { kind: "shortcut"; shortcut: string }
  | { kind: "invalid"; reason: string };

/** Turns a keydown into a shortcut; modifier-only presses wait for the key. */
export function captureShortcut(event: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): ShortcutCapture {
  if (!event.code || MODIFIER_CODES.has(event.code)) return { kind: "pending" };
  if (!event.ctrlKey && !event.altKey && !event.metaKey) {
    return { kind: "invalid", reason: "Combine a key with Ctrl, Alt or Win, so normal typing isn't intercepted." };
  }
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Super");
  parts.push(keyName(event.code));
  return { kind: "shortcut", shortcut: parts.join("+") };
}

/** "KeyN" → "N", "Digit4" → "4"; other codes ("Space", "F5", "ArrowUp") stay as they are. */
function keyName(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return code;
}

const LABELS: Record<string, string> = { Super: "Win", Control: "Ctrl", Ctrl: "Ctrl", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc" };

/** Display keys for a shortcut: "Super+Shift+KeyN" → ["Win", "Shift", "N"]. */
export function shortcutLabels(shortcut: string): string[] {
  if (!shortcut.trim()) return [];
  return shortcut.split("+").map((part) => {
    const key = part.trim();
    return LABELS[key] ?? keyName(key);
  });
}
