import { Check, ChevronDown, LayoutGrid, Pencil, Plus, RotateCcw, SlidersHorizontal, Trash, Undo2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { useActiveLayout, useDashboard } from "@/features/dashboard/store";
import { LayoutNameDialog } from "./LayoutNameDialog";

export function DashboardToolbar({ onAddWidget }: { onAddWidget: () => void }) {
  const layouts = useDashboard((s) => s.layouts);
  const editing = useDashboard((s) => s.editing);
  const storageError = useDashboard((s) => s.storageError);
  const lastRemoved = useDashboard((s) => s.lastRemoved);
  const { setActive, setEditing, createLayout, renameLayout, deleteLayout, resetActiveLayout, undoRemove } = useDashboard.getState();
  const active = useActiveLayout();
  const [dialog, setDialog] = useState<"create" | "rename" | "delete" | "reset" | null>(null);

  if (!active) return null;

  const entries: MenuEntry[] = [
    ...layouts.map(
      (layout): MenuEntry => ({
        kind: "item",
        id: layout.id,
        label: layout.name,
        checked: layout.id === active.id,
        icon: layout.id === active.id ? <Check size={14} /> : null,
        onSelect: () => setActive(layout.id),
      }),
    ),
    { kind: "separator", id: "sep" },
    { kind: "item", id: "new", label: "New layout…", icon: <Plus size={14} />, onSelect: () => setDialog("create") },
    { kind: "item", id: "rename", label: `Rename “${active.name}”…`, icon: <Pencil size={14} />, onSelect: () => setDialog("rename") },
    {
      kind: "item",
      id: "delete",
      label: `Delete “${active.name}”…`,
      icon: <Trash size={14} />,
      danger: true,
      disabled: layouts.length <= 1,
      onSelect: () => setDialog("delete"),
    },
  ];

  return (
    <div className="mb-4 flex min-h-9 items-center justify-between gap-3">
      <Menu
        label="Dashboard layouts"
        entries={entries}
        trigger={(props) => (
          <button
            type="button"
            {...props}
            className="flex h-9 items-center gap-2 rounded-control px-2.5 text-[14px] font-semibold text-fg transition-colors hover:bg-white/[0.06]"
          >
            <LayoutGrid size={16} className="text-accent-text" aria-hidden />
            <span className="max-w-60 truncate">{active.name}</span>
            <ChevronDown size={15} className="text-fg-subtle" aria-hidden />
            <span className="sr-only">— switch layout</span>
          </button>
        )}
      />

      <div className="flex items-center gap-2">
        {storageError && (
          <Badge tone="warning" className="max-w-80" >
            <span className="truncate" title={storageError}>
              {storageError}
            </span>
          </Badge>
        )}
        {editing ? (
          <>
            {lastRemoved && (
              <Button size="sm" variant="ghost" icon={<Undo2 size={14} aria-hidden />} onClick={undoRemove}>
                Undo remove
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<RotateCcw size={14} aria-hidden />} onClick={() => setDialog("reset")}>
              Reset
            </Button>
            <Button size="sm" variant="secondary" icon={<Plus size={14} aria-hidden />} onClick={onAddWidget}>
              Add widget
            </Button>
            <Button size="sm" variant="primary" icon={<Check size={14} aria-hidden />} onClick={() => setEditing(false)}>
              Done
            </Button>
          </>
        ) : (
          <Button size="sm" variant="secondary" icon={<SlidersHorizontal size={14} aria-hidden />} onClick={() => setEditing(true)}>
            Customize
          </Button>
        )}
      </div>

      <LayoutNameDialog
        open={dialog === "create" || dialog === "rename"}
        mode={dialog === "rename" ? "rename" : "create"}
        initialName={dialog === "rename" ? active.name : ""}
        onClose={() => setDialog(null)}
        onSubmit={(name, template) => (dialog === "rename" ? renameLayout(active.id, name) : createLayout(name, template))}
      />
      <ConfirmDialog
        open={dialog === "delete"}
        title={`Delete “${active.name}”?`}
        description="This layout and its widget settings will be removed. Other layouts are not affected."
        confirmLabel="Delete layout"
        danger
        onConfirm={() => deleteLayout(active.id)}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === "reset"}
        title="Reset this layout?"
        description="Widgets, sizes and widget settings return to the default dashboard."
        confirmLabel="Reset layout"
        danger
        onConfirm={resetActiveLayout}
        onClose={() => setDialog(null)}
      />
    </div>
  );
}
