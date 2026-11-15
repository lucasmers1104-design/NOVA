import "../island.css";
import { PanelTop, Redo2, Undo2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { ResetButton } from "@/components/settings-kit";
import { IconButton } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/cn";
import { DEFAULT_ISLAND_PREFS, type IslandPrefs, type SlotState } from "../types";
import { ModuleOrder, SlotEditor } from "./ContentPanels";
import { BehaviorCard, FormCard, MaterialCard, MotionCard } from "./LookPanels";
import { Presets } from "./Presets";
import { type Playing, Stage, type StageScene } from "./Stage";
import { useStudioPrefs } from "./useStudioPrefs";

/** The stage's scene that shows a state's closed pill, for setting its slots. */
const STATE_SCENE: Record<SlotState, StageScene> = { music: "music", call: "call", ai: "aiThinking", notification: "notification", system: "system" };
const SCENE_STATE: Partial<Record<StageScene, SlotState>> = { music: "music", lyrics: "music", live: "music", ringing: "call", call: "call", aiThinking: "ai", aiReply: "ai", notification: "notification", system: "system" };

/** Everything back to how NOVA ships it; what the user made or chose for this PC stays. */
function reset(prefs: IslandPrefs): IslandPrefs {
  return { ...DEFAULT_ISLAND_PREFS, enabled: prefs.enabled, monitor: prefs.monitor, presets: prefs.presets };
}

/**
 * The NOVA Island tab: Island Studio. A live stage with the real island on top,
 * everything about it to grab below. Changes show at once and are saved a moment later.
 */
export function IslandStudio() {
  const { prefs, status, desktop, update, undo, redo, canUndo, canRedo } = useStudioPrefs();
  const [playing, setPlaying] = useState<Playing>({ id: "music", startedAt: Date.now() });
  const [slotState, setSlotState] = useState<SlotState>("music");
  const [slotHint, setSlotHint] = useState<"left" | "right" | null>(null);
  const pill = useRef<HTMLDivElement>(null);

  const play = useCallback((id: StageScene) => {
    setPlaying({ id, startedAt: Date.now() });
    // The slot editor follows the stage, so its chips always belong to what is on it.
    const state = SCENE_STATE[id];
    if (state) setSlotState(state);
  }, []);

  if (!prefs) {
    return (
      <section aria-busy className="glass rounded-widget p-6">
        <p className="text-[13px] text-fg-muted">Nova Island wird geladen …</p>
      </section>
    );
  }

  const off = !prefs.enabled;
  return (
    <section id="settings-island" aria-labelledby="settings-island-title" className="space-y-4">
      <header className="glass flex items-center gap-3 rounded-widget px-5 py-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-line bg-white/[0.04] text-accent-text">
          <PanelTop size={17} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="settings-island-title" className="text-[15px] font-semibold text-fg">
            Island Studio
          </h2>
          <p className="mt-0.5 text-[12.5px] text-fg-muted">
            {desktop ? "Zieh, klick und probier aus: Die Bühne zeigt die echte Island, jede Änderung sofort." : "Vorschau im Browser: Alles lässt sich ausprobieren, gespeichert wird nur in der NOVA-Desktop-App."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton label="Rückgängig (Strg+Z)" size="sm" disabled={!canUndo} onClick={undo}>
            <Undo2 size={14} aria-hidden />
          </IconButton>
          <IconButton label="Wiederholen (Strg+Y)" size="sm" disabled={!canRedo} onClick={redo}>
            <Redo2 size={14} aria-hidden />
          </IconButton>
          <ResetButton label="Auf Standard zurücksetzen" onReset={() => update(reset)} />
        </div>
        <div data-setting="Nova Island anzeigen" className="flex shrink-0 items-center gap-2.5 border-l border-line pl-4 text-[12.5px] text-fg">
          Nova Island anzeigen
          <Switch label="Nova Island anzeigen" checked={prefs.enabled} onChange={(enabled) => update((now) => ({ ...now, enabled }), "enabled")} />
        </div>
      </header>

      <Stage prefs={prefs} update={update} playing={playing} onScene={play} pillRef={pill} slotHint={slotHint} desktop={desktop} />

      <div className={cn("grid grid-cols-1 items-start gap-4 min-[1180px]:grid-cols-2", off && "opacity-60")}>
        <div className="space-y-4">
          <Presets prefs={prefs} update={update} />
          <SlotEditor
            prefs={prefs}
            update={update}
            state={slotState}
            pillRef={pill}
            onHint={setSlotHint}
            onState={(state) => {
              setSlotState(state);
              setPlaying({ id: STATE_SCENE[state], startedAt: Date.now(), closed: true });
            }}
          />
          <ModuleOrder prefs={prefs} update={update} />
        </div>
        <div className="space-y-4">
          <FormCard prefs={prefs} update={update} />
          <MaterialCard prefs={prefs} update={update} />
          <MotionCard prefs={prefs} update={update} />
          <BehaviorCard prefs={prefs} update={update} monitors={status?.monitors ?? []} />
        </div>
      </div>
    </section>
  );
}
