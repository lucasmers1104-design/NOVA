import { Check, CircleAlert, Wallpaper } from "lucide-react";
import { type CSSProperties, useEffect, useId, useMemo, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { useWallpaperPalette } from "@/design/wallpaper";
import { NativeUnavailableError } from "@/lib/native";
import {
  ACCENT_PRESETS,
  type AccentSetting,
  type AccentTokens,
  accentLabel,
  accentStyleVariables,
  deriveAccentTokens,
  MIN_TEXT_CONTRAST,
  resolveAccentColor,
  sameAccent,
  SURFACE_REFERENCE,
} from "@/design/accent";
import { contrastRatio, isHexColor, normalizeHex } from "@/design/color";
import { cn } from "@/lib/cn";
import { useSettings } from "@/stores/settings";

const DEFAULT_CUSTOM = "#ff5d8f";

/**
 * Accent picker with a scoped live preview: the draft accent is applied only
 * to the preview subtree (via CSS variables) until the user applies it.
 */
export function AccentSettings() {
  const applied = useSettings((s) => s.accent);
  const setAccent = useSettings((s) => s.setAccent);
  const [draft, setDraft] = useState<AccentSetting>(applied);
  const [hexInput, setHexInput] = useState(applied.kind === "custom" ? applied.color : DEFAULT_CUSTOM);
  const hexId = useId();

  // Follow changes made elsewhere (e.g. from the command palette).
  useEffect(() => setDraft(applied), [applied]);

  const tokens = useMemo(() => deriveAccentTokens(resolveAccentColor(draft)), [draft]);
  const dirty = !sameAccent(draft, applied);
  const hexValid = isHexColor(hexInput);
  const wallpaper = useWallpaperPalette();
  const wallpaperColors = wallpaper.status === "ready" ? wallpaper.colors : [];
  const customSelected = draft.kind === "custom" && !wallpaperColors.includes(normalizeHex(draft.color));

  const selectCustom = (value: string) => {
    setHexInput(value);
    if (isHexColor(value)) setDraft({ kind: "custom", color: normalizeHex(value) });
  };

  return (
    <div className="py-4 first:pt-0">
      <div className="flex items-start justify-between gap-6">
        <div>
          <p className="text-[13.5px] font-medium text-fg">Accent color</p>
          <p className="mt-0.5 text-[12.5px] text-fg-muted">Used for highlights, charts and active states across NOVA.</p>
        </div>
        <Badge tone={dirty ? "warning" : "neutral"}>{dirty ? "Previewing" : accentLabel(applied)}</Badge>
      </div>

      <div role="radiogroup" aria-label="Accent color" className="mt-4 flex flex-wrap items-center gap-3">
        {ACCENT_PRESETS.map((preset) => {
          const selected = draft.kind === "preset" && draft.id === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={preset.name}
              title={preset.name}
              onClick={() => setDraft({ kind: "preset", id: preset.id })}
              className={cn(
                "flex size-10 items-center justify-center rounded-full transition-transform duration-200 hover:scale-105",
                selected && "ring-2 ring-fg/80 ring-offset-2 ring-offset-[#151a29]",
              )}
              style={{ backgroundColor: preset.color }}
            >
              {selected && <Check size={17} strokeWidth={2.6} style={{ color: deriveAccentTokens(preset.color).onAccent }} />}
            </button>
          );
        })}

        <span aria-hidden className="mx-1 h-7 w-px bg-line" />

        <label
          title="Custom color"
          className={cn(
            "relative flex size-10 cursor-default items-center justify-center rounded-full bg-[conic-gradient(from_180deg,#f87171,#fbbf24,#34d399,#22d3ee,#818cf8,#e879f9,#f87171)] transition-transform duration-200 hover:scale-105",
            customSelected && "ring-2 ring-fg/80 ring-offset-2 ring-offset-[#151a29]",
          )}
        >
          <span className="sr-only">Pick a custom accent color</span>
          <input
            type="color"
            value={hexValid ? normalizeHex(hexInput) : DEFAULT_CUSTOM}
            onChange={(event) => selectCustom(event.target.value)}
            className="absolute inset-0 size-full cursor-default opacity-0"
          />
          {customSelected && <Check size={17} strokeWidth={2.6} className="text-white drop-shadow" aria-hidden />}
        </label>

        <div className="flex items-center gap-2">
          <label htmlFor={hexId} className="sr-only">
            Custom hex color
          </label>
          <input
            id={hexId}
            value={hexInput}
            onChange={(event) => selectCustom(event.target.value)}
            onFocus={() => hexValid && selectCustom(hexInput)}
            maxLength={7}
            spellCheck={false}
            aria-invalid={!hexValid}
            className={cn(
              "h-9 w-[104px] rounded-control border bg-black/25 px-3 font-mono text-[13px] text-fg uppercase outline-none select-text",
              hexValid ? "border-line focus:border-line-strong" : "border-danger/60",
            )}
          />
        </div>
      </div>

      <WallpaperRow palette={wallpaper} draft={draft} onSelect={setDraft} />

      <AccentPreview tokens={tokens} />

      <div className="mt-4 flex items-center justify-between gap-4">
        <p className="text-[12px] text-fg-subtle">
          {draft.kind === "wallpaper" ? "Updates automatically whenever you change your wallpaper." : ""}
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => setDraft(applied)}>
            Discard
          </Button>
          <Button size="sm" variant="primary" disabled={!dirty} onClick={() => setAccent(draft)}>
            Apply accent
          </Button>
        </div>
      </div>
    </div>
  );
}

