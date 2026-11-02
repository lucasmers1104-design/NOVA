import { motion } from "motion/react";
import { useId } from "react";
import { cn } from "@/lib/cn";

interface Option<T extends string | number> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string | number> {
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
  label: string;
}

export function SegmentedControl<T extends string | number>({ value, options, onChange, label }: SegmentedControlProps<T>) {
  const indicatorId = useId();

  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-full border border-white/[0.08] bg-black/25 p-1 shadow-[inset_0_1px_2px_rgb(0_0_0/0.25)]">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative h-7 rounded-full px-3 text-[13px] font-medium transition-colors duration-200",
              selected ? "text-fg" : "text-fg-muted hover:text-fg",
            )}
          >
            {selected && (
              <motion.span
                layoutId={indicatorId}
                className="glass-pill absolute inset-0 rounded-full"
                transition={{ type: "spring", stiffness: 500, damping: 38 }}
              />
            )}
            <span className="relative">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
