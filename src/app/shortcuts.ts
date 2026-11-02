export interface Shortcut {
  id: "palette" | "sidebar" | "settings";
  keys: readonly string[];
  description: string;
}

/** Global keyboard shortcuts; displayed in Settings and the command palette. */
export const SHORTCUTS: readonly Shortcut[] = [
  { id: "palette", keys: ["Ctrl", "K"], description: "Open the command palette" },
  { id: "sidebar", keys: ["Ctrl", "B"], description: "Collapse or expand the sidebar" },
  { id: "settings", keys: ["Ctrl", ","], description: "Open Settings" },
];

export function shortcutKeys(id: Shortcut["id"]): readonly string[] {
  return SHORTCUTS.find((s) => s.id === id)?.keys ?? [];
}
