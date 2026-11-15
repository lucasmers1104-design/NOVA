import { motion } from "motion/react";
import { type ReactNode, useRef, useState } from "react";
import { cn } from "@/lib/cn";

export interface Chip<C extends string> {
  value: C;
  label: string;
  icon?: ReactNode;
}

export interface DropZone<Z extends string> {
  id: Z;
  label: string;
}

interface DragChipsProps<C extends string, Z extends string> {
  label: string;
  chips: readonly Chip<C>[];
  zones: readonly DropZone<Z>[];
  /** What lies in each zone right now. */
  assigned: Record<Z, C>;
  onAssign: (zone: Z, chip: C) => void;
  /**
   * Where a zone is on screen when it lives outside this component (e.g. on a
   * preview). The zone's own button below always counts as a target too.
   */
  zoneRect?: (zone: Z) => DOMRect | null;
  /** The zone a dragged chip is over, for highlighting it elsewhere. */
  onHoverZone?: (zone: Z | null) => void;
  disabled?: boolean;
}

function inside(rect: DOMRect | null | undefined, x: number, y: number): boolean {
  return Boolean(rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
}

/**
 * Chips to drag into zones. With the keyboard or a plain click: choose the zone
 * first (the buttons on top), then the chip that should go there.
 */
export function DragChips<C extends string, Z extends string>({ label, chips, zones, assigned, onAssign, zoneRect, onHoverZone, disabled = false }: DragChipsProps<C, Z>) {
  const [active, setActive] = useState<Z | null>(zones[0]?.id ?? null);
  const [hovered, setHovered] = useState<Z | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const zoneButtons = useRef(new Map<Z, HTMLButtonElement>());
  // A drag ends with a click on the chip; that click must not also assign it.
  const dragged = useRef(false);
  const activeZone = zones.find((zone) => zone.id === active) ?? zones[0];

  const zoneAt = (x: number, y: number): Z | null => zones.find((zone) => inside(zoneRect?.(zone.id), x, y) || inside(zoneButtons.current.get(zone.id)?.getBoundingClientRect(), x, y))?.id ?? null;

  const hover = (zone: Z | null) => {
    if (zone === hovered) return;
    setHovered(zone);
    onHoverZone?.(zone);
  };

  const assign = (zone: DropZone<Z>, chip: Chip<C>) => {
    onAssign(zone.id, chip.value);
    setActive(zone.id);
    setAnnouncement(`${chip.label}: ${zone.label}`);
  };

  return (
    <div className={cn("space-y-3", disabled && "pointer-events-none opacity-45")}>
      <div role="radiogroup" aria-label={`${label}: Ziel`} className="flex flex-wrap gap-2">
        {zones.map((zone) => {
          const chip = chips.find((c) => c.value === assigned[zone.id]);
          const selected = zone.id === activeZone?.id;
          return (
            <button
              key={zone.id}
              ref={(element) => {
                if (element) zoneButtons.current.set(zone.id, element);
                else zoneButtons.current.delete(zone.id);
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => setActive(zone.id)}
              className={cn(
                "flex h-11 min-w-32 flex-1 items-center gap-2 rounded-[14px] border border-dashed px-3 text-left transition-colors",
                hovered === zone.id ? "border-accent bg-accent/15" : selected ? "border-accent/70 bg-accent/[0.07]" : "border-line-strong hover:bg-white/[0.04]",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[10.5px] font-semibold tracking-[0.06em] text-fg-subtle uppercase">{zone.label}</span>
                <span className="flex items-center gap-1.5 truncate text-[12.5px] font-medium text-fg">
                  {chip?.icon}
                  {chip?.label ?? "—"}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
        {chips.map((chip) => {
          const placed = activeZone ? assigned[activeZone.id] === chip.value : false;
          return (
            <motion.button
              key={chip.value}
              type="button"
              aria-pressed={placed}
              aria-label={activeZone ? `${chip.label} nach ${activeZone.label}` : chip.label}
              disabled={disabled}
              drag={!disabled}
              dragSnapToOrigin
              dragElastic={0.18}
              whileDrag={{ scale: 1.08, zIndex: 20, cursor: "grabbing" }}
              whileTap={{ scale: 0.96 }}
              onDragStart={() => {
                dragged.current = true;
              }}
              onDrag={(event) => "clientX" in event && hover(zoneAt(event.clientX, event.clientY))}
              onDragEnd={(event) => {
                const zone = "clientX" in event ? zones.find((z) => z.id === zoneAt(event.clientX, event.clientY)) : undefined;
                if (zone) assign(zone, chip);
                hover(null);
                // After the click the drag's pointer-up produces.
                setTimeout(() => {
                  dragged.current = false;
                }, 0);
              }}
              onClick={() => {
                if (!dragged.current && activeZone) assign(activeZone, chip);
              }}
              className={cn(
                "relative flex h-8 cursor-grab items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition-colors",
                placed ? "border-accent bg-accent/15 text-fg" : "border-line bg-white/[0.04] text-fg-muted hover:border-line-strong hover:text-fg",
              )}
            >
              {chip.icon}
              {chip.label}
            </motion.button>
          );
        })}
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}
