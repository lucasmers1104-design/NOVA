import { Plus } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { useActiveLayout, useDashboard } from "@/features/dashboard/store";
import { MAX_WIDGETS_PER_LAYOUT } from "@/features/dashboard/layouts";
import { allWidgets } from "@/widgets/registry";
import type { WidgetDataSource } from "@/widgets/types";

const SOURCE_LABEL: Record<WidgetDataSource, string> = {
  local: "Local only",
  system: "System data",
  network: "Uses internet",
};

interface AddWidgetDialogProps {
  open: boolean;
  onClose: () => void;
  onAdded: (instanceId: string) => void;
}

export function AddWidgetDialog({ open, onClose, onAdded }: AddWidgetDialogProps) {
  const layout = useActiveLayout();
  const addWidget = useDashboard((s) => s.addWidget);
  const full = (layout?.widgets.length ?? 0) >= MAX_WIDGETS_PER_LAYOUT;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Add a widget"
      description={full ? `This layout has reached ${MAX_WIDGETS_PER_LAYOUT} widgets.` : "Widgets are added to the end of your layout."}
    >
      <ul className="grid grid-cols-2 gap-2.5">
        {allWidgets().map((widget) => {
          const count = layout?.widgets.filter((w) => w.widgetId === widget.id).length ?? 0;
          const Icon = widget.icon;
          return (
            <li key={widget.id}>
              <button
                type="button"
                disabled={full}
                onClick={() => {
                  const id = addWidget(widget.id);
                  if (id) onAdded(id);
                  onClose();
                }}
                className="group flex h-full w-full items-start gap-3 rounded-[14px] border border-line bg-white/[0.03] p-3.5 text-left transition-colors hover:border-accent/40 hover:bg-white/[0.06] disabled:opacity-40"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-[11px] border border-line bg-white/[0.05] text-accent-text">
                  <Icon size={19} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-medium text-fg">{widget.name}</span>
                  <span className="mt-0.5 block text-[12px] leading-snug text-fg-muted">{widget.description}</span>
                  <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] whitespace-nowrap text-fg-subtle tabular-nums">
                    <span>
                      {widget.defaultSize.w} × {widget.defaultSize.h}
                    </span>
                    <span>{SOURCE_LABEL[widget.dataSource]}</span>
                    {count > 0 && <span className="text-accent-text">On dashboard{count > 1 ? ` ×${count}` : ""}</span>}
                  </span>
                </span>
                <Plus size={16} className="mt-0.5 shrink-0 text-fg-subtle transition-colors group-hover:text-accent-text" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
