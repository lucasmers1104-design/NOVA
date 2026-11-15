import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { Keyboard, MapPin, Paintbrush, Sparkles } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { ChoiceCards, ColorPicker, PreviewStage, ResetButton, SegmentedControl, SettingCard, SettingLine, ShortcutRecorder, SliderRow } from "@/components/settings-kit";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { prefersReducedMotion } from "@/design/themeDom";
import { notifyError } from "@/features/notifications/store";
import { recordChange } from "@/features/settings/recent";
import { HeaderSwitch, PrivacyNote, SettingsNotice, SettingsSection } from "@/features/settings/SettingsLayout";
import { cn } from "@/lib/cn";
import { callNative, isDesktop } from "@/lib/native";
import { ASSISTANT_STATUS_KEY, assistantStatus, configureAssistant, resetDotPosition } from "./api";
import { DotPicture, NovaDot } from "./components/NovaDot";
import { shortcutText, toAccelerator } from "./shortcut";
import { ASSISTANT_EVENTS, type AssistantPrefsUpdate, type AssistantState, type AssistantStatus, DEFAULT_DOT_LOOK, type DotCorner, type DotLook, type DotPlacement, type DotStyle } from "./types";

/** Shared with Settings → Start, so both switches stay in sync. */
const AUTOSTART_KEY = ["desktop", "autostart"] as const;

const TITLE = "Der NOVA-Punkt";
const DESCRIPTION = "Ein kleiner Punkt, der NOVA AI von überall auf deinem Desktop öffnet.";

const PLACEMENTS = [
  { value: "taskbar", label: "In der Taskleiste" },
  { value: "corner", label: "In einer Ecke" },
] as const satisfies readonly { value: DotPlacement; label: string }[];

/** `at`: where the corner's button sits on the small screen of the corner picker. */
const CORNERS = [
  { value: "topLeft", label: "Oben links", at: "top-1 left-1" },
  { value: "topRight", label: "Oben rechts", at: "top-1 right-1" },
  { value: "bottomLeft", label: "Unten links", at: "bottom-3 left-1" },
  { value: "bottomRight", label: "Unten rechts", at: "bottom-3 right-1" },
] as const satisfies readonly { value: DotCorner; label: string; at: string }[];

const STYLES = [
  { value: "liquid", label: "Liquid Glass" },
  { value: "pearl", label: "Perle" },
  { value: "halo", label: "Halo" },
  { value: "mono", label: "Graphit" },
  { value: "aura", label: "Aura" },
  { value: "glass", label: "Glas" },
  { value: "solid", label: "Flach" },
  { value: "ring", label: "Ring" },
  { value: "orb", label: "Orb" },
] as const satisfies readonly { value: DotStyle; label: string }[];

/** The look's `color` is "accent", "white" or a hex color; the picker knows white by this one. */
const WHITE = "#f3f4f8";
const SWATCHES: Record<string, string> = { [WHITE]: "Weiß", "#60a5fa": "Blau", "#34d399": "Grün", "#f472b6": "Pink", "#fbbf24": "Bernstein", "#94a3b8": "Schiefer" };

/** Changes from sliders and the color picker are sent this long after the last move. */
const SAVE_DELAY_MS = 220;

const px = (value: number) => `${value} px`;
const percent = (value: number) => `${value} %`;

/**
 * The look as it is being set: the stage follows every change at once, the dot
 * itself (through Rust) a moment after the last one.
 */
function useLookDraft(look: DotLook | undefined, save: (look: DotLook) => void) {
  const [draft, setDraft] = useState(look);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<DotLook | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;

  // Follows the look set elsewhere, unless a change of ours is still on its way.
  useEffect(() => {
    if (!timer.current) setDraft(look);
  }, [look]);

  // Leaving the page mid-wait must not lose the last change.
  useEffect(
    () => () => {
      if (!timer.current) return;
      clearTimeout(timer.current);
      timer.current = null;
      if (pending.current) saveRef.current(pending.current);
    },
    [],
  );

  const change = (patch: Partial<DotLook>, delay = 0) => {
    if (!draft) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      pending.current = null;
      saveRef.current(next);
    }, delay);
  };
  return [draft, change] as const;
}

