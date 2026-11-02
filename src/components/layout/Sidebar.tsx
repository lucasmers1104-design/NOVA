import { Check, Layers, PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import { motion } from "motion/react";
import { useMemo } from "react";
import { NAV_GROUP_LABELS, type NavItem, resolveSidebar } from "@/app/navigation";
import { NovaMark } from "@/components/brand/NovaMark";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { useProfiles } from "@/features/profiles/store";
import { useProfile } from "@/features/profile/useProfile";
import { cn } from "@/lib/cn";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";

const SIDEBAR_WIDTH = { expanded: 248, collapsed: 76 } as const;

const GROUPS = ["workspace", "customize"] as const;

export function Sidebar() {
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const toggleSidebar = useSettings((s) => s.toggleSidebar);
  const route = useUi((s) => s.route);
  const navigate = useUi((s) => s.navigate);
  const profile = useProfile();
  const navOrder = useSettings((s) => s.navOrder);
  const navHidden = useSettings((s) => s.navHidden);
  const groups = useMemo(() => resolveSidebar(navOrder, navHidden), [navOrder, navHidden]);
  const profiles = useProfiles((s) => s.profiles);
  const activeProfileId = useProfiles((s) => s.activeId);
  const applyProfile = useProfiles((s) => s.apply);
  const activeProfile = profiles.find((p) => p.id === activeProfileId);
  const profileEntries: MenuEntry[] = [
    ...profiles.map(
      (p): MenuEntry => ({
        kind: "item",
        id: p.id,
        label: p.name,
        checked: p.id === activeProfileId,
        icon: p.id === activeProfileId ? <Check size={14} /> : null,
        onSelect: () => applyProfile(p.id),
      }),
    ),
    { kind: "separator", id: "sep" },
    { kind: "item", id: "manage", label: "Manage profiles…", icon: <Layers size={14} />, onSelect: () => navigate("settings") },
    { kind: "item", id: "settings", label: "Settings", icon: <Settings size={14} />, onSelect: () => navigate("settings") },
  ];

  return (
    <motion.aside
      aria-label="Primary"
      data-collapsed={collapsed}
      initial={false}
      animate={{ width: collapsed ? SIDEBAR_WIDTH.collapsed : SIDEBAR_WIDTH.expanded }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="glass relative z-20 my-2.5 ml-2.5 flex h-[calc(100%-20px)] shrink-0 flex-col rounded-[24px]"
    >
      <div data-tauri-drag-region className="flex h-16 shrink-0 items-center gap-3 overflow-hidden pl-[22px]">
        <NovaMark size={32} />
        <div data-tauri-drag-region aria-hidden={collapsed} className={cn("min-w-0 transition-opacity duration-200", collapsed && "opacity-0")}>
          <p data-tauri-drag-region className="text-[15px] leading-none font-semibold tracking-[0.18em] text-fg">
            NOVA
          </p>
          <p data-tauri-drag-region className="mt-1 text-[11px] leading-none whitespace-nowrap text-fg-subtle">
            Command Center
          </p>
        </div>
      </div>

      <nav aria-label="Sections" className={cn("flex-1 px-3 pt-2", collapsed ? "overflow-visible" : "overflow-x-hidden overflow-y-auto")}>
        {GROUPS.filter((group) => groups[group].length > 0).map((group) => (
          <div key={group} className="mb-3">
            <div className="flex h-7 items-center px-[17px]">
              {collapsed ? (
                <span aria-hidden className="h-px w-[18px] bg-line" />
              ) : (
                <span className="text-[11px] font-semibold tracking-wider whitespace-nowrap text-fg-subtle uppercase">{NAV_GROUP_LABELS[group]}</span>
              )}
            </div>
            <ul className="space-y-0.5">
              {groups[group].map((item) => (
                <li key={item.id}>
                  <NavButton item={item} active={route === item.id} collapsed={collapsed} onSelect={navigate} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="shrink-0 space-y-1 border-t border-white/[0.06] px-3 pt-3 pb-3">
        {groups.footer.map((item) => (
          <NavButton key={item.id} item={item} active={route === item.id} collapsed={collapsed} onSelect={navigate} />
        ))}

        <div className={cn("flex items-center gap-1", collapsed && "flex-col")}>
          <Menu
            label="Workspace profiles"
            side="top"
            entries={profileEntries}
            trigger={(menuProps) => (
          <button
            type="button"
            {...menuProps}
            aria-label={`Profile: ${profile.fullName ?? "Local user"}${activeProfile ? `, ${activeProfile.name} workspace` : ""}`}
            title={collapsed ? (profile.fullName ?? "Local user") : undefined}
            className={cn(
              "flex h-12 min-w-0 items-center gap-3 rounded-control text-left transition-colors hover:bg-white/[0.05]",
              collapsed ? "w-[52px] justify-center" : "flex-1 pl-[11px]",
            )}
          >
            <span className="accent-gradient flex size-[30px] shrink-0 items-center justify-center rounded-full text-[12px] font-semibold text-on-accent">
              {profile.initials}
            </span>
            {/* Removed from layout when collapsed: an invisible label would widen the button and push the avatar off-center. */}
            <span className={cn("min-w-0", collapsed && "hidden")}>
              <span className="block truncate text-[13px] font-medium text-fg">{profile.fullName ?? "Local user"}</span>
              <span className="block truncate text-[11px] text-fg-subtle">{activeProfile ? `${activeProfile.name} workspace` : "Local profile"}</span>
            </span>
          </button>
            )}
          />
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={`${collapsed ? "Expand" : "Collapse"} sidebar (Ctrl+B)`}
            className="flex size-9 shrink-0 items-center justify-center rounded-control text-fg-subtle transition-colors hover:bg-white/[0.07] hover:text-fg"
          >
            {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
        </div>
      </div>
    </motion.aside>
  );
}

interface NavButtonProps {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onSelect: (id: NavItem["id"]) => void;
}

function NavButton({ item, active, collapsed, onSelect }: NavButtonProps) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      aria-current={active ? "page" : undefined}
      aria-label={item.label}
      className={cn(
        "group relative flex h-10 w-full items-center gap-3 rounded-control pl-[17px] text-[13.5px] font-medium transition-colors duration-200",
        active ? "text-fg" : "text-fg-muted hover:bg-white/[0.04] hover:text-fg",
      )}
    >
      {active && (
        <>
          <motion.span
            layoutId="nav-active-surface"
            className="glass-pill absolute inset-0 rounded-[12px]"
            transition={{ type: "spring", stiffness: 520, damping: 42 }}
          />
          <motion.span
            layoutId="nav-active-bar"
            className="absolute top-2.5 bottom-2.5 left-0 w-[3px] rounded-full bg-accent shadow-[0_0_12px_var(--nova-accent-glow)]"
            transition={{ type: "spring", stiffness: 520, damping: 42 }}
          />
        </>
      )}
      <Icon
        size={18}
        strokeWidth={active ? 2.1 : 1.8}
        aria-hidden
        className={cn("relative shrink-0 transition-colors", active ? "text-accent-text" : "text-fg-subtle group-hover:text-fg-muted")}
      />
      <span aria-hidden={collapsed} className={cn("relative truncate transition-opacity duration-200", collapsed && "opacity-0")}>
        {item.label}
      </span>
      {collapsed && (
        <span
          role="tooltip"
          className="glass-strong pointer-events-none absolute left-full z-50 ml-3 rounded-[8px] px-2.5 py-1.5 text-[12px] whitespace-nowrap text-fg opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          {item.label}
        </span>
      )}
    </button>
  );
}
