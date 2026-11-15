import { Check, CircleAlert, Palette } from "lucide-react";
import { ColorPicker, SettingCard } from "@/components/settings-kit";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ACCENT_PRESETS, type AccentPresetId, type AccentSetting, type AccentTokens, MIN_TEXT_CONTRAST, resolveAccentColor, sameAccent, SURFACE_REFERENCE } from "@/design/accent";
import { contrastRatio, normalizeHex } from "@/design/color";
import type { WallpaperPaletteResult } from "@/design/wallpaper";
import { cn } from "@/lib/cn";
import { NativeUnavailableError } from "@/lib/native";

const PRESET_NAMES: Record<AccentPresetId, string> = { purple: "Violett", blue: "Blau", cyan: "Cyan", emerald: "Smaragd", amber: "Bernstein" };

/** What an accent is called in Settings. */
export function accentName(setting: AccentSetting): string {
  if (setting.kind === "wallpaper") return "Wie dein Hintergrundbild";
  if (setting.kind === "custom") return `Eigene Farbe ${normalizeHex(setting.color).toUpperCase()}`;
  return PRESET_NAMES[setting.id];
}

/** Why the wallpaper offers no colors, or `null` when it does. */
function wallpaperNote(palette: WallpaperPaletteResult): string | null {
  switch (palette.status) {
    case "loading":
      return "Die Farben deines Hintergrundbilds werden gelesen …";
    case "error":
      return palette.error instanceof NativeUnavailableError ? "Farben aus deinem Hintergrundbild gibt es in der NOVA-Desktop-App." : `Dein Hintergrundbild ließ sich nicht lesen: ${palette.error instanceof Error ? palette.error.message : String(palette.error)}`;
    case "none":
      return "Dein Desktop hat eine einfarbige Fläche als Hintergrund, also kein Bild, aus dem sich Farben lesen ließen.";
    case "ready":
      return palette.colors.length === 0 ? "Dein Hintergrundbild hat keine kräftigen Farben, aus denen ein Akzent werden könnte." : null;
  }
}

interface AccentCardProps {
  /** The accent NOVA wears. */
  applied: AccentSetting;
  /** The accent being tried on: the stage above shows it, the rest of NOVA not yet. */
  draft: AccentSetting;
  tokens: AccentTokens;
  wallpaper: WallpaperPaletteResult;
  onDraft: (accent: AccentSetting) => void;
  onApply: () => void;
}

/**
 * The accent, tried on in the stage first: a color that reads badly on NOVA's
 * surfaces shows it there (and in the contrast check) before the whole app wears it.
 */
export function AccentCard({ applied, draft, tokens, wallpaper, onDraft, onApply }: AccentCardProps) {
  const dirty = !sameAccent(draft, applied);
  const wallpaperColors = wallpaper.status === "ready" ? wallpaper.colors : [];
  const presets = ACCENT_PRESETS.map((preset) => preset.color);
  const swatches = [...presets, ...wallpaperColors.filter((color) => !presets.includes(normalizeHex(color)))];
  // "Automatic" is only on offer while there is a wallpaper to follow.
  const following = draft.kind === "wallpaper" && wallpaperColors.length > 0;
  const note = wallpaperNote(wallpaper);

  const choose = (color: string | null) => {
    if (color === null) return onDraft({ kind: "wallpaper", color: wallpaperColors[0] ?? resolveAccentColor(draft) });
    const preset = ACCENT_PRESETS.find((p) => p.color === normalizeHex(color));
    onDraft(preset ? { kind: "preset", id: preset.id } : { kind: "custom", color: normalizeHex(color) });
  };

  return (
    <SettingCard
      title="Akzentfarbe"
      description="Für Hervorhebungen, Diagramme und alles, was aktiv ist. Probier sie in der Vorschau an, bevor ganz NOVA sie trägt."
      icon={Palette}
      actions={<Badge tone={dirty ? "warning" : "neutral"}>{dirty ? "In der Vorschau" : accentName(applied)}</Badge>}
    >
      {/* A draft: touching a swatch is no change yet, applying it is. */}
      <div data-setting="Akzentfarbe" data-no-record className="space-y-3.5">
        <ColorPicker
          label="Akzentfarbe"
          value={following ? null : resolveAccentColor(draft)}
          swatches={swatches}
          swatchName={(swatch) => {
            const preset = ACCENT_PRESETS.find((p) => p.color === normalizeHex(swatch));
            return preset ? PRESET_NAMES[preset.id] : `Aus deinem Hintergrundbild: ${swatch.toUpperCase()}`;
          }}
          autoLabel={wallpaperColors.length > 0 ? "Wie dein Hintergrundbild" : undefined}
          onChange={choose}
        />
        <p className="text-[12px] leading-relaxed text-fg-subtle">
          {note ?? (following ? "Ändert sich von selbst, sobald du dein Hintergrundbild wechselst." : wallpaperColors.length > 0 ? "Die hinteren Farben stammen aus deinem Hintergrundbild." : "")}
        </p>
        <dl className="grid grid-cols-2 gap-2 text-[12px]">
          <ContrastRow label="Akzentschrift auf Flächen" ratio={contrastRatio(tokens.accentText, SURFACE_REFERENCE)} />
          <ContrastRow label="Schrift auf Akzentflächen" ratio={contrastRatio(tokens.onAccent, tokens.accent)} />
        </dl>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => onDraft(applied)}>
            Verwerfen
          </Button>
          <Button size="sm" variant="primary" disabled={!dirty} data-records onClick={onApply}>
            Akzent übernehmen
          </Button>
        </div>
      </div>
    </SettingCard>
  );
}

function ContrastRow({ label, ratio }: { label: string; ratio: number }) {
  const passes = ratio >= MIN_TEXT_CONTRAST;
  return (
    <div className="flex items-center justify-between gap-3 rounded-[10px] bg-white/[0.035] px-3 py-2">
      <dt className="text-fg-muted">{label}</dt>
      <dd className={cn("flex items-center gap-1 font-semibold tabular-nums", passes ? "text-success" : "text-warning")} title={passes ? "Gut lesbar" : "Schwer lesbar"}>
        {passes ? <Check size={13} aria-hidden /> : <CircleAlert size={13} aria-hidden />}
        {ratio.toFixed(1)}:1
      </dd>
    </div>
  );
}
