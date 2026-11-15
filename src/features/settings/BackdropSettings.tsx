import { GlassWater, ImagePlus, Images, Plus, Shapes, Wallpaper, X } from "lucide-react";
import { useBackdropImage } from "@/components/layout/Backdrop";
import { type Choice, ChoiceCards, ColorPicker, SegmentedControl, SettingCard, SettingLine, SliderRow } from "@/components/settings-kit";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import {
  type BackdropGradient,
  DEFAULT_BACKDROP_DIM,
  DEFAULT_CORNER_SCALE,
  DEFAULT_GLASS_OPACITY,
  GRADIENT_PRESETS,
  type GradientStyle,
  gradientCss,
  MAX_BACKDROP_BLUR,
  MAX_BACKDROP_DIM,
  MAX_CORNER_SCALE,
  MAX_GLASS_OPACITY,
  MAX_GRADIENT_COLORS,
  MIN_GLASS_OPACITY,
  MIN_GRADIENT_COLORS,
  presetGradient,
  UI_FONTS,
  type UiFont,
} from "@/design/backdrop";
import { notifyError } from "@/features/notifications/store";
import { callNative, isDesktop } from "@/lib/native";
import { useSettings } from "@/stores/settings";

const STYLES = [
  { value: "linear", label: "Linear" },
  { value: "mesh", label: "Flächen" },
  { value: "swirl", label: "Wirbel" },
] as const satisfies readonly { value: GradientStyle; label: string }[];

/** The color a newly added stop starts with. */
const NEW_COLOR = "#ffffff";
/** Glass colors to start from; any other comes from the picker. */
const GLASS_TINTS = ["#4c3a8f", "#1d4f7a", "#17594a", "#6b2a45", "#6b4a14", "#3a4152"];

const percent = (value: number) => `${value} %`;
const px = (value: number) => `${value} px`;
const degrees = (value: number) => `${value}°`;

/** What a background card shows: the thing itself, filling the card's picture. */
function Fill({ background }: { background: string }) {
  return <span className="h-full w-full" style={{ background, backgroundSize: "cover", backgroundPosition: "center" }} />;
}

/** The backgrounds on offer besides a gradient preset. */
const WALLPAPER = "wallpaper";
const PICTURE = "picture";
const OWN = "own";

