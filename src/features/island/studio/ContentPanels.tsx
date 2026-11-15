import { AudioLines, Bell, CircleDashed, CircleOff, Clock, Cpu, Disc3, Hourglass, LayoutPanelLeft, ListOrdered, type LucideIcon, Music, Phone, Smartphone, Sparkles } from "lucide-react";
import type { RefObject } from "react";
import { type Chip, DragChips, SegmentedControl, SettingCard, SettingLine, SortableList } from "@/components/settings-kit";
import { Switch } from "@/components/ui/Switch";
import { normalizeOrder, slotSupported } from "../priority";
import type { IslandPrefs, ModuleKey, SlotItem, SlotState } from "../types";
import type { UpdatePrefs } from "./useStudioPrefs";

// ---------------------------------------------------------------------------
// Side slots of the closed pill
// ---------------------------------------------------------------------------

export const SLOT_STATES = [
  { value: "music", label: "Musik" },
  { value: "call", label: "Anruf" },
  { value: "ai", label: "KI" },
  { value: "notification", label: "Benachrichtigung" },
  { value: "system", label: "System" },
] as const satisfies readonly { value: SlotState; label: string }[];

const SLOT_CHIPS: readonly (Chip<SlotItem> & { glyph: LucideIcon })[] = [
  { value: "cover", label: "Cover", glyph: Disc3 },
  { value: "visualizer", label: "Visualizer", glyph: AudioLines },
  { value: "appIcon", label: "App-Icon", glyph: Smartphone },
  { value: "clock", label: "Uhrzeit", glyph: Clock },
  { value: "remaining", label: "Restzeit", glyph: Hourglass },
  { value: "progress", label: "Fortschrittsring", glyph: CircleDashed },
  { value: "aiStatus", label: "KI-Status", glyph: Sparkles },
  { value: "none", label: "Nichts", glyph: CircleOff },
];

const ZONES = [
  { id: "left", label: "Links" },
  { id: "right", label: "Rechts" },
] as const;

interface SlotEditorProps {
  prefs: IslandPrefs;
  update: UpdatePrefs;
  /** The state whose slots are being set; the stage shows that state. */
  state: SlotState;
  onState: (state: SlotState) => void;
  /** The pill on the stage: its left and right part are the drop zones. */
  pillRef: RefObject<HTMLDivElement | null>;
  onHint: (side: "left" | "right" | null) => void;
}

/** How much of the pill's width counts as its left or right slot when a chip is dropped on it. */
const ZONE_SHARE = 0.42;

export function SlotEditor({ prefs, update, state, onState, pillRef, onHint }: SlotEditorProps) {
  const chips = SLOT_CHIPS.filter((chip) => slotSupported(chip.value, state)).map(({ glyph: Glyph, ...chip }) => ({ ...chip, icon: <Glyph size={13} aria-hidden /> }));
  const zoneRect = (side: "left" | "right") => {
    const rect = pillRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const width = rect.width * ZONE_SHARE;
    return new DOMRect(side === "left" ? rect.left : rect.right - width, rect.top - 8, width, rect.height + 16);
  };
  return (
    <SettingCard title="Seitenslots" description="Was die geschlossene Pille links und rechts trägt. Jeder Zustand hat seine eigenen." icon={LayoutPanelLeft}>
      <div className="pb-3.5">
        <SegmentedControl label="Zustand, dessen Slots du belegst" value={state} options={SLOT_STATES} onChange={onState} />
      </div>
      <div data-setting="Seitenslots" className="pt-3.5">
        <DragChips
          label="Inhalte für die Seitenslots"
          chips={chips}
          zones={ZONES}
          assigned={prefs.slots[state]}
          zoneRect={zoneRect}
          onHoverZone={onHint}
          onAssign={(side, item) => update((now) => ({ ...now, slots: { ...now.slots, [state]: { ...now.slots[state], [side]: item } } }), `slots.${state}.${side}`)}
        />
        <p className="mt-3 text-[12px] leading-relaxed text-fg-muted">Zieh einen Inhalt auf die linke oder rechte Seite der Island in der Bühne. Oder wähl erst die Seite, dann den Inhalt.</p>
      </div>
    </SettingCard>
  );
}

// ---------------------------------------------------------------------------
// Module priority
// ---------------------------------------------------------------------------

