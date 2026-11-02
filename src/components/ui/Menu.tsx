import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/cn";

export type MenuEntry =
  | { kind: "item"; id: string; label: string; icon?: ReactNode; checked?: boolean; danger?: boolean; disabled?: boolean; onSelect: () => void }
  | { kind: "separator"; id: string };

interface MenuProps {
  /** Renders the trigger; spread `props` onto a button. */
  trigger: (props: { onClick: () => void; "aria-haspopup": "menu"; "aria-expanded": boolean; "aria-controls": string }) => ReactNode;
  entries: readonly MenuEntry[];
  label: string;
  align?: "start" | "end";
  /** Opens upwards when the trigger sits near the bottom of the window. */
  side?: "bottom" | "top";
}

/** Dropdown menu with arrow-key navigation, Escape and click-outside dismissal. */
export function Menu({ trigger, entries, label, align = "start", side = "bottom" }: MenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    listRef.current?.querySelector<HTMLElement>("[role^=menuitem]:not([aria-disabled=true])")?.focus();
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    containerRef.current?.querySelector<HTMLElement>("[aria-haspopup=menu]")?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>("[role^=menuitem]:not([aria-disabled=true])") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      items[(index + delta + items.length) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? items[0] : items.at(-1))?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      close();
    }
  };

  return (
    <div ref={containerRef} className="relative">
      {trigger({ onClick: () => setOpen((o) => !o), "aria-haspopup": "menu", "aria-expanded": open, "aria-controls": menuId })}
      <AnimatePresence>
        {open && (
          <motion.div
            ref={listRef}
            id={menuId}
            role="menu"
            aria-label={label}
            onKeyDown={onKeyDown}
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            className={cn(
              "glass-strong absolute z-40 min-w-56 rounded-[18px] p-1.5",
              side === "top" ? "bottom-full mb-2" : "top-full mt-2",
              align === "end" ? "right-0 origin-top-right" : "left-0 origin-top-left",
            )}
          >
            {entries.map((entry) =>
              entry.kind === "separator" ? (
                <div key={entry.id} role="separator" className="my-1 h-px bg-line" />
              ) : (
                <button
                  key={entry.id}
                  type="button"
                  role={entry.checked === undefined ? "menuitem" : "menuitemradio"}
                  aria-checked={entry.checked}
                  aria-disabled={entry.disabled || undefined}
                  disabled={entry.disabled}
                  onClick={() => {
                    close();
                    entry.onSelect();
                  }}
                  className={cn(
                    "flex h-9 w-full items-center gap-2.5 rounded-[9px] px-2.5 text-left text-[13px] outline-none transition-colors",
                    "focus-visible:bg-white/[0.08] hover:bg-white/[0.06] disabled:opacity-40",
                    entry.danger ? "text-danger" : "text-fg",
                  )}
                >
                  <span className={cn("flex size-4 shrink-0 items-center justify-center", entry.checked ? "text-accent-text" : "text-fg-subtle")}>
                    {entry.icon}
                  </span>
                  <span className="truncate">{entry.label}</span>
                </button>
              ),
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