/** Settings → Der NOVA-Punkt. The preferences live on the Rust side, which applies them to the windows. */
export function AssistantSettings() {
  const desktop = isDesktop();
  const client = useQueryClient();
  const { data: status } = useQuery({ queryKey: ASSISTANT_STATUS_KEY, queryFn: assistantStatus, enabled: desktop });
  const [rejected, setRejected] = useState<string | null>(null);

  const configure = useMutation({
    mutationFn: configureAssistant,
    onSuccess: (next) => {
      client.setQueryData(ASSISTANT_STATUS_KEY, next);
      setRejected(null);
    },
    onError: (error) => setRejected(error instanceof Error ? error.message : String(error)),
  });
  const reset = useMutation({
    mutationFn: resetDotPosition,
    onSuccess: (next) => client.setQueryData(ASSISTANT_STATUS_KEY, next),
    onError: (error) => notifyError("Der Punkt ließ sich nicht verschieben", error),
  });
  const { data: autostart } = useQuery({ queryKey: AUTOSTART_KEY, queryFn: () => callNative<boolean>("autostart_get"), enabled: desktop });
  const setAutostart = useMutation({
    mutationFn: (enabled: boolean) => callNative<boolean>("autostart_set", { enabled }),
    onSuccess: (enabled) => client.setQueryData(AUTOSTART_KEY, enabled),
    onError: (error) => notifyError("Der Autostart ließ sich nicht ändern", error),
  });

  // The dot changes preferences too: dragging it, or "Hide the dot" in its menu.
  useEffect(() => {
    if (!desktop) return;
    const unlisten = listen<AssistantStatus>(ASSISTANT_EVENTS.prefs, (event) => client.setQueryData(ASSISTANT_STATUS_KEY, event.payload));
    return () => void unlisten.then((stop) => stop());
  }, [client, desktop]);

  const update = (patch: Partial<AssistantPrefsUpdate>) => {
    if (!status) return;
    const { enabled, placement, corner, look, shortcut, background, hideInFullscreen } = status;
    configure.mutate({ enabled, placement, corner, look, shortcut, background, hideInFullscreen, ...patch });
  };
  const [look, changeLook] = useLookDraft(status?.look, (next) => update({ look: next }));
  // Recorded from keys, which the page's change log can't tell from typing: noted here.
  const setShortcut = (shortcut: string) => {
    update({ shortcut });
    recordChange("assistant", "Tastenkürzel");
  };

  if (!desktop) {
    return (
      <SettingsSection id="assistant" title={TITLE} description={DESCRIPTION} icon={Sparkles}>
        <SettingsNotice>Das gibt es in der NOVA-Desktop-App.</SettingsNotice>
      </SettingsSection>
    );
  }

  const busy = !status || configure.isPending;
  const shortcutProblem = rejected ?? status?.shortcutError ?? null;
  const placement = status?.placement ?? "taskbar";
  const inTaskbar = status ? status.docked : placement === "taskbar";
  // The stage shows where the dot is, or, while it is off, where it would be.
  const stagePlacement: DotPlacement = status?.enabled ? (inTaskbar ? "taskbar" : "corner") : placement === "taskbar" && status?.taskbarAvailable !== false ? "taskbar" : "corner";
  const cornerShown = placement === "corner" || (status !== undefined && !status.taskbarAvailable);
  const off = status !== undefined && !status.enabled;

  return (
    <SettingsSection
      id="assistant"
      title={TITLE}
      description={DESCRIPTION}
      icon={Sparkles}
      actions={
        <HeaderSwitch label="NOVA-Punkt anzeigen">
          <Switch label="NOVA-Punkt anzeigen" checked={status?.enabled ?? false} disabled={busy} onChange={(enabled) => update({ enabled })} />
        </HeaderSwitch>
      }
    >
      {status?.inIsland && <SettingsNotice>Gerade trägt Nova Island den Punkt (Tab NOVA Island → NOVA-Punkt „In der Island“). Er hat deshalb keinen eigenen Platz auf dem Desktop; sein Tastenkürzel und sein Aussehen gelten weiter.</SettingsNotice>}

      {look && status && <DotStage look={look} placement={stagePlacement} corner={status.corner} off={off} />}

      {look && (
        <SettingCard
          title="Aussehen"
          description="Stil, Größe und Farbe. Die Vorschau zeigt jede Änderung sofort, der Punkt auf dem Desktop einen Moment später."
          icon={Paintbrush}
          className={cn(off && "opacity-60")}
          actions={<ResetButton label="Standard-Aussehen" onReset={() => changeLook({ ...DEFAULT_DOT_LOOK, edgeGap: look.edgeGap })} />}
        >
          <div data-setting="Stil" className="pb-3.5">
            <ChoiceCards label="Stil des Punkts" columns={3} value={look.style} options={STYLES.map((style) => ({ ...style, preview: <DotPicture look={{ ...look, style: style.value, diameter: 30 }} /> }))} onChange={(style) => changeLook({ style })} />
          </div>
          <SliderRow label="Größe" value={look.diameter} min={16} max={56} step={2} defaultValue={DEFAULT_DOT_LOOK.diameter} format={px} onChange={(diameter) => changeLook({ diameter }, SAVE_DELAY_MS)} />
          <SliderRow
            label="Deckkraft in Ruhe"
            description="Zeigst du auf den Punkt oder tut NOVA etwas, ist er immer ganz da."
            value={look.idleOpacity}
            min={25}
            max={100}
            step={5}
            defaultValue={DEFAULT_DOT_LOOK.idleOpacity}
            format={percent}
            onChange={(idleOpacity) => changeLook({ idleOpacity }, SAVE_DELAY_MS)}
          />
          <SettingLine label="Farbe" stacked>
            <ColorPicker
              label="Farbe des Punkts"
              value={look.color === "accent" ? null : look.color === "white" ? WHITE : look.color}
              swatches={Object.keys(SWATCHES)}
              swatchName={(swatch) => SWATCHES[swatch] ?? swatch}
              autoLabel="Wie NOVA"
              onChange={(color) => changeLook({ color: color === null ? "accent" : color === WHITE ? "white" : color }, SAVE_DELAY_MS)}
            />
          </SettingLine>
          <SettingLine label="Funkeln im Punkt">
            <Switch label="Funkeln im Punkt" checked={look.icon} onChange={(icon) => changeLook({ icon })} />
          </SettingLine>
          <SettingLine label="Zeigen, was NOVA gerade tut" description="Ein Ring um den Punkt: Er folgt deiner Stimme, dreht sich beim Denken und wird grün, wenn etwas fertig ist.">
            <Switch label="Zeigen, was NOVA gerade tut" checked={look.activity} onChange={(activity) => changeLook({ activity })} />
          </SettingLine>
          <SettingLine label="Leuchten">
            <Switch label="Leuchten" checked={look.glow} onChange={(glow) => changeLook({ glow, breathe: glow && look.breathe })} />
          </SettingLine>
          <SettingLine label="Ab und zu atmen" description="Das Leuchten pulsiert kurz, dann ruht es wieder eine Minute." disabled={!look.glow}>
            <Switch label="Ab und zu atmen" checked={look.breathe && look.glow} disabled={!look.glow} onChange={(breathe) => changeLook({ breathe })} />
          </SettingLine>
        </SettingCard>
      )}

      <SettingCard title="Platz" description="Du kannst den Punkt auch einfach ziehen: an der Taskleiste entlang oder irgendwohin, auf jeden Bildschirm." icon={MapPin}>
        <SettingLine
          label="Wo er sitzt"
          description={
            status?.customPosition ? (
              <>
                {inTaskbar ? "Wo du ihn in der Taskleiste abgelegt hast." : "Wo du ihn hingezogen hast."}{" "}
                <button type="button" data-records className="font-medium text-accent-text hover:underline" onClick={() => reset.mutate()}>
                  Zurück an seinen Platz
                </button>
              </>
            ) : placement === "taskbar" && status && !status.taskbarAvailable ? (
              "Deine Taskleiste blendet sich aus, deshalb sitzt der Punkt in der Ecke unten."
            ) : placement === "taskbar" ? (
              "In der Taskleiste, direkt hinter deinen App-Symbolen. Läuft eine App im Vollbild, verschwindet er mit der Taskleiste."
            ) : (
              "Über der Taskleiste, in einer Ecke deines Hauptbildschirms."
            )
          }
        >
          <SegmentedControl label="Wo der Punkt sitzt" value={placement} options={PLACEMENTS} onChange={(next) => update({ placement: next })} />
        </SettingLine>
        {cornerShown && (
          <>
            <SettingLine label="Ecke" description={CORNERS.find((corner) => corner.value === (status?.corner ?? "bottomRight"))?.label}>
              <CornerPicker value={status?.corner ?? "bottomRight"} onChange={(corner) => update({ corner })} />
            </SettingLine>
            {look && <SliderRow label="Abstand zum Rand" value={look.edgeGap} min={0} max={48} step={2} defaultValue={DEFAULT_DOT_LOOK.edgeGap} format={px} onChange={(edgeGap) => changeLook({ edgeGap }, SAVE_DELAY_MS)} />}
          </>
        )}
        {!inTaskbar && (
          <SettingLine label="In Vollbild-Apps ausblenden" description="Solange ein Spiel, Video oder eine Präsentation den Bildschirm füllt. Aus: Der Punkt bleibt über allem." disabled={off}>
            <Switch label="In Vollbild-Apps ausblenden" checked={status?.hideInFullscreen ?? false} disabled={busy || off} onChange={(hideInFullscreen) => update({ hideInFullscreen })} />
          </SettingLine>
        )}
      </SettingCard>

      <SettingCard title="Öffnen und da sein" description="Wie du NOVA AI ohne Maus öffnest, und wann der Punkt da ist." icon={Keyboard}>
        <SettingLine
          label="Tastenkürzel"
          description={
            shortcutProblem ? (
              <span role="alert" className="text-danger">
                {shortcutProblem}
              </span>
            ) : (
              "Öffnet und schließt NOVA AI aus jeder App. Klick auf das Feld und drück die neue Kombination."
            )
          }
        >
          <span className="flex items-center gap-1.5">
            {status && !status.shortcut && status.defaultShortcut && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setShortcut(status.defaultShortcut)}>
                {shortcutText(status.defaultShortcut)} nehmen
              </Button>
            )}
            <ShortcutRecorder label="Tastenkürzel" value={shortcutText(status?.shortcut ?? "")} disabled={busy} clearable onChange={(recorded) => setShortcut(toAccelerator(recorded))} />
          </span>
        </SettingLine>
        <SettingLine
          label="Im Hintergrund verfügbar bleiben"
          description={
            status?.enabled
              ? "Immer, solange der Punkt gezeigt wird: Schließt du das Fenster, bleiben Punkt, Tastenkürzel und „Hey NOVA“ da. Beenden über das Symbol im Infobereich oder das Menü des Punkts."
              : "Schließt du NOVAs Fenster, bleiben Tastenkürzel und „Hey NOVA“ da. Beenden über das Symbol im Infobereich."
          }
        >
          <Switch label="Im Hintergrund verfügbar bleiben" checked={(status?.background || status?.enabled) ?? false} disabled={busy || status?.enabled} onChange={(background) => update({ background })} />
        </SettingLine>
        <SettingLine label="Mit Windows starten" description="NOVA startet im Hintergrund, nur mit dem Punkt. So ist er nach jedem Neustart da.">
          <Switch label="Mit Windows starten" checked={autostart ?? false} disabled={autostart === undefined || setAutostart.isPending} onChange={(enabled) => setAutostart.mutate(enabled)} />
        </SettingLine>
      </SettingCard>

      <PrivacyNote>Der Punkt selbst benutzt nie dein Mikrofon und nimmt nie deinen Bildschirm auf. Nur „Hey NOVA“ und das Doppelklatschen hören zu, und nur, solange du sie einschaltest.</PrivacyNote>
    </SettingsSection>
  );
}

