import { AppWindow, Blocks, Compass, RefreshCw, CircleCheck, LayoutGrid, Layers, ListTodo, type LucideIcon, PanelLeft, Palette, SlidersHorizontal, Sparkles, Wallpaper } from "lucide-react";
import { queryClient } from "@/app/queryClient";
import { type AppEntry, appKeys, useAppPreferences } from "@/features/apps/api";
import { notify, notifyError } from "@/features/notifications/store";
import { useProductivity } from "@/features/productivity/store";
import { PROFILE_ICONS, useProfiles } from "@/features/profiles/store";
import { useTour } from "@/features/tour/store";
import { useUpdates } from "@/features/updates/store";
import { callNative, isDesktop as isDesktopRuntime } from "@/lib/native";
import { allWidgets } from "@/widgets/registry";
import { NAV_ITEMS } from "@/app/navigation";
import { shortcutKeys } from "@/app/shortcuts";
import { ACCENT_PRESETS, resolveAccentColor } from "@/design/accent";
import { useDashboard } from "@/features/dashboard/store";
import { isDesktop } from "@/lib/native";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";

export type CommandGroup = "Navigate" | "Dashboard" | "Profiles" | "Layout" | "Appearance" | "Apps" | "Tasks" | "Widgets";

export interface Command {
  id: string;
  title: string;
  subtitle?: string;
  group: CommandGroup;
  icon: LucideIcon;
  keywords?: readonly string[];
  shortcut?: readonly string[];
  /** Only listed once the user types (large dynamic sources such as apps). */
  searchOnly?: boolean;
  run: () => void;
}

/**
 * Central command registry. Built when the palette opens so titles reflect
 * current state ("Collapse" vs "Expand"). Commands only call typed store
 * actions — nothing here executes arbitrary input.
 */
