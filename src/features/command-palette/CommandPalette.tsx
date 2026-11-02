import { Search } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { Kbd } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { useUi } from "@/stores/ui";
import { buildCommands, type Command } from "./commands";
import { filterCommands } from "./search";

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  return <AnimatePresence>{open && <PaletteDialog onClose={() => setPaletteOpen(false)} />}</AnimatePresence>;
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const commands = useMemo(() => buildCommands(), []);
  const results = useMemo(
    () => filterCommands(query.trim() ? commands : commands.filter((c) => !c.searchOnly), query).slice(0, 60),
    [commands, query],
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();
  const grouped = query.trim() === "";

  // Focus the input on open and hand focus back to where it was on close.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const run = (command: Command) => {
    onClose();
    command.run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const count = results.length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (count) setActive((i) => (i + 1) % count);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (count) setActive((i) => (i - 1 + count) % count);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const command = results[active];
      if (command) run(command);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Tab") {
      // The input is the palette's only focus stop.
      event.preventDefault();
    }
  };

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[13vh]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="glass-strong w-[min(660px,calc(100vw-48px))] overflow-hidden rounded-[26px]"
        initial={{ opacity: 0, y: -10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -6, scale: 0.98 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="flex h-14 items-center gap-3 border-b border-line px-4">
          <Search size={18} className="shrink-0 text-fg-subtle" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Type a command or search…"
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={results[active] ? `${listboxId}-${active}` : undefined}
            spellCheck={false}
            className="h-full flex-1 bg-transparent text-[15px] text-fg outline-none select-text placeholder:text-fg-subtle focus-visible:outline-none"
          />
          <Kbd>Esc</Kbd>
        </div>

        <ul ref={listRef} id={listboxId} role="listbox" aria-label="Commands" className="max-h-[min(420px,55vh)] overflow-y-auto p-2">
          {results.length === 0 && (
            <li role="presentation" className="px-3 py-10 text-center text-sm text-fg-muted">
              No commands match “{query.trim()}”
            </li>
          )}
          {results.map((command, index) => {
            const showHeader = grouped && command.group !== results[index - 1]?.group;
            const Icon = command.icon;
            const selected = index === active;
            return (
              <li key={command.id} role="presentation">
                {showHeader && <p className="px-3 pt-3 pb-1.5 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase first:pt-1">{command.group}</p>}
                <div
                  id={`${listboxId}-${index}`}
                  role="option"
                  aria-selected={selected}
                  data-index={index}
                  onMouseMove={() => setActive(index)}
                  onClick={() => run(command)}
                  className={cn(
                    "flex h-12 items-center gap-3 rounded-[11px] px-3 transition-colors duration-100",
                    selected ? "glass-pill" : "border border-transparent",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-[9px] border transition-colors",
                      selected ? "accent-soft border-accent/30 text-accent-text" : "border-line bg-white/[0.04] text-fg-muted",
                    )}
                  >
                    <Icon size={16} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-fg">{command.title}</span>
                    {command.subtitle && <span className="block truncate text-[12px] text-fg-subtle">{command.subtitle}</span>}
                  </span>
                  {command.shortcut ? (
                    <span className="flex shrink-0 gap-1">
                      {command.shortcut.map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </span>
                  ) : (
                    !grouped && <span className="shrink-0 text-[11px] text-fg-subtle">{command.group}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        <footer className="flex h-10 items-center gap-4 border-t border-line px-4 text-[11px] text-fg-subtle">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            Navigate
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd>
            Run
          </span>
          <span className="ml-auto tabular-nums">
            {results.length} {results.length === 1 ? "command" : "commands"}
          </span>
        </footer>
      </motion.div>
    </motion.div>
  );
}