/** A small screen with its four corners to pick from. */
function CornerPicker({ value, onChange }: { value: DotCorner; onChange: (corner: DotCorner) => void }) {
  return (
    <div role="radiogroup" aria-label="Ecke des Punkts" className="relative h-[72px] w-[116px] rounded-[10px] border border-line-strong bg-black/25">
      <span aria-hidden className="absolute inset-x-0 bottom-0 h-2 rounded-b-[9px] bg-white/[0.09]" />
      {CORNERS.map((corner) => {
        const selected = corner.value === value;
        return (
          <button key={corner.value} type="button" role="radio" aria-checked={selected} aria-label={corner.label} title={corner.label} onClick={() => onChange(corner.value)} className={cn("group absolute flex size-6 items-center justify-center rounded-full", corner.at)}>
            <span className={cn("size-2.5 rounded-full transition-[background-color,box-shadow,transform] duration-200 ease-nova", selected ? "scale-110 bg-accent shadow-[0_0_0_4px_var(--nova-accent-soft)]" : "bg-white/25 group-hover:bg-white/50")} />
          </button>
        );
      })}
    </div>
  );
}

type PreviewState = "idle" | "hover" | "listening" | "thinking" | "speaking";

const PREVIEW_STATES = [
  { value: "idle", label: "Ruhe" },
  { value: "hover", label: "Zeiger" },
  { value: "listening", label: "Hört zu" },
  { value: "thinking", label: "Denkt" },
  { value: "speaking", label: "Spricht" },
] as const satisfies readonly { value: PreviewState; label: string }[];