const MODULES: Record<ModuleKey, { label: string; description: string; icon: LucideIcon }> = {
  calls: { label: "Anrufe", description: "Ein klingelndes Handy lässt die Island wachsen. Annehmen und Ablehnen gibt es nur, wenn dein Handy das wirklich kann.", icon: Phone },
  ai: { label: "NOVA AI", description: "Was NOVA gerade tut, der laufende Schritt und der Anfang der Antwort.", icon: Sparkles },
  notifications: { label: "Benachrichtigungen", description: "WhatsApp und jede andere App deines Handys, über NOVA Companion.", icon: Bell },
  music: { label: "Musik", description: "Was in Spotify, im Browser oder einem anderen Player läuft: Cover, Steuerung, Visualizer und Songtext.", icon: Music },
  system: { label: "System", description: "CPU, Grafikkarte, Arbeitsspeicher, Temperatur und Netzwerk. Fragt alle 2 Sekunden ab, solange es an ist.", icon: Cpu },
};

export function ModuleOrder({ prefs, update }: { prefs: IslandPrefs; update: UpdatePrefs }) {
  const order = normalizeOrder(prefs.order);
  const active = order.filter((key) => prefs.modules[key]).map((id) => ({ id }));
  const off = order.filter((key) => !prefs.modules[key]);
  const setModule = (key: ModuleKey, on: boolean) => update((now) => ({ ...now, modules: { ...now.modules, [key]: on } }), `modules.${key}`);
  return (
    <SettingCard title="Module und Priorität" description="Höchstens zwei Dinge gleichzeitig. Wer weiter oben steht, führt." icon={ListOrdered}>
      <SettingLine label="Anrufe zuerst" description="Ein Anruf führt immer, wo auch immer er in der Liste steht, und ein klingelnder steht allein.">
        <Switch label="Anrufe zuerst" checked={prefs.callsFirst} onChange={(callsFirst) => update((now) => ({ ...now, callsFirst }), "callsFirst")} />
      </SettingLine>
      <div data-setting="Reihenfolge der Module" className="py-3.5">
        {active.length === 0 ? (
          <p className="rounded-[14px] border border-dashed border-line-strong px-3 py-4 text-center text-[12.5px] text-fg-muted">Alle Module sind aus. Die Island zeigt nur sich selbst.</p>
        ) : (
          <SortableList
            label="Reihenfolge der Module"
            items={active}
            itemLabel={(item) => MODULES[item.id].label}
            // The modules that are off keep their places behind the active ones.
            onReorder={(next) => update((now) => ({ ...now, order: [...next.map((item) => item.id), ...normalizeOrder(now.order).filter((key) => !now.modules[key])] }), "order")}
            onDropOutside={(item) => setModule(item.id, false)}
            renderItem={(item, index) => {
              const { label, description, icon: Icon } = MODULES[item.id];
              return (
                <div className="flex items-center gap-2.5">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[11px] font-semibold text-fg-muted tabular-nums">{index + 1}</span>
                  <Icon size={15} className="shrink-0 text-accent-text" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-fg">{label}</span>
                    <span className="block truncate text-[11.5px] text-fg-subtle" title={description}>
                      {description}
                    </span>
                  </span>
                  <Switch label={`${label} anzeigen`} checked onChange={() => setModule(item.id, false)} />
                </div>
              );
            }}
          />
        )}
      </div>
      <div className="pt-3.5">
        <p className="text-[10.5px] font-semibold tracking-[0.08em] text-fg-subtle uppercase">Aus</p>
        <ul aria-label="Ausgeschaltete Module" className="mt-2 flex min-h-11 flex-wrap items-center gap-1.5 rounded-[14px] border border-dashed border-line-strong p-2">
          {off.length === 0 && <li className="px-1 text-[12px] text-fg-subtle">Zieh eine Karte hierher, um das Modul auszuschalten.</li>}
          {off.map((key) => {
            const { label, icon: Icon } = MODULES[key];
            return (
              <li key={key}>
                <button
                  type="button"
                  aria-label={`${label} einschalten`}
                  title="Einschalten"
                  onClick={() => setModule(key, true)}
                  className="flex h-7 items-center gap-1.5 rounded-full border border-line bg-white/[0.03] px-2.5 text-[12px] font-medium text-fg-muted transition-colors hover:border-line-strong hover:text-fg"
                >
                  <Icon size={12} aria-hidden /> {label}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </SettingCard>
  );
}