/** Settings → Darstellung: what shines through the glass. */
export function BackgroundCard() {
  const gradient = useSettings((s) => s.backdropGradient);
  const setGradient = useSettings((s) => s.setBackdropGradient);
  const token = useSettings((s) => s.backdropImage);
  const setToken = useSettings((s) => s.setBackdropImage);
  const dim = useSettings((s) => s.backdropDim);
  const setDim = useSettings((s) => s.setBackdropDim);
  const blur = useSettings((s) => s.backdropBlur);
  const setBlur = useSettings((s) => s.setBackdropBlur);
  const animated = useSettings((s) => s.backdropAnimated);
  const setAnimated = useSettings((s) => s.setBackdropAnimated);
  const transparency = useSettings((s) => s.transparency);
  const wallpaperBackdrop = useSettings((s) => s.wallpaperBackdrop);
  const setWallpaperBackdrop = useSettings((s) => s.setWallpaperBackdrop);
  const setAccent = useSettings((s) => s.setAccent);
  const picture = useBackdropImage(token);
  const usingPicture = !gradient && token !== null;
  const own = gradient !== null && gradient.presetId === null;

  const value = gradient ? (gradient.presetId ?? OWN) : usingPicture ? PICTURE : WALLPAPER;
  const options: Choice<string>[] = [
    { value: WALLPAPER, label: "Windows", preview: <Wallpaper size={18} className="text-fg-muted" aria-hidden /> },
    // Only while they are in use: neither can be chosen from here, a picture needs the file dialog.
    ...(usingPicture ? [{ value: PICTURE, label: "Dein Bild", preview: picture ? <Fill background={`url(${picture})`} /> : <ImagePlus size={18} className="text-fg-muted" aria-hidden /> }] : []),
    ...(gradient && own ? [{ value: OWN, label: "Dein Verlauf", preview: <Fill background={gradientCss(gradient)} /> }] : []),
    ...GRADIENT_PRESETS.map((preset) => ({ value: preset.id, label: preset.name, preview: <Fill background={gradientCss(presetGradient(preset))} /> })),
  ];

  const choose = (next: string) => {
    if (next === PICTURE || next === OWN) return;
    if (next === WALLPAPER) {
      setGradient(null);
      setToken(null);
      return;
    }
    const preset = GRADIENT_PRESETS.find((p) => p.id === next);
    if (!preset) return;
    setGradient(presetGradient(preset));
    setToken(null);
    setAccent({ kind: "custom", color: preset.accent });
  };
  const pickPicture = () => {
    void callNative<string | null>("backdrop_image_pick").then(
      (picked) => {
        if (picked === null) return;
        setToken(picked);
        setGradient(null);
      },
      (error: unknown) => notifyError("Das Bild ließ sich nicht verwenden", error),
    );
  };
  const edit = (patch: Partial<BackdropGradient>) => gradient && setGradient({ ...gradient, ...patch, presetId: null });

  return (
    <SettingCard
      title="Hintergrund"
      description="Was durch das Glas scheint. Ein Verlauf bringt seine passende Akzentfarbe mit; jede Farbe lässt sich danach ändern."
      icon={Images}
      actions={
        <Button size="sm" variant="secondary" icon={<ImagePlus size={13} aria-hidden />} disabled={!isDesktop()} title="PNG, JPG, WebP oder GIF, bis 25 MB" onClick={pickPicture}>
          Eigenes Bild …
        </Button>
      }
    >
      <div data-setting="Hintergrund" className="pb-3.5">
        <ChoiceCards label="Hintergrund" columns={5} value={value} options={options} onChange={choose} />
      </div>

      {gradient && (
        <>
          <SettingLine label="Farben" description={gradient.presetId ? "Ändere eine Farbe, und der Verlauf gehört dir." : "Dein eigener Verlauf."}>
            <div className="flex items-center gap-2">
              {gradient.colors.map((color, index) => (
                <span key={index} className="relative">
                  <label className="block size-8 cursor-pointer overflow-hidden rounded-full border border-line-strong transition-transform duration-200 hover:scale-110 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-text" style={{ background: color }} title={color.toUpperCase()}>
                    <input type="color" aria-label={`Farbe ${index + 1}`} value={color} onChange={(event) => edit({ colors: gradient.colors.map((c, i) => (i === index ? event.target.value : c)) })} className="size-full cursor-pointer opacity-0" />
                  </label>
                  {gradient.colors.length > MIN_GRADIENT_COLORS && (
                    <button
                      type="button"
                      aria-label={`Farbe ${index + 1} entfernen`}
                      title="Farbe entfernen"
                      data-records
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
                  aria-label="Farbe hinzufügen"
                  title="Farbe hinzufügen"
                  data-records
                  onClick={() => edit({ colors: [...gradient.colors, NEW_COLOR] })}
                  className="flex size-8 items-center justify-center rounded-full border border-dashed border-line-strong text-fg-muted transition-colors hover:text-fg"
                >
                  <Plus size={14} aria-hidden />
                </button>
              )}
            </div>
          </SettingLine>
          <SettingLine label="Art des Verlaufs">
            <SegmentedControl label="Art des Verlaufs" value={gradient.style} options={STYLES} onChange={(style) => edit({ style })} />
          </SettingLine>
          {gradient.style !== "mesh" && <SliderRow label="Richtung" value={gradient.angle} min={0} max={359} format={degrees} onChange={(angle) => edit({ angle })} />}
        </>
      )}

      {usingPicture && <SliderRow label="Weichzeichnen" description="Macht das Bild hinter dem Glas ruhiger." value={blur} min={0} max={MAX_BACKDROP_BLUR} defaultValue={0} format={px} onChange={setBlur} />}
      {(gradient || usingPicture) && (
        <>
          <SliderRow label="Abdunkeln" description="Hält Schrift auf hellen Hintergründen lesbar." value={dim} min={0} max={MAX_BACKDROP_DIM} defaultValue={DEFAULT_BACKDROP_DIM} format={percent} onChange={setDim} />
          <SettingLine label="Hintergrund bewegen" description="Der Hintergrund treibt langsam. Das kostet Grafikleistung: auf Laptops und beim Spielen besser aus.">
            <Switch label="Hintergrund bewegen" checked={animated} onChange={setAnimated} />
          </SettingLine>
        </>
      )}
      <SettingLine
        label="Windows-Hintergrundbild zeigen"
        description={gradient || usingPicture ? "Aus, solange oben ein Verlauf oder dein eigenes Bild gewählt ist." : "Dein Desktop-Hintergrund scheint weich durch NOVAs Glas, wie bei macOS. Braucht Transparenz."}
        disabled={!transparency || gradient !== null || usingPicture}
      >
        <Switch label="Windows-Hintergrundbild zeigen" checked={wallpaperBackdrop && !gradient && !usingPicture} disabled={!transparency || gradient !== null || usingPicture} onChange={setWallpaperBackdrop} />
      </SettingLine>
    </SettingCard>
  );
}

/** Settings → Darstellung: how much glass there is, and its color. */
export function GlassCard() {
  const transparency = useSettings((s) => s.transparency);
  const setTransparency = useSettings((s) => s.setTransparency);
  const glass = useSettings((s) => s.glassOpacity);
  const setGlass = useSettings((s) => s.setGlassOpacity);
  const tint = useSettings((s) => s.glassTint);
  const setTint = useSettings((s) => s.setGlassTint);

  return (
    <SettingCard title="Glas" description="NOVAs Flächen sind aus Milchglas. Wie dicht es ist und welche Farbe es hat, bestimmst du." icon={GlassWater}>
      <SettingLine label="Transparenz" description="Milchglas-Flächen. Ohne läuft NOVA auf schwächerer Grafik flüssiger.">
        <Switch label="Transparenz" checked={transparency} onChange={setTransparency} />
      </SettingLine>
      <SliderRow
        label="Glasstärke"
        description="Wenig lässt den Hintergrund durchscheinen, viel macht die Flächen dichter."
        value={glass}
        min={MIN_GLASS_OPACITY}
        max={MAX_GLASS_OPACITY}
        defaultValue={DEFAULT_GLASS_OPACITY}
        format={percent}
        disabled={!transparency}
        onChange={setGlass}
      />
      <SettingLine label="Glasfarbe" description="Gibt dem Glas deine Farbe. Es bleibt dunkel genug, um darauf zu lesen." stacked disabled={!transparency}>
        <ColorPicker label="Glasfarbe" value={tint} swatches={GLASS_TINTS} autoLabel="Dunkles Glas" disabled={!transparency} onChange={setTint} />
      </SettingLine>
    </SettingCard>
  );
}

/** Settings → Darstellung: corners and typeface. */
export function ShapeCard() {
  const corners = useSettings((s) => s.cornerScale);
  const setCorners = useSettings((s) => s.setCornerScale);
  const font = useSettings((s) => s.uiFont);
  const setFont = useSettings((s) => s.setUiFont);
  const fonts = (Object.keys(UI_FONTS) as UiFont[]).map((id) => ({
    value: id,
    label: UI_FONTS[id].label,
    preview: (
      // A picture of the typeface, not part of the card's name.
      <span aria-hidden className="text-[22px] font-semibold text-fg" style={{ fontFamily: UI_FONTS[id].stack }}>
        Aa
      </span>
    ),
  }));

  return (
    <SettingCard title="Form und Schrift" description="Von kantig bis extra rund, und die Schrift, in der NOVA spricht." icon={Shapes}>
      <SliderRow label="Ecken" value={corners} min={0} max={MAX_CORNER_SCALE} defaultValue={DEFAULT_CORNER_SCALE} format={percent} onChange={setCorners} />
      <div data-setting="Schrift" className="pt-3.5">
        <ChoiceCards label="Schrift" columns={5} value={font} options={fonts} onChange={setFont} />
      </div>
    </SettingCard>
  );
}