/** How tall the stage's taskbar is (see `PreviewStage`). */
const TASKBAR = 36;

/**
 * A level that moves like a voice, for the states that follow one. The dot's ring is
 * drawn from it; with reduced motion it stays where it is.
 */
function useVoiceLikeLevel(active: boolean): number {
  const [level, setLevel] = useState(0.5);
  useEffect(() => {
    if (!active || prefersReducedMotion()) return setLevel(0.5);
    let step = 0;
    const timer = setInterval(() => {
      step += 1;
      setLevel(0.5 + 0.45 * Math.sin(step * 0.9) * Math.sin(step * 0.37));
    }, 110);
    return () => clearInterval(timer);
  }, [active]);
  return level;
}

interface DotStageProps {
  look: DotLook;
  placement: DotPlacement;
  corner: DotCorner;
  /** The dot is switched off: the stage shows where it would be. */
  off: boolean;
}

/** The real dot on a piece of desktop: where it sits, how it looks, and what it does in each state. */
function DotStage({ look, placement, corner, off }: DotStageProps) {
  const [shown, setShown] = useState<PreviewState>("idle");
  const state: AssistantState = shown === "hover" ? "idle" : shown;
  const level = useVoiceLikeLevel(state === "listening" || state === "speaking");
  const next = () => setShown((now) => PREVIEW_STATES[(PREVIEW_STATES.findIndex((option) => option.value === now) + 1) % PREVIEW_STATES.length]!.value);

  // In the taskbar: centered on it, before the clock (a dot taller than this small taskbar stands on its lower edge).
  // In a corner: the look's gap away from the edges, above the taskbar.
  const position =
    placement === "taskbar"
      ? { right: 84, bottom: Math.max(2, (TASKBAR - look.diameter) / 2) }
      : { [corner.endsWith("Left") ? "left" : "right"]: look.edgeGap, ...(corner.startsWith("top") ? { top: look.edgeGap } : { bottom: TASKBAR + look.edgeGap }) };

  // Two siblings, not one box: the stage stays in view over the cards below only as a child of the section itself.
  return (
    <>
      <PreviewStage label="Vorschau: der NOVA-Punkt auf deinem Desktop" backdrop="dusk" taskbar height={228} sticky>
        <span aria-hidden className="pointer-events-none absolute right-4 bottom-0 flex h-9 items-center text-[10px] text-white/60 tabular-nums">
          19:30
        </span>
        {/*
          `layout`: the dot glides to its new place when the placement or the corner changes.
          Switched off, only the dot fades: a see-through stage would show the cards that scroll under it.
        */}
        <motion.div layout="position" transition={{ type: "spring", stiffness: 420, damping: 34 }} className={cn("absolute flex transition-opacity duration-300", off && "opacity-40")} style={position}>
          <NovaDot look={look} open={false} state={state} level={level} hovered={shown === "hover"} actionLabel="Nächsten Zustand zeigen" onToggle={next} onMenu={() => {}} onDragStart={() => {}} />
        </motion.div>
      </PreviewStage>
      {/* What the stage shows is no setting. */}
      <div data-no-record className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SegmentedControl label="Zustand in der Vorschau" value={shown} options={PREVIEW_STATES} onChange={setShown} />
        <p className="text-[12px] text-fg-subtle">{off ? "Der Punkt ist ausgeschaltet. So sähe er aus." : "Oder klick auf den Punkt, um die Zustände durchzugehen."}</p>
      </div>
    </>
  );
}
