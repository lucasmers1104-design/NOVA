import { GripVertical } from "lucide-react";
import { Reorder } from "motion/react";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { cn } from "@/lib/cn";

export interface SortableItem {
  id: string;
}

interface SortableListProps<T extends SortableItem> {
  label: string;
  items: readonly T[];
  /** How an item is called when its place is announced. */
  itemLabel: (item: T) => string;
  onReorder: (items: T[]) => void;
  renderItem: (item: T, index: number) => ReactNode;
  /** A card was dragged out of the list and let go there. */
  onDropOutside?: (item: T) => void;
  disabled?: boolean;
}

/** How far outside the list (px) a card must be let go to count as dragged out. */
const OUTSIDE = 28;

/**
 * Cards in an order the user sets by dragging. With the keyboard: Space picks a card
 * up, the arrow keys move it, Space puts it down, Escape puts it back where it was.
 */
export function SortableList<T extends SortableItem>({ label, items, itemLabel, onReorder, renderItem, onDropOutside, disabled = false }: SortableListProps<T>) {
  const list = useRef<HTMLUListElement>(null);
  const [grabbed, setGrabbed] = useState<{ id: string; before: readonly T[] } | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const move = (item: T, by: number) => {
    const from = items.findIndex((other) => other.id === item.id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= items.length) return;
    const next = [...items];
    next.splice(to, 0, ...next.splice(from, 1));
    onReorder(next);
    setAnnouncement(`${itemLabel(item)}: Platz ${to + 1} von ${items.length}`);
  };

  const onKeyDown = (event: KeyboardEvent, item: T) => {
    const held = grabbed?.id === item.id;
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      setGrabbed(held ? null : { id: item.id, before: items });
      setAnnouncement(held ? `${itemLabel(item)} abgelegt` : `${itemLabel(item)} aufgenommen. Mit den Pfeiltasten verschieben, mit der Leertaste ablegen.`);
    } else if (held && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      move(item, event.key === "ArrowUp" ? -1 : 1);
    } else if (grabbed && held && event.key === "Escape") {
      event.preventDefault();
      onReorder([...grabbed.before]);
      setGrabbed(null);
      setAnnouncement(`${itemLabel(item)} zurückgelegt`);
    }
  };

  return (
    <>
      <Reorder.Group as="ul" ref={list} axis="y" values={items as T[]} onReorder={onReorder} aria-label={label} className={cn("space-y-1.5", disabled && "pointer-events-none opacity-45")}>
        {items.map((item, index) => {
          const held = grabbed?.id === item.id;
          return (
            <Reorder.Item
              key={item.id}
              value={item}
              drag={disabled ? false : "y"}
              whileDrag={{ scale: 1.02, boxShadow: "0 18px 40px -16px rgb(0 0 0 / 0.75)" }}
              transition={{ type: "spring", stiffness: 520, damping: 40 }}
              onDragEnd={(event) => {
                const rect = list.current?.getBoundingClientRect();
                if (!rect || !onDropOutside || !("clientY" in event)) return;
                const { clientX: x, clientY: y } = event;
                if (y > rect.bottom + OUTSIDE || y < rect.top - OUTSIDE || x < rect.left - OUTSIDE || x > rect.right + OUTSIDE) onDropOutside(item);
              }}
              className={cn(
                "flex items-center gap-2 rounded-[14px] border bg-[#141926] px-2 py-2 transition-colors",
                held ? "border-accent" : "border-line hover:border-line-strong",
              )}
            >
              <button
                type="button"
                aria-label={`${itemLabel(item)} verschieben`}
                aria-pressed={held}
                disabled={disabled}
                onKeyDown={(event) => onKeyDown(event, item)}
                onBlur={() => held && setGrabbed(null)}
                className={cn("flex size-7 shrink-0 cursor-grab items-center justify-center rounded-[8px] transition-colors active:cursor-grabbing", held ? "bg-accent/20 text-accent-text" : "text-fg-subtle hover:bg-white/[0.06] hover:text-fg")}
              >
                <GripVertical size={14} aria-hidden />
              </button>
              <div className="min-w-0 flex-1">{renderItem(item, index)}</div>
            </Reorder.Item>
          );
        })}
      </Reorder.Group>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
