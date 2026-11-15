import { Blend, Monitor, Shapes, SlidersHorizontal, Wind } from "lucide-react";
import { ChoiceCards, ColorPicker, SegmentedControl, SettingCard, SettingLine, SliderRow } from "@/components/settings-kit";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/cn";
import { DEFAULT_ISLAND_PREFS, DEFAULT_LOOK, DEFAULT_MOTION, type IslandBorder, type IslandLook, type IslandMotionStyle, type IslandPrefs, type IslandTheme, LIMITS, type MonitorInfo } from "../types";
import { MiniPill } from "./MiniPill";
import type { UpdatePrefs } from "./useStudioPrefs";

interface PanelProps {
  prefs: IslandPrefs;
  update: UpdatePrefs;
}

const px = (value: number) => `${value} px`;
const percent = (value: number) => `${value} %`;
const seconds = (value: number) => `${value} s`;

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

export function FormCard({ prefs, update }: PanelProps) {
  const set = (key: "scale" | "radius" | "closedHeight") => (value: number) => update((now) => ({ ...now, look: { ...now.look, [key]: value } }), `look.${key}`);
  return (
    <SettingCard title="Form" description="Größe, Ecken und Höhe der Pille." icon={Shapes}>
      <SliderRow label="Größe" value={prefs.look.scale} {...LIMITS.scale} defaultValue={DEFAULT_LOOK.scale} format={percent} onChange={set("scale")} />
      <SliderRow label="Eckenradius" value={prefs.look.radius} {...LIMITS.radius} defaultValue={DEFAULT_LOOK.radius} format={px} onChange={set("radius")} />
      <SliderRow label="Höhe der geschlossenen Pille" value={prefs.look.closedHeight} {...LIMITS.closedHeight} defaultValue={DEFAULT_LOOK.closedHeight} format={px} onChange={set("closedHeight")} />
    </SettingCard>
  );
}

// ---------------------------------------------------------------------------
// Material
// ---------------------------------------------------------------------------

type Material = Pick<IslandLook, "background" | "opacity" | "frost" | "border" | "shadow">;

/** What the three ready-made designs are made of, as the starting point for a material of one's own. */
const THEME_MATERIAL: Record<Exclude<IslandTheme, "custom">, Material> = {
  black: { background: "#000000", opacity: 100, frost: 0, border: "fine", shadow: 60 },
  white: { background: "#fbfbfd", opacity: 100, frost: 0, border: "fine", shadow: 35 },
  glass: { background: "#14141e", opacity: 58, frost: 60, border: "fine", shadow: 60 },
};

/** The material on screen right now: the look's own with "custom", else the chosen design's. */
export function materialOf(prefs: Pick<IslandPrefs, "theme" | "look">): Material {
  if (prefs.theme !== "custom") return THEME_MATERIAL[prefs.theme];
  const { background, opacity, frost, border, shadow } = prefs.look;
  return { background, opacity, frost, border, shadow };
}

const THEMES = [
  { value: "black", label: "Schwarz" },
  { value: "white", label: "Weiß" },
  { value: "glass", label: "Glas" },
  { value: "custom", label: "Eigenes" },
] as const satisfies readonly { value: IslandTheme; label: string }[];

const BORDERS = [
  { value: "off", label: "Aus" },
  { value: "fine", label: "Fein" },
  { value: "glow", label: "Leuchten" },
] as const satisfies readonly { value: IslandBorder; label: string }[];

const BACKGROUNDS = ["#000000", "#0c0c0f", "#12283a", "#1d1530", "#2a1414", "#f4f4f7"];
const ACCENTS = ["#8b5cf6", "#22d3ee", "#34d399", "#fbbf24", "#ff3df0", "#f87171"];

