import { Check } from "lucide-react";
import { motion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";
import { cn } from "@/lib/cn";

export interface Choice<T extends string | number> {
  value: T;
  label: string;
  description?: string;
  /** A small picture of what choosing this looks like. */
  preview?: ReactNode;
}

interface ChoiceCardsProps<T extends string | number> {
  label: string;
  value: T | null;
  options: readonly Choice<T>[];
  onChange: (value: T) => void;
  /** Cards per row. */
  columns?: 2 | 3 | 4 | 5 | 6;
  disabled?: boolean;
}

const COLUMNS = { 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5", 6: "grid-cols-6" } as const;

/** Large cards to choose one of, each with a small preview. Arrow keys move the choice, as in any radio group. */
export function ChoiceCards<T extends string | number>({ label, value, options, onChange, columns = 3, disabled = false }: ChoiceCardsProps<T>) {
  const ringId = useId();
  const group = useRef<HTMLDivElement>(null);
  const selectedIndex = options.findIndex((option) => option.value === value);

  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    group.current?.querySelectorAll<HTMLElement>("[role=radio]")[next]?.focus();
  };

  return (
    <div ref={group} role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} className={cn("grid gap-2.5", COLUMNS[columns], disabled && "pointer-events-none opacity-45")}>
      {options.map((option, index) => {
        const selected = index === selectedIndex;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            // One tab stop for the group: the chosen card, or the first while none is chosen.
            tabIndex={selected || (selectedIndex === -1 && index === 0) ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "group relative flex min-w-0 flex-col items-stretch gap-2 rounded-[16px] border p-2.5 text-left transition-[border-color,background-color,transform] duration-200 ease-nova active:scale-[0.985]",
              selected ? "border-transparent bg-accent/[0.09]" : "border-line bg-white/[0.02] hover:border-line-strong hover:bg-white/[0.05]",
            )}
          >
            {selected && <motion.span layoutId={ringId} className="pointer-events-none absolute inset-0 rounded-[16px] border-[1.5px] border-accent" transition={{ type: "spring", stiffness: 480, damping: 36 }} />}
            {option.preview && <span className="flex h-16 items-center justify-center overflow-hidden rounded-[10px] bg-black/30">{option.preview}</span>}
            <span className="flex min-w-0 items-center gap-1.5 px-0.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium text-fg">{option.label}</span>
                {option.description && <span className="block truncate text-[11.5px] text-fg-subtle">{option.description}</span>}
              </span>
              {selected && (
                <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent">
                  <Check size={10} strokeWidth={3} aria-hidden />
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
