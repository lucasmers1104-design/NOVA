import { Check, Plus, Wallpaper, X } from "lucide-react";
import type { CSSProperties } from "react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { type BackdropGradient, GRADIENT_PRESETS, type GradientPreset, type GradientStyle, gradientCss, MAX_BACKDROP_DIM, MAX_GLASS_OPACITY, MAX_GRADIENT_COLORS, MIN_GLASS_OPACITY, MIN_GRADIENT_COLORS, presetGradient } from "@/design/backdrop";
import { cn } from "@/lib/cn";
import { useSettings } from "@/stores/settings";
import { SettingRow } from "./SettingsLayout";

const STYLES = [
  { value: "linear", label: "Linear" },
  { value: "mesh", label: "Mesh" },
  { value: "swirl", label: "Swirl" },
] as const satisfies readonly { value: GradientStyle; label: string }[];

const SELECTED = "ring-2 ring-fg/80 ring-offset-2 ring-offset-[#151a29]";
/** The color a newly added stop starts with. */
const NEW_COLOR = "#ffffff";

function Slider({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return (
    <div className="flex items-center gap-2 text-[12px] text-fg-muted">
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="nova-range w-40"
        style={{ "--range-fill": `${((value - min) / (max - min)) * 100}%` } as CSSProperties}
      />
      <span className="w-9 text-right tabular-nums">
        {value}
        {label === "Direction" ? "°" : " %"}
      </span>
    </div>
  );
}

/** Settings → Appearance: what shines through the glass, and how much. */
export function BackdropSettings() {
  const gradient = useSettings((s) => s.backdropGradient);
  const setGradient = useSettings((s) => s.setBackdropGradient);
  const dim = useSettings((s) => s.backdropDim);
  const setDim = useSettings((s) => s.setBackdropDim);
  const glass = useSettings((s) => s.glassOpacity);
  const setGlass = useSettings((s) => s.setGlassOpacity);
  const setAccent = useSettings((s) => s.setAccent);

  const choose = (preset: GradientPreset) => {
    setGradient(presetGradient(preset));
    setAccent({ kind: "custom", color: preset.accent });
  };
  const edit = (patch: Partial<BackdropGradient>) => gradient && setGradient({ ...gradient, ...patch, presetId: null });
  const setColor = (index: number, color: string) => gradient && edit({ colors: gradient.colors.map((c, i) => (i === index ? color : c)) });

  return (
    <>
      <div className="py-4">
        <p className="text-[13.5px] font-medium text-fg">Background</p>
        <p className="mt-0.5 text-[12.5px] text-fg-muted">What shines through the glass. A preset also sets a matching accent color; every color can be changed below.</p>
        <div role="radiogroup" aria-label="Background" className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2.5">
          <button
            type="button"
            role="radio"
            aria-checked={gradient === null}
            onClick={() => setGradient(null)}
            className={cn("flex h-16 flex-col items-center justify-center gap-1 rounded-[12px] border border-line bg-white/[0.04] text-[11.5px] text-fg-muted transition-transform hover:scale-[1.03]", gradient === null && SELECTED)}
          >
            <Wallpaper size={16} aria-hidden />
            Wallpaper
          </button>
          {GRADIENT_PRESETS.map((preset) => {
            const selected = gradient?.presetId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => choose(preset)}
                style={{ background: gradientCss(presetGradient(preset)) }}
                className={cn("relative flex h-16 items-end overflow-hidden rounded-[12px] border border-line p-1.5 text-left text-[11px] font-medium text-white transition-transform [text-shadow:0_1px_3px_rgb(0_0_0/0.8)] hover:scale-[1.03]", selected && SELECTED)}
              >
                {preset.name}
                {selected && <Check size={14} strokeWidth={2.6} className="absolute top-1.5 right-1.5 drop-shadow" aria-hidden />}
              </button>
            );
          })}
        </div>
      </div>

      {gradient && (
        <>
          <SettingRow label="Colors" description={gradient.presetId ? "Change a color to make the gradient your own." : "Your own gradient."}>
            <div className="flex items-center gap-2">
              {gradient.colors.map((color, index) => (
                <span key={index} className="relative">
                  <label className="block size-9 cursor-default overflow-hidden rounded-full border border-line-strong" style={{ background: color }} title={color.toUpperCase()}>
                    <span className="sr-only">Color {index + 1}</span>
                    <input type="color" value={color} onChange={(e) => setColor(index, e.target.value)} className="size-full cursor-default opacity-0" />
                  </label>
                  {gradient.colors.length > MIN_GRADIENT_COLORS && (
                    <button
                      type="button"
                      aria-label={`Remove color ${index + 1}`}
                      title="Remove this color"
                      onClick={() => edit({ colors: gradient.colors.filter((_, i) => i !== index) })}
                      className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-canvas-raised text-fg-muted ring-1 ring-line hover:text-fg"
                    >
                      <X size={10} aria-hidden />
                    </button>
                  )}
                </span>
              ))}
              {gradient.colors.length < MAX_GRADIENT_COLORS && (
                <button
                  type="button"
                  aria-label="Add a color"
                  title="Add a color"
                  onClick={() => edit({ colors: [...gradient.colors, NEW_COLOR] })}
                  className="flex size-9 items-center justify-center rounded-full border border-dashed border-line-strong text-fg-muted hover:text-fg"
                >
                  <Plus size={15} aria-hidden />
                </button>
              )}
            </div>
          </SettingRow>
          <SettingRow label="Style">
            <SegmentedControl label="Gradient style" value={gradient.style} options={STYLES} onChange={(style) => edit({ style })} />
          </SettingRow>
          {gradient.style !== "mesh" && (
            <SettingRow label="Direction">
              <Slider label="Direction" value={gradient.angle} min={0} max={359} onChange={(angle) => edit({ angle })} />
            </SettingRow>
          )}
          <SettingRow label="Darken" description="Keeps text readable on bright colors.">
            <Slider label="Darken" value={dim} min={0} max={MAX_BACKDROP_DIM} onChange={setDim} />
          </SettingRow>
        </>
      )}

      <SettingRow label="Glass strength" description="Low lets the background shine through, high makes the panes more solid. Needs transparency effects.">
        <Slider label="Glass strength" value={glass} min={MIN_GLASS_OPACITY} max={MAX_GLASS_OPACITY} onChange={setGlass} />
      </SettingRow>
    </>
  );
}
