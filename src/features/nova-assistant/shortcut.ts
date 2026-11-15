/**
 * Keyboard shortcuts in the accelerator format the Rust side registers and stores,
 * e.g. "Ctrl+Alt+Space" or "Super+Shift+N" (`parse_shortcut` in src-tauri/src/assistant.rs),
 * and their way to and from Settings, where the settings kit's recorder says
 * "Ctrl+Alt+Space" and "Win+Shift+N" and the page shows "Strg+Alt+Leertaste".
 */

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

/** The names on a German keyboard, where they differ. */
const GERMAN_KEYS: Record<string, string> = { Ctrl: "Strg", Space: "Leertaste" };

/** A stored shortcut as Settings shows it: "Ctrl+Alt+Space" → "Strg+Alt+Leertaste"; `null` for none. */
export function shortcutText(shortcut: string): string | null {
  const keys = shortcutLabels(shortcut);
  return keys.length > 0 ? keys.map((key) => GERMAN_KEYS[key] ?? key).join("+") : null;
}

/** What the recorder calls a key, where Rust's parser wants another name. */
const ACCELERATOR_KEYS: Record<string, string> = { Win: "Super", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight", Esc: "Escape" };

/**
 * What the recorder recorded, in Rust's format: "Shift+Win+Up" → "Shift+Super+ArrowUp".
 * A key Rust doesn't know goes through unchanged: Rust then says so, and Settings shows it.
 */
export function toAccelerator(recorded: string | null): string {
  return (recorded ?? "")
    .split("+")
    .map((key) => ACCELERATOR_KEYS[key] ?? key)
    .join("+");
}
