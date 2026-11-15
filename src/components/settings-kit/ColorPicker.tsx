import { Check, Pipette } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { isHexColor, normalizeHex } from "@/design/color";
import { cn } from "@/lib/cn";

interface ColorPickerProps {
  label: string;
  /** A hex color, or `null` for the automatic choice (only with `autoLabel`). */
  value: string | null;
  swatches: readonly string[];
  /** What a swatch is called, e.g. "Smaragd"; without it a swatch reads as its hex value. */
  swatchName?: (swatch: string) => string;
  /** Adds a first option that means "decide for me", e.g. "Wie NOVA". */
  autoLabel?: string;
  disabled?: boolean;
  onChange: (value: string | null) => void;
}

/** Swatches, a free color from Windows' picker, and a hex field for an exact one. */
export function ColorPicker({ label, value, swatches, swatchName = (swatch) => swatch, autoLabel, disabled = false, onChange }: ColorPickerProps) {
  const hexId = useId();
  const [hex, setHex] = useState(value ?? "");
  // Follows a color chosen elsewhere (a swatch, a preset, undo).
  useEffect(() => setHex(value ?? ""), [value]);

  const current = value ? normalizeHex(value) : null;
  const custom = current !== null && !swatches.some((swatch) => normalizeHex(swatch) === current);
  const commit = (raw: string) => {
    setHex(raw);
    if (isHexColor(raw)) onChange(normalizeHex(raw));
  };

  return (
    <div className={cn("space-y-2.5", disabled && "pointer-events-none opacity-45")}>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap items-center gap-2">
        {autoLabel && (
          <button
            type="button"
            role="radio"
            aria-checked={current === null}
            onClick={() => onChange(null)}
            className={cn(
              "h-7 rounded-full border px-2.5 text-[12px] font-medium transition-colors",
              current === null ? "border-accent bg-accent/15 text-fg" : "border-line text-fg-muted hover:border-line-strong hover:text-fg",
            )}
          >
            {autoLabel}
          </button>
        )}
        {swatches.map((swatch) => {
          const selected = current === normalizeHex(swatch);
          return (
            <button
              key={swatch}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={swatchName(swatch)}
              title={swatchName(swatch)}
              onClick={() => onChange(normalizeHex(swatch))}
              className={cn("flex size-7 items-center justify-center rounded-full border border-white/15 transition-transform duration-200 hover:scale-110", selected && "ring-2 ring-fg/80 ring-offset-2 ring-offset-[#151a29]")}
              style={{ backgroundColor: swatch }}
            >
              {selected && <Check size={12} strokeWidth={3} className="text-white mix-blend-difference" aria-hidden />}
            </button>
          );
        })}
        <label
          title="Eigene Farbe"
          className={cn(
            "relative flex size-7 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-white/15 text-fg-muted transition-transform duration-200 hover:scale-110",
            custom && "ring-2 ring-fg/80 ring-offset-2 ring-offset-[#151a29]",
          )}
          style={custom ? { backgroundColor: current } : { backgroundImage: "conic-gradient(#f87171, #fbbf24, #34d399, #22d3ee, #8b5cf6, #f472b6, #f87171)" }}
        >
          <Pipette size={12} className="text-white mix-blend-difference" aria-hidden />
          <input type="color" aria-label={`${label}: eigene Farbe`} value={current ?? "#8b5cf6"} onChange={(event) => commit(event.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
        </label>
      </div>
      <div className="flex items-center gap-2">
        <label htmlFor={hexId} className="text-[11.5px] text-fg-subtle">
          Hex
        </label>
        <input
          id={hexId}
          value={hex}
          spellCheck={false}
          maxLength={7}
          placeholder="#8B5CF6"
          aria-invalid={hex !== "" && !isHexColor(hex)}
          onChange={(event) => commit(event.target.value.trim())}
          className={cn(
            "h-7 w-24 rounded-control border bg-black/25 px-2 font-mono text-[12px] text-fg uppercase outline-none select-text placeholder:text-fg-subtle",
            hex !== "" && !isHexColor(hex) ? "border-danger/60" : "border-line focus:border-line-strong",
          )}
        />
      </div>
    </div>
  );
}