export function MaterialCard({ prefs, update }: PanelProps) {
  const material = materialOf(prefs);
  // Touching the material makes it one's own, starting from the design on screen.
  const set = <K extends keyof Material>(key: K, value: Material[K]) =>
    update((now) => ({ ...now, theme: "custom", look: { ...now.look, ...materialOf(now), [key]: value } }), `material.${key}`);
  return (
    <SettingCard title="Material" description="Ein fertiges Design, oder dein eigenes aus Farbe, Deckkraft, Rand und Schatten." icon={Blend}>
      <div data-setting="Design" className="pb-3.5">
        <ChoiceCards
          label="Design der Island"
          columns={4}
          value={prefs.theme}
          options={THEMES.map((theme) => ({ ...theme, preview: <MiniPill width={84} look={{ ...prefs, theme: theme.value, look: theme.value === "custom" ? { ...prefs.look, ...materialOf(prefs) } : prefs.look }} /> }))}
          onChange={(theme) => update((now) => (theme === "custom" ? { ...now, theme, look: { ...now.look, ...materialOf(now) } } : { ...now, theme }), "theme")}
        />
      </div>
      <SettingLine label="Hintergrundfarbe" stacked>
        <ColorPicker label="Hintergrundfarbe" value={material.background} swatches={BACKGROUNDS} onChange={(color) => color && set("background", color)} />
      </SettingLine>
      <SliderRow label="Deckkraft" value={material.opacity} {...LIMITS.opacity} defaultValue={100} format={percent} onChange={(value) => set("opacity", value)} />
      <SliderRow
        label="Milchglas"
        description="Ein matter Schleier über dem Glas. Echtes Weichzeichnen des Desktops dahinter kann Windows bei einem transparenten Fenster nicht."
        value={material.frost}
        {...LIMITS.frost}
        defaultValue={DEFAULT_LOOK.frost}
        format={percent}
        onChange={(value) => set("frost", value)}
      />
      <SettingLine label="Rand">
        <SegmentedControl label="Rand" value={material.border} options={BORDERS} onChange={(border) => set("border", border)} />
      </SettingLine>
      <SliderRow label="Schatten" value={material.shadow} {...LIMITS.shadow} defaultValue={DEFAULT_LOOK.shadow} format={percent} onChange={(value) => set("shadow", value)} />
      <SettingLine label="Akzentfarbe" description="Färbt Visualizer, Fortschritt und das Leuchten von NOVA AI." stacked>
        <ColorPicker label="Akzentfarbe" value={prefs.look.accent} swatches={ACCENTS} autoLabel="Wie NOVA" onChange={(accent) => update((now) => ({ ...now, look: { ...now.look, accent } }), "look.accent")} />
      </SettingLine>
    </SettingCard>
  );
}

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/** The size curve of each style as a small graph: the overshoot is what "springy" means. */
function Curve({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 64 40" className="h-10 w-16 text-accent-text" aria-hidden>
      <path d="M4 34 H60" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1" />
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const STYLES: readonly { value: IslandMotionStyle; label: string; description: string; preview: React.ReactNode }[] = [
  { value: "springy", label: "Federnd", description: "Schwingt leicht über", preview: <Curve path="M4 34 C18 34 22 2 36 4 C44 5 46 9 60 8" /> },
  { value: "soft", label: "Weich", description: "Gleitet ans Ziel", preview: <Curve path="M4 34 C20 34 24 8 60 8" /> },
  { value: "minimal", label: "Minimal", description: "Schnell, nur Überblenden", preview: <Curve path="M4 34 C8 34 10 8 20 8 H60" /> },
];

function motionReduced(): boolean {
  const setting = document.documentElement.dataset.motion;
  return setting === "reduced" || (setting !== "full" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false));
}

export function MotionCard({ prefs, update }: PanelProps) {
  return (
    <SettingCard title="Bewegung" description="Wie die Island wächst, schrumpft und Inhalte wechselt." icon={Wind}>
      <div data-setting="Bewegungsstil" className="pb-3.5">
        <ChoiceCards label="Bewegungsstil" value={prefs.motion.style} options={STYLES} onChange={(style) => update((now) => ({ ...now, motion: { ...now.motion, style } }), "motion.style")} />
      </div>
      <SliderRow label="Tempo" value={prefs.motion.speed} {...LIMITS.speed} step={5} defaultValue={DEFAULT_MOTION.speed} format={percent} onChange={(speed) => update((now) => ({ ...now, motion: { ...now.motion, speed } }), "motion.speed")} />
      {motionReduced() && <p className="pt-3 text-[12px] leading-relaxed text-fg-muted">„Reduzierte Bewegung“ ist aktiv (Windows oder Einstellungen → Darstellung): Die Island wechselt dann ohne Animation, was immer hier gewählt ist.</p>}
    </SettingCard>
  );
}

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

type DotPlace = "beside" | "inside" | "hidden";

const DOT_PLACES = [
  { value: "beside", label: "Neben der Island" },
  { value: "inside", label: "In der Island" },
  { value: "hidden", label: "Aus" },
] as const satisfies readonly { value: DotPlace; label: string }[];

function dotPlace(prefs: IslandPrefs): DotPlace {
  return prefs.mode === "dotAndIsland" ? "beside" : prefs.dotInIsland ? "inside" : "hidden";
}

const DOT_HINT: Record<DotPlace, string> = {
  beside: "Der Punkt bleibt, wo er ist; die Island kommt dazu.",
  inside: "Der Punkt sitzt in der Island: ein Klick darauf öffnet NOVA AI. Sein Platz auf dem Desktop bleibt frei.",
  hidden: "Nur die Island. Strg+Alt+N, „Hey NOVA“ und ein Klick auf die leere Island öffnen NOVA AI weiterhin.",
};

/** The connected displays as they stand to each other; a click moves the island there. */
function MonitorMap({ monitors, value, onChange }: { monitors: readonly MonitorInfo[]; value: string | null; onChange: (monitor: string | null) => void }) {
  const left = Math.min(...monitors.map((m) => m.x));
  const top = Math.min(...monitors.map((m) => m.y));
  const width = Math.max(...monitors.map((m) => m.x + m.width)) - left;
  const height = Math.max(...monitors.map((m) => m.y + m.height)) - top;
  const scale = Math.min(260 / width, 96 / height);
  // Without a choice, or with a display that is gone, the island lives on the main one.
  const chosen = monitors.find((m) => m.name === value) ?? monitors.find((m) => m.primary) ?? monitors[0];
  return (
    <div role="radiogroup" aria-label="Bildschirm der Island" className="relative mx-auto" style={{ width: width * scale, height: height * scale }}>
      {monitors.map((monitor, index) => {
        const selected = monitor === chosen;
        return (
          <button
            key={monitor.name}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={`Bildschirm ${index + 1}${monitor.primary ? " (Hauptbildschirm)" : ""}`}
            title={monitor.name.replace(/^\\\\\.\\/, "")}
            onClick={() => onChange(monitor.primary ? null : monitor.name)}
            className={cn(
              "absolute flex items-start justify-center rounded-[6px] border pt-1 text-[11px] font-semibold transition-colors",
              selected ? "border-accent bg-accent/20 text-fg" : "border-line-strong bg-white/[0.04] text-fg-muted hover:bg-white/[0.08]",
            )}
            style={{ left: (monitor.x - left) * scale + 1, top: (monitor.y - top) * scale + 1, width: monitor.width * scale - 2, height: monitor.height * scale - 2 }}
          >
            {selected && <span aria-hidden className="absolute top-[3px] h-[5px] w-7 rounded-full bg-fg" />}
            <span className="mt-auto mb-auto">{index + 1}</span>
          </button>
        );
      })}
    </div>
  );
}

export function BehaviorCard({ prefs, update, monitors }: PanelProps & { monitors: readonly MonitorInfo[] }) {
  const place = dotPlace(prefs);
  const toggle = (key: "autoMinimize" | "hideInFullscreen" | "hidePreviews" | "showCallerNumber") => (value: boolean) => update((now) => ({ ...now, [key]: value }), key);
  return (
    <SettingCard title="Verhalten" description="Wann die Island sich zeigt, schließt und was sie preisgibt." icon={SlidersHorizontal}>
      <SettingLine label="NOVA-Punkt" description={DOT_HINT[place]} stacked>
        <SegmentedControl
          label="Wo der NOVA-Punkt sitzt"
          value={place}
          options={DOT_PLACES}
          onChange={(next) => update((now) => (next === "beside" ? { ...now, mode: "dotAndIsland" } : { ...now, mode: "islandOnly", dotInIsland: next === "inside" }), "dot")}
        />
      </SettingLine>
      <SettingLine label="Von selbst schließen" description="Eine geöffnete Island schließt sich, sobald der Zeiger sie eine Weile verlassen hat.">
        <Switch label="Von selbst schließen" checked={prefs.autoMinimize} onChange={toggle("autoMinimize")} />
      </SettingLine>
      <SliderRow
        label="Schließen nach"
        value={prefs.minimizeAfter}
        {...LIMITS.minimizeAfter}
        defaultValue={DEFAULT_ISLAND_PREFS.minimizeAfter}
        format={seconds}
        disabled={!prefs.autoMinimize}
        onChange={(minimizeAfter) => update((now) => ({ ...now, minimizeAfter }), "minimizeAfter")}
      />
      <SliderRow
        label="Benachrichtigungen bleiben"
        value={prefs.notificationSeconds}
        {...LIMITS.notificationSeconds}
        defaultValue={DEFAULT_ISLAND_PREFS.notificationSeconds}
        format={seconds}
        onChange={(notificationSeconds) => update((now) => ({ ...now, notificationSeconds }), "notificationSeconds")}
      />
      <SettingLine label="Im Vollbild ausblenden" description="Solange ein Spiel, Video oder eine Präsentation den Bildschirm füllt. Ein klingelnder Anruf zeigt sich trotzdem.">
        <Switch label="Im Vollbild ausblenden" checked={prefs.hideInFullscreen} onChange={toggle("hideInFullscreen")} />
      </SettingLine>
      {monitors.length > 1 && (
        <SettingLine label="Bildschirm" description="Ist der gewählte nicht angeschlossen, zieht die Island auf den Hauptbildschirm." stacked>
          <div className="flex items-center gap-3">
            <Monitor size={14} className="shrink-0 text-fg-subtle" aria-hidden />
            <MonitorMap monitors={monitors} value={prefs.monitor} onChange={(monitor) => update((now) => ({ ...now, monitor }), "monitor")} />
          </div>
        </SettingLine>
      )}
      <SettingLine label="Vorschauen verbergen" description="Zeigt nur, von welcher App eine Benachrichtigung kommt. Der Text erreicht die Island dann gar nicht; gespeichert wird er nie.">
        <Switch label="Vorschauen verbergen" checked={prefs.hidePreviews} onChange={toggle("hidePreviews")} />
      </SettingLine>
      <SettingLine label="Anrufernummer zeigen" description="Wenn dein Handy sie mitschickt. Namen kommen aus den Kontakten deines Handys.">
        <Switch label="Anrufernummer zeigen" checked={prefs.showCallerNumber} onChange={toggle("showCallerNumber")} />
      </SettingLine>
    </SettingCard>
  );
}
