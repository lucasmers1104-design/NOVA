import { ArrowDown, ArrowUp, PanelLeft } from "lucide-react";
import { getNavItem, type RouteId } from "@/app/navigation";
import { Button, IconButton } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { useSettings } from "@/stores/settings";
import { SettingsSection } from "./SettingsLayout";

export function NavigationSettings() {
  const navOrder = useSettings((s) => s.navOrder);
  const navHidden = useSettings((s) => s.navHidden);
  const moveNavItem = useSettings((s) => s.moveNavItem);
  const setNavHidden = useSettings((s) => s.setNavHidden);
  const resetNavigation = useSettings((s) => s.resetNavigation);

  return (
    <SettingsSection
      id="navigation"
      title="Navigation"
      description="Order and show the sections in the sidebar. Hidden sections stay available from the command palette."
      icon={PanelLeft}
    >
      <ul aria-label="Workspace sections" className="divide-y divide-line">
        {navOrder.map((id, index) => (
          <NavRow
            key={id}
            id={id}
            hidden={navHidden.includes(id)}
            onToggle={(visible) => setNavHidden(id, !visible)}
            onMoveUp={index > 0 ? () => moveNavItem(id, -1) : undefined}
            onMoveDown={index < navOrder.length - 1 ? () => moveNavItem(id, 1) : undefined}
          />
        ))}
        <NavRow id="studio" hidden={navHidden.includes("studio")} onToggle={(visible) => setNavHidden("studio", !visible)} />
      </ul>
      <div className="flex justify-end pt-4">
        <Button size="sm" variant="ghost" onClick={resetNavigation}>
          Restore default order
        </Button>
      </div>
    </SettingsSection>
  );
}

interface NavRowProps {
  id: RouteId;
  hidden: boolean;
  onToggle: (visible: boolean) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

function NavRow({ id, hidden, onToggle, onMoveUp, onMoveDown }: NavRowProps) {
  const item = getNavItem(id);
  const Icon = item.icon;
  const reorderable = onMoveUp !== undefined || onMoveDown !== undefined;
  return (
    <li className="flex items-center gap-3 py-2.5 first:pt-0">
      <Icon size={16} className={hidden ? "text-fg-subtle" : "text-accent-text"} aria-hidden />
      <span className={hidden ? "flex-1 text-[13px] text-fg-subtle" : "flex-1 text-[13px] text-fg"}>{item.label}</span>
      {reorderable && (
        <span className="flex gap-0.5">
          <IconButton size="sm" label={`Move ${item.label} up`} disabled={!onMoveUp} onClick={onMoveUp}>
            <ArrowUp size={14} />
          </IconButton>
          <IconButton size="sm" label={`Move ${item.label} down`} disabled={!onMoveDown} onClick={onMoveDown}>
            <ArrowDown size={14} />
          </IconButton>
        </span>
      )}
      <Switch label={`Show ${item.label} in sidebar`} checked={!hidden} onChange={onToggle} />
    </li>
  );
}