export function buildCommands(): Command[] {
  const settings = useSettings.getState();

  const navigation: Command[] = NAV_ITEMS.map((item) => ({
    id: `navigate.${item.id}`,
    title: `Go to ${item.label}`,
    subtitle: item.description,
    group: "Navigate",
    icon: item.icon,
    keywords: [item.label, item.id],
    shortcut: item.id === "settings" ? shortcutKeys("settings") : undefined,
    run: () => useUi.getState().navigate(item.id),
  }));

  const dashboard = useDashboard.getState();
  const dashboardCommands: Command[] = [
    {
      id: "dashboard.customize",
      title: "Customize dashboard",
      subtitle: "Add, move, resize and configure widgets",
      group: "Dashboard",
      icon: SlidersHorizontal,
      keywords: ["edit", "widgets", "arrange", "layout"],
      run: () => {
        useUi.getState().navigate("home");
        useDashboard.getState().setEditing(true);
      },
    },
    ...dashboard.layouts
      .filter((l) => l.id !== dashboard.activeId)
      .map(
        (l): Command => ({
          id: `dashboard.layout.${l.id}`,
          title: `Switch layout: ${l.name}`,
          group: "Dashboard",
          icon: LayoutGrid,
          keywords: ["dashboard", "profile", "layout"],
          run: () => {
            useDashboard.getState().setActive(l.id);
            useUi.getState().navigate("home");
          },
        }),
      ),
  ];

  const layout: Command[] = [
    {
      id: "layout.toggle-sidebar",
      title: settings.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar",
      group: "Layout",
      icon: PanelLeft,
      keywords: ["navigation", "panel", "menu"],
      shortcut: shortcutKeys("sidebar"),
      run: () => useSettings.getState().toggleSidebar(),
    },
  ];

  const appearance: Command[] = [
    {
      id: "appearance.toggle-transparency",
      title: settings.transparency ? "Turn off transparency effects" : "Turn on transparency effects",
      subtitle: "Frosted glass surfaces",
      group: "Appearance",
      icon: Layers,
      keywords: ["glass", "blur", "performance", "opaque"],
      run: () => useSettings.getState().setTransparency(!useSettings.getState().transparency),
    },
    ...(isDesktop()
      ? [
          {
            id: "appearance.accent.wallpaper",
            title: "Accent: Match wallpaper",
            subtitle: "Follow your desktop wallpaper's dominant color",
            group: "Appearance",
            icon: Wallpaper,
            keywords: ["color", "theme", "accent", "adaptive", "automatic", "background"],
            run: () => {
              const current = useSettings.getState().accent;
              useSettings.getState().setAccent({ kind: "wallpaper", color: resolveAccentColor(current) });
            },
          } satisfies Command,
        ]
      : []),
    ...ACCENT_PRESETS.map(
      (preset): Command => ({
        id: `appearance.accent.${preset.id}`,
        title: `Accent: ${preset.name}`,
        group: "Appearance",
        icon: Palette,
        keywords: ["color", "theme", "accent"],
        run: () => useSettings.getState().setAccent({ kind: "preset", id: preset.id }),
      }),
    ),
  ];

  const profiles: Command[] = useProfiles.getState().profiles.map((p) => ({
    id: `profile.${p.id}`,
    title: `Switch profile: ${p.name}`,
    group: "Profiles",
    icon: PROFILE_ICONS[p.kind],
    keywords: ["workspace", "profile", "mode"],
    run: () => useProfiles.getState().apply(p.id),
  }));

  const apps: Command[] = (queryClient.getQueryData<AppEntry[]>(appKeys.list) ?? []).map((app) => ({
    id: `app.${app.id}`,
    title: `Open ${app.name}`,
    subtitle: app.category,
    group: "Apps",
    icon: AppWindow,
    keywords: [app.name],
    searchOnly: true,
    run: () => {
      useAppPreferences.getState().recordLaunch(app.id);
      callNative("app_launch", { id: app.id }).then(
        () => notify(`Opening ${app.name}`, { kind: "success" }),
        (error) => notifyError(`Couldn't open ${app.name}`, error),
      );
    },
  }));

  const tasks: Command[] = useProductivity
    .getState()
    .tasks.filter((t) => t.completedAt === null)
    .map((task) => ({
      id: `task.${task.id}`,
      title: `Complete: ${task.title}`,
      subtitle: task.dueDate ? `Due ${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ""}` : "Open task",
      group: "Tasks",
      icon: CircleCheck,
      keywords: ["task", "todo", task.title],
      searchOnly: true,
      run: () => {
        useProductivity.getState().toggleTask(task.id);
        notify(`Completed “${task.title}”`, { kind: "success" });
      },
    }));

  const widgets: Command[] = allWidgets().map((widget) => ({
    id: `widget.${widget.id}`,
    title: `Add widget: ${widget.name}`,
    subtitle: widget.description,
    group: "Widgets",
    icon: Blocks,
    keywords: ["widget", "dashboard", widget.name],
    searchOnly: true,
    run: () => {
      if (useDashboard.getState().addWidget(widget.id)) {
        useUi.getState().navigate("home");
        notify(`${widget.name} added to your dashboard`, { kind: "success" });
      }
    },
  }));

  const maintenance: Command[] = isDesktopRuntime()
    ? [
        {
          id: "assistant.toggle",
          title: "Talk to NOVA AI",
          subtitle: "Open the floating assistant",
          group: "Layout",
          icon: Sparkles,
          keywords: ["assistant", "ai", "dot", "nova", "chat", "help"],
          run: () => void callNative("assistant_toggle").catch((error: unknown) => notifyError("Couldn't open NOVA AI", error)),
        },
        {
          id: "app.tour",
          title: "Start the tour",
          subtitle: "A hands-on introduction to NOVA",
          group: "Layout",
          icon: Compass,
          keywords: ["tour", "tutorial", "einführung", "intro", "help", "hilfe", "onboarding"],
          run: () => useTour.getState().start(),
        },
        {
          id: "app.check-updates",
          title: "Check for updates",
          subtitle: "Look for a newer NOVA version now",
          group: "Layout",
          icon: RefreshCw,
          keywords: ["update", "version", "upgrade", "release"],
          run: () => {
            // Where the answer shows up.
            useUi.getState().openSettings("updates");
            void useUpdates.getState().check({ automatic: false });
          },
        },
      ]
    : [];

  const create: Command[] = [
    {
      id: "task.new",
      title: "New task",
      subtitle: "Open Productivity to add a task",
      group: "Tasks",
      icon: ListTodo,
      keywords: ["add", "todo", "reminder"],
      run: () => useUi.getState().navigate("productivity"),
    },
  ];

  return [...navigation, ...dashboardCommands, ...profiles, ...layout, ...maintenance, ...appearance, ...create, ...apps, ...tasks, ...widgets];
}
