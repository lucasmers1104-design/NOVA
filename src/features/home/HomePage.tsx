import { LayoutGrid, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Page } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { useActiveLayout, useDashboard } from "@/features/dashboard/store";
import { AddWidgetDialog } from "./AddWidgetDialog";
import { DashboardGrid } from "./DashboardGrid";
import { DashboardToolbar } from "./DashboardToolbar";
import { WidgetSettingsDialog } from "./WidgetSettingsDialog";

export default function HomePage() {
  const layout = useActiveLayout();
  const editing = useDashboard((s) => s.editing);
  const setEditing = useDashboard((s) => s.setEditing);
  const [addOpen, setAddOpen] = useState(false);
  const [configuring, setConfiguring] = useState<string | null>(null);

  // Customize mode belongs to this page; leaving Home ends it.
  useEffect(() => () => setEditing(false), [setEditing]);

  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setEditing(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing, setEditing]);

  const revealWidget = (instanceId: string) => {
    requestAnimationFrame(() => {
      document.querySelector(`[data-instance="${instanceId}"]`)?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    });
  };

  if (!layout) {
    return (
      <Page>
        <Skeleton className="h-64 rounded-widget" />
      </Page>
    );
  }

  return (
    <Page>
      <DashboardToolbar onAddWidget={() => setAddOpen(true)} />
      {editing && (
        <p className="-mt-2 mb-4 text-[12px] text-fg-subtle">
          Drag widgets to rearrange and drag a corner to resize. With the keyboard: arrow keys move, Shift + arrows resize. Press Esc when you're done.
        </p>
      )}

      {layout.widgets.length === 0 ? (
        <div className="glass flex flex-col items-center justify-center gap-3 rounded-widget px-6 py-20 text-center">
          <span className="flex size-12 items-center justify-center rounded-[14px] border border-line bg-white/[0.04] text-accent-text">
            <LayoutGrid size={22} aria-hidden />
          </span>
          <p className="text-[15px] font-medium text-fg">“{layout.name}” is empty</p>
          <p className="max-w-sm text-[13px] text-fg-muted">Add widgets to build a dashboard for this moment.</p>
          <Button variant="primary" size="sm" icon={<Plus size={14} aria-hidden />} onClick={() => setAddOpen(true)} className="mt-2">
            Add widget
          </Button>
        </div>
      ) : (
        <DashboardGrid widgets={layout.widgets} editing={editing} onConfigure={setConfiguring} />
      )}

      <AddWidgetDialog open={addOpen} onClose={() => setAddOpen(false)} onAdded={revealWidget} />
      <WidgetSettingsDialog instanceId={configuring} onClose={() => setConfiguring(null)} />
    </Page>
  );
}