interface WallpaperRowProps {
  palette: ReturnType<typeof useWallpaperPalette>;
  draft: AccentSetting;
  onSelect: (accent: AccentSetting) => void;
}

function WallpaperRow({ palette, draft, onSelect }: WallpaperRowProps) {
  const swatchRing = "ring-2 ring-fg/80 ring-offset-2 ring-offset-[#151a29]";

  let body;
  if (palette.status === "loading") {
    body = (
      <div className="flex gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="size-8 rounded-full" />
        ))}
      </div>
    );
  } else if (palette.status === "error") {
    body = (
      <p className="text-[12px] text-fg-subtle">
        {palette.error instanceof NativeUnavailableError
          ? "Available in the desktop app."
          : `Couldn't read your wallpaper: ${palette.error instanceof Error ? palette.error.message : String(palette.error)}`}
      </p>
    );
  } else if (palette.status === "none") {
    body = <p className="text-[12px] text-fg-subtle">Your desktop background is a solid color, so there's no image to sample.</p>;
  } else if (palette.colors.length === 0) {
    body = <p className="text-[12px] text-fg-subtle">Your wallpaper has no strong colors to build an accent from.</p>;
  } else {
    const auto = draft.kind === "wallpaper";
    body = (
      <div role="radiogroup" aria-label="Wallpaper colors" className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          role="radio"
          aria-checked={auto}
          onClick={() => onSelect({ kind: "wallpaper", color: palette.colors[0]! })}
          className={cn(
            "flex h-8 items-center gap-2 rounded-full border px-3 text-[12px] font-medium transition-colors",
            auto ? "accent-soft border-accent/50 text-fg" : "border-line bg-white/[0.04] text-fg-muted hover:text-fg",
          )}
        >
          <Wallpaper size={14} aria-hidden />
          Match automatically
        </button>
        {palette.colors.map((color) => {
          const selected = draft.kind === "custom" && normalizeHex(draft.color) === color;
          return (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`Wallpaper color ${color.toUpperCase()}`}
              title={color.toUpperCase()}
              onClick={() => onSelect({ kind: "custom", color })}
              className={cn("flex size-8 items-center justify-center rounded-full transition-transform hover:scale-105", selected && swatchRing)}
              style={{ backgroundColor: color }}
            >
              {selected && <Check size={14} strokeWidth={2.6} style={{ color: deriveAccentTokens(color).onAccent }} />}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="mt-4 flex items-center gap-4">
      <p className="w-36 shrink-0 text-[12.5px] text-fg-muted">From your wallpaper</p>
      {body}
    </div>
  );
}

function AccentPreview({ tokens }: { tokens: AccentTokens }) {
  const textContrast = contrastRatio(tokens.accentText, SURFACE_REFERENCE);
  const fillContrast = contrastRatio(tokens.onAccent, tokens.accent);

  return (
    <div
      style={accentStyleVariables(tokens) as CSSProperties}
      className="mt-5 grid gap-4 rounded-[16px] border border-line bg-black/20 p-5 sm:grid-cols-[1fr_auto]"
      aria-label="Accent preview"
      role="img"
    >
      {/* Illustrative only: these elements mimic controls but are not interactive. */}
      <div aria-hidden className="pointer-events-none min-w-0">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-9 items-center rounded-control bg-accent px-4 text-[13px] font-medium text-on-accent shadow-[0_8px_24px_-10px_var(--nova-accent-glow)]">
            Primary action
          </span>
          <span className="inline-flex h-6 w-11 items-center rounded-full bg-accent">
            <span className="ml-[22px] size-[18px] rounded-full bg-on-accent" />
          </span>
          <span className="text-[13px] font-medium text-accent-text">Accent link</span>
        </div>
        <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]">
          <div className="h-full w-[64%] rounded-full bg-accent" />
        </div>
        <svg viewBox="0 0 240 48" className="mt-4 h-12 w-full" preserveAspectRatio="none">
          <path d="M0 38 C30 34 40 16 70 20 S120 40 150 26 S200 6 240 12" fill="none" strokeWidth="2" style={{ stroke: tokens.accent }} />
        </svg>
      </div>

      <dl className="flex flex-col justify-center gap-2 text-[12px] sm:w-52">
        <ContrastRow label="Accent text on surfaces" ratio={textContrast} />
        <ContrastRow label="Text on accent fills" ratio={fillContrast} />
      </dl>
    </div>
  );
}

function ContrastRow({ label, ratio }: { label: string; ratio: number }) {
  const passes = ratio >= MIN_TEXT_CONTRAST;
  return (
    <div className="flex items-center justify-between gap-3 rounded-[10px] bg-white/[0.035] px-3 py-2">
      <dt className="text-fg-muted">{label}</dt>
      <dd className={cn("flex items-center gap-1 font-semibold tabular-nums", passes ? "text-success" : "text-warning")}>
        {passes ? <Check size={13} aria-hidden /> : <CircleAlert size={13} aria-hidden />}
        {ratio.toFixed(1)}:1
      </dd>
    </div>
  );
}
