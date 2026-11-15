import { ListOrdered, PanelLeft, Shapes } from "lucide-react";
import { useMemo } from "react";
import { getNavItem, type RouteId } from "@/app/navigation";
import { ResetButton, SettingCard, SettingLine, SortableList } from "@/components/settings-kit";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/cn";
import { useSettings } from "@/stores/settings";
import { SettingsSection } from "./SettingsLayout";

/** Settings → Navigation: the sidebar's order, by dragging, and what it shows. */
export function NavigationSettings() {
  const navOrder = useSettings((s) => s.navOrder);
  const navHidden = useSettings((s) => s.navHidden);
  const setNavOrder = useSettings((s) => s.setNavOrder);
  const setNavHidden = useSettings((s) => s.setNavHidden);
  const resetNavigation = useSettings((s) => s.resetNavigation);
  // The same objects from render to render: the list tells its cards apart by them while one is dragged.
  const items = useMemo(() => navOrder.map((id) => ({ id })), [navOrder]);
  const studio = getNavItem("studio");
  const StudioIcon = studio.icon;

  return (
    <SettingsSection
      id="navigation"
      title="Navigation"
      description="Ordne die Seitenleiste und blende aus, was du nicht brauchst. Ausgeblendetes erreichst du weiter über die Befehlspalette (Strg+K)."
      icon={PanelLeft}
      actions={<ResetButton label="Standard wiederherstellen" confirmLabel="Wirklich zurücksetzen" onReset={resetNavigation} />}
    >
      <SettingCard title="Bereiche der Seitenleiste" description="Zieh eine Karte an ihren Platz. Mit der Tastatur: Leertaste greift, Pfeiltasten verschieben, Leertaste legt ab. Home steht immer oben." icon={ListOrdered}>
        <div data-setting="Bereiche der Seitenleiste">
          <SortableList
            label="Reihenfolge der Seitenleiste"
            items={items}
            itemLabel={(item) => getNavItem(item.id).label}
            onReorder={(next) => setNavOrder(next.map((item) => item.id))}
            renderItem={(item, index) => <NavCard id={item.id} place={index + 1} hidden={navHidden.includes(item.id)} onToggle={(visible) => setNavHidden(item.id, !visible)} />}
          />
        </div>
      </SettingCard>
      <SettingCard title="Anpassen" description="Steht in der Seitenleiste unter den Bereichen, an festem Platz." icon={Shapes}>
        <SettingLine label={studio.label} description="Wo du deine Widgets baust und anordnest.">
          <span className="flex items-center gap-3">
            <StudioIcon size={15} className={navHidden.includes("studio") ? "text-fg-subtle" : "text-accent-text"} aria-hidden />
            <Switch label={`${studio.label} in der Seitenleiste zeigen`} checked={!navHidden.includes("studio")} onChange={(visible) => setNavHidden("studio", !visible)} />
          </span>
        </SettingLine>
      </SettingCard>
    </SettingsSection>
  );
}

function NavCard({ id, place, hidden, onToggle }: { id: RouteId; place: number; hidden: boolean; onToggle: (visible: boolean) => void }) {
  const item = getNavItem(id);
  const Icon = item.icon;
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[11px] font-semibold text-fg-muted tabular-nums">{place}</span>
      <Icon size={15} className={cn("shrink-0", hidden ? "text-fg-subtle" : "text-accent-text")} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className={cn("block text-[13px] font-medium", hidden ? "text-fg-subtle" : "text-fg")}>{item.label}</span>
        {hidden && <span className="block text-[11.5px] text-fg-subtle">Ausgeblendet</span>}
      </span>
      <Switch label={`${item.label} in der Seitenleiste zeigen`} checked={!hidden} onChange={onToggle} />
    </div>
  );
}
