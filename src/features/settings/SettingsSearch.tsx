import { CornerDownLeft, type LucideIcon, Search, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/cn";

export interface SearchResult {
  label: string;
  section: string;
}

interface SettingsSearchProps {
  query: string;
  onQuery: (query: string) => void;
  results: readonly SearchResult[];
  /** What a result's section is called, and its icon. */
  sectionOf: (id: string) => { label: string; icon: LucideIcon } | undefined;
  onOpen: (section: string, setting: string) => void;
  /** The wide field on the Settings home; without it, the narrow one beside the sections. */
  large?: boolean;
  autoFocus?: boolean;
}

/**
 * The search for a setting: type, pick with the arrow keys, Enter jumps to the row
 * and lights it up. A combobox, so a screen reader hears the result under the cursor.
 */
export function SettingsSearch({ query, onQuery, results, sectionOf, onOpen, large = false, autoFocus = false }: SettingsSearchProps) {
  const listId = useId();
  const field = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(0);
  const searching = query.trim() !== "";
  // A new query starts at its best result.
  useEffect(() => setActive(0), [query]);
  const optionId = (index: number) => `${listId}-${index}`;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && query) {
      event.preventDefault();
      onQuery("");
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (results.length === 0) return;
      event.preventDefault();
      setActive((now) => (now + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
    } else if (event.key === "Enter") {
      const result = results[active];
      if (result) onOpen(result.section, result.label);
    }
  };

  return (
    <div className={cn("min-w-0", large ? "space-y-2" : "space-y-3")}>
      {/* A click anywhere on the pill lands in the field, as it would on a label. */}
      <div
        onClick={() => field.current?.focus()}
        className={cn(
          "flex cursor-text items-center border transition-colors focus-within:border-accent-text/70",
          large ? "glass h-12 gap-3 rounded-full px-5" : "h-9 gap-2 rounded-control border-line bg-black/25 px-2.5",
        )}
      >
        <Search size={large ? 17 : 14} className="shrink-0 text-fg-subtle" aria-hidden />
        <input
          ref={field}
          role="combobox"
          aria-label="Einstellungen durchsuchen"
          aria-expanded={searching}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={searching && results[active] ? optionId(active) : undefined}
          autoFocus={autoFocus}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={large ? "Einstellung suchen, z. B. „Stimme“ oder „Akzentfarbe“" : "Einstellungen durchsuchen"}
          className={cn("h-full min-w-0 flex-1 bg-transparent text-fg outline-none select-text placeholder:text-fg-subtle", large ? "text-[14px]" : "text-[12.5px]")}
        />
        {query && (
          <button type="button" aria-label="Suche leeren" title="Suche leeren" onClick={() => onQuery("")} className="flex size-6 shrink-0 items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-white/[0.07] hover:text-fg">
            <X size={13} aria-hidden />
          </button>
        )}
      </div>
      <ul id={listId} role="listbox" aria-label="Gefundene Einstellungen" hidden={!searching} className={cn(large ? "glass rounded-widget p-1.5" : "space-y-0.5")}>
        {results.map((result, index) => {
          const section = sectionOf(result.section);
          const Icon = section?.icon;
          const current = index === active;
          return (
            <li
              key={`${result.section}:${result.label}`}
              id={optionId(index)}
              role="option"
              aria-selected={current}
              onMouseEnter={() => setActive(index)}
              onClick={() => onOpen(result.section, result.label)}
              className={cn("flex cursor-default items-center gap-3 transition-colors", large ? "rounded-[16px] px-3 py-2" : "rounded-control px-2.5 py-1.5", current ? "bg-white/[0.07]" : "hover:bg-white/[0.04]")}
            >
              {large && Icon && (
                <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] border border-line bg-white/[0.04] text-accent-text">
                  <Icon size={15} aria-hidden />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate font-medium text-fg", large ? "text-[13.5px]" : "text-[12.5px]")}>{result.label}</span>
                <span className={cn("block truncate text-fg-subtle", large ? "text-[12px]" : "text-[11px]")}>{section?.label}</span>
              </span>
              {large && current && <CornerDownLeft size={14} className="shrink-0 text-fg-subtle" aria-hidden />}
            </li>
          );
        })}
        {searching && results.length === 0 && (
          <li role="presentation" className={cn("text-fg-subtle", large ? "px-3 py-2.5 text-[13px]" : "px-2.5 text-[12px]")}>
            Nichts gefunden. Versuch ein anderes Wort.
          </li>
        )}
      </ul>
    </div>
  );
}
