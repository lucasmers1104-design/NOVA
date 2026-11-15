import { RotateCcw } from "lucide-react";
import { type CSSProperties, useId } from "react";
import { cn } from "@/lib/cn";

interface SliderRowProps {
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** A double-click on the slider, or the small arrow beside the value, returns to this. */
  defaultValue?: number;
  /** How the value reads, e.g. `(v) => `${v} px``. */
  format?: (value: number) => string;
  disabled?: boolean;
  onChange: (value: number) => void;
}

/** A slider that says its value while it moves. Its search name (`data-setting`) is its label. */
export function SliderRow({ label, description, value, min, max, step = 1, defaultValue, format = String, disabled = false, onChange }: SliderRowProps) {
  const id = useId();
  const fill = max > min ? ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100 : 0;
  // The value to offer going back to; `null` while the slider already sits there.
  const standard = defaultValue !== undefined && value !== defaultValue ? defaultValue : null;
  return (
    <div data-setting={label} className={cn("py-3 first:pt-0 last:pb-0", disabled && "opacity-45")}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="min-w-0 truncate text-[13px] font-medium text-fg">
          {label}
        </label>
        <span className="flex shrink-0 items-center gap-1.5">
          {standard !== null && !disabled && (
            <button
              type="button"
              aria-label={`${label} auf Standard zurücksetzen`}
              title={`Standard: ${format(standard)}`}
              onClick={() => onChange(standard)}
              className="flex size-5 items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-white/[0.08] hover:text-fg"
            >
              <RotateCcw size={11} aria-hidden />
            </button>
          )}
          <output htmlFor={id} className="min-w-10 text-right text-[12.5px] font-medium text-fg tabular-nums">
            {format(value)}
          </output>
        </span>
      </div>
      {description && <p className="mt-0.5 text-[12px] leading-relaxed text-fg-muted">{description}</p>}
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={format(value)}
        onChange={(event) => onChange(Number(event.target.value))}
        onDoubleClick={() => defaultValue !== undefined && onChange(defaultValue)}
        className="nova-range mt-2.5 block w-full"
        style={{ "--range-fill": `${fill}%` } as CSSProperties}
      />
    </div>
  );
}
