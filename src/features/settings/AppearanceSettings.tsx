import { Palette, Wind } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { RouteId } from "@/app/navigation";
import { ChoiceCards, PreviewStage, ResetButton, SettingCard } from "@/components/settings-kit";
import { type AccentSetting, accentStyleVariables, deriveAccentTokens, resolveAccentColor, sameAccent } from "@/design/accent";
import { useWallpaperPalette } from "@/design/wallpaper";
import { defaultSettings, type MotionPreference, useSettings } from "@/stores/settings";
import { AccentCard, accentName } from "./AccentSettings";
import { BackgroundCard, GlassCard, ShapeCard } from "./BackdropSettings";
import { MiniNova } from "./MiniNova";
import { SettingsSection } from "./SettingsLayout";

/** How something arrives with each motion setting, as a small curve. */
function Curve({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 64 40" className="h-10 w-16 text-accent-text" aria-hidden>
      <path d="M4 34 H60" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1" />
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const MOTION_OPTIONS: readonly { value: MotionPreference; label: string; description: string; preview: ReactNode }[] = [
  { value: "system", label: "Wie Windows", description: "Folgt der Windows-Einstellung", preview: <Curve path="M4 34 C20 34 24 8 60 8" /> },
  { value: "reduced", label: "Reduziert", description: "Wechselt ohne Gleiten", preview: <Curve path="M4 34 H30 V8 H60" /> },
  { value: "full", label: "Voll", description: "Alles gleitet und federt", preview: <Curve path="M4 34 C18 34 22 2 36 4 C44 5 46 9 60 8" /> },
];

/** Everything this page sets, back to how NOVA ships it. */
function resetAppearance() {
  const { accent, transparency, motion, wallpaperBackdrop, backdropGradient, backdropDim, glassOpacity, backdropImage, backdropBlur, backdropAnimated, glassTint, cornerScale, uiFont } = defaultSettings();
  useSettings.setState({ accent, transparency, motion, wallpaperBackdrop, backdropGradient, backdropDim, glassOpacity, backdropImage, backdropBlur, backdropAnimated, glassTint, cornerScale, uiFont });
}

/**
 * Settings → Darstellung. A small NOVA window on a stage shows what is being set:
 * background, glass, corners, font and motion as they are, the accent as a draft
 * that only the stage wears until it is applied.
 */
export function AppearanceSettings() {
  const applied = useSettings((s) => s.accent);
  const setAccent = useSettings((s) => s.setAccent);
  const motion = useSettings((s) => s.motion);
  const setMotion = useSettings((s) => s.setMotion);
  const wallpaper = useWallpaperPalette();
  const [draft, setDraft] = useState<AccentSetting>(applied);
  const [page, setPage] = useState<RouteId>("home");

  // Follows an accent set elsewhere (the command palette, a profile, a background preset).
  useEffect(() => setDraft(applied), [applied]);

  // A new motion setting shows itself: the small window changes its page once.
  const shownMotion = useRef(motion);
  useEffect(() => {
    if (shownMotion.current === motion) return;
    shownMotion.current = motion;
    setPage((now) => (now === "home" ? "system" : "home"));
  }, [motion]);

  const tokens = useMemo(() => deriveAccentTokens(resolveAccentColor(draft)), [draft]);
  const dirty = !sameAccent(draft, applied);

  return (
    <SettingsSection
      id="appearance"
      title="Darstellung"
      description="Akzentfarbe, Hintergrund, Glas, Ecken, Schrift und Bewegung. Die Vorschau zeigt jede Änderung sofort."
      icon={Palette}
      actions={<ResetButton label="Zurücksetzen …" onReset={resetAppearance} />}
    >
      <PreviewStage
        label="Vorschau: ein kleines NOVA-Fenster mit deiner Darstellung"
        backdrop="dusk"
        taskbar
        height={304}
        sticky
        // The draft accent, for the small window only.
        style={accentStyleVariables(tokens) as CSSProperties}
        corner={dirty ? <span className="rounded-full border border-warning/30 bg-black/50 px-2.5 py-1 text-[11.5px] font-medium text-warning backdrop-blur-md">Vorschau: {accentName(draft)}</span> : undefined}
      >
        <div className="flex h-full items-start justify-center px-4 pt-4">
          <MiniNova page={page} onPage={setPage} />
        </div>
      </PreviewStage>

      <AccentCard applied={applied} draft={draft} tokens={tokens} wallpaper={wallpaper} onDraft={setDraft} onApply={() => setAccent(draft)} />
      <BackgroundCard />
      <GlassCard />
      <ShapeCard />
      <SettingCard title="Bewegung" description="Wie Seiten wechseln, Schalter gleiten und Karten federn." icon={Wind}>
        <div data-setting="Bewegung">
          <ChoiceCards label="Bewegung" value={motion} options={MOTION_OPTIONS} onChange={setMotion} />
        </div>
      </SettingCard>
    </SettingsSection>
  );
}
