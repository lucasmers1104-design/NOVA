import {
  Activity,
  AppWindow,
  AudioLines,
  Blocks,
  FolderOpen,
  LayoutDashboard,
  ListTodo,
  type LucideIcon,
  Newspaper,
  Puzzle,
  Settings,
  Sparkles,
  Workflow,
} from "lucide-react";

export type RouteId =
  | "home"
  | "system"
  | "apps"
  | "ai"
  | "productivity"
  | "routines"
  | "media"
  | "files"
  | "live"
  | "studio"
  | "plugins"
  | "settings";

export type NavGroup = "workspace" | "customize" | "footer";

export interface NavItem {
  id: RouteId;
  label: string;
  icon: LucideIcon;
  description: string;
  group: NavGroup;
}

/** Single source of truth for the sidebar, command palette and route table. */
export const NAV_ITEMS: readonly NavItem[] = [
  { id: "home", label: "Home", icon: LayoutDashboard, group: "workspace", description: "Your dashboard at a glance" },
  { id: "system", label: "System", icon: Activity, group: "workspace", description: "Live hardware and performance monitoring" },
  { id: "apps", label: "Apps", icon: AppWindow, group: "workspace", description: "Search, pin and launch applications" },
  { id: "ai", label: "NOVA AI", icon: Sparkles, group: "workspace", description: "Your multi-provider AI assistant" },
  { id: "productivity", label: "Productivity", icon: ListTodo, group: "workspace", description: "Tasks, projects, notes and calendar" },
  { id: "routines", label: "Routines", icon: Workflow, group: "workspace", description: "What NOVA does by itself and remembers" },
  { id: "media", label: "Media", icon: AudioLines, group: "workspace", description: "Control what's playing on this PC" },
  { id: "files", label: "Files", icon: FolderOpen, group: "workspace", description: "Favorite folders and quick access" },
  { id: "live", label: "Live Information", icon: Newspaper, group: "workspace", description: "Weather, news and information cards" },
  { id: "studio", label: "Widget Studio", icon: Blocks, group: "customize", description: "Build and arrange your widgets" },
  { id: "plugins", label: "Plugins", icon: Puzzle, group: "customize", description: "Install and manage extensions" },
  { id: "settings", label: "Settings", icon: Settings, group: "footer", description: "Appearance, privacy and preferences" },
];

export const NAV_GROUP_LABELS: Record<Exclude<NavGroup, "footer">, string> = {
  workspace: "Workspace",
  customize: "Customize",
};

/** Workspace sections the user may reorder (Home always stays first). */
export const WORKSPACE_ORDERABLE_ROUTES: readonly RouteId[] = NAV_ITEMS.filter(
  (item) => item.group === "workspace" && item.id !== "home",
).map((item) => item.id);

/** Sections the user may hide from the sidebar; Home and Settings are always shown. */
export const CUSTOMIZABLE_ROUTES: readonly RouteId[] = NAV_ITEMS.filter((item) => item.id !== "home" && item.id !== "settings").map(
  (item) => item.id,
);

export type SidebarGroups = Record<NavGroup, NavItem[]>;

/** Applies the user's order and visibility preferences to the sidebar. */
export function resolveSidebar(order: readonly RouteId[], hidden: readonly RouteId[]): SidebarGroups {
  const rank = (id: RouteId) => {
    const index = order.indexOf(id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  const visible = NAV_ITEMS.filter((item) => !hidden.includes(item.id) || !CUSTOMIZABLE_ROUTES.includes(item.id));
  const workspace = visible.filter((item) => item.group === "workspace");
  const home = workspace.filter((item) => item.id === "home");
  const rest = workspace.filter((item) => item.id !== "home").sort((a, b) => rank(a.id) - rank(b.id));
  return {
    workspace: [...home, ...rest],
    customize: visible.filter((item) => item.group === "customize"),
    footer: visible.filter((item) => item.group === "footer"),
  };
}

export function getNavItem(id: RouteId): NavItem {
  const item = NAV_ITEMS.find((i) => i.id === id);
  if (!item) throw new Error(`Unknown route: ${id}`);
  return item;
}
