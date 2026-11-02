import { AudioLines, CalendarDays, Clock, CloudSun, Cpu, HardDrive, Hourglass, ListTodo, MemoryStick, Monitor, Network, Newspaper, Rocket, Sparkles, Zap } from "lucide-react";
import { GpuWidget } from "./builtin/GpuWidget";
import { NewsWidget, ProgressWidget, WeatherWidget } from "./builtin/LiveInfoWidgets";
import { MusicWidget } from "./builtin/MusicWidget";
import { NetworkWidget } from "./builtin/NetworkWidget";
import { QuickLaunchWidget } from "./builtin/QuickLaunchWidget";
import { TasksWidget } from "./builtin/TasksWidget";
import { CalendarWidget } from "./builtin/CalendarWidget";
import { CLOCK_TIME_ZONES, ClockWidget, LOCAL_TIME_ZONE } from "./builtin/ClockWidget";
import { CpuWidget } from "./builtin/CpuWidget";
import { DeviceWidget } from "./builtin/DeviceWidget";
import { MemoryWidget } from "./builtin/MemoryWidget";
import { StorageWidget } from "./builtin/StorageWidget";
import { WelcomeWidget } from "./builtin/WelcomeWidget";
import type { WidgetDefinition } from "./types";

/**
 * Trusted built-in widgets. Third-party widgets will arrive through a
 * permissioned, isolated plugin API — never as unrestricted scripts.
 */
export const WIDGETS: readonly WidgetDefinition[] = [
  {
    id: "welcome",
    name: "Welcome",
    description: "Greeting, date, clock and a live system pulse.",
    category: "overview",
    icon: Sparkles,
    defaultSize: { w: 8, h: 2 },
    minSize: { w: 6, h: 2 },
    maxSize: { w: 12, h: 3 },
    dataSource: "system",
    configSchema: [
      { type: "boolean", key: "showSeconds", label: "Show seconds", default: true },
      { type: "boolean", key: "showPulse", label: "Live system status", description: "CPU, memory and uptime chips.", default: true },
    ],
    component: WelcomeWidget,
  },
  {
    id: "clock",
    name: "World clock",
    description: "The time in any major city, next to your own.",
    category: "time",
    icon: Clock,
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 2 },
    maxSize: { w: 6, h: 2 },
    dataSource: "local",
    configSchema: [
      { type: "select", key: "timeZone", label: "Time zone", default: LOCAL_TIME_ZONE, options: CLOCK_TIME_ZONES },
      { type: "boolean", key: "showSeconds", label: "Show seconds", default: false },
    ],
    component: ClockWidget,
  },
  {
    id: "calendar",
    name: "Calendar",
    description: "Month view with week and day-of-year.",
    category: "time",
    icon: CalendarDays,
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 3, h: 4 },
    maxSize: { w: 6, h: 5 },
    dataSource: "local",
    configSchema: [
      {
        type: "select",
        key: "weekStart",
        label: "First day of the week",
        default: "locale",
        options: [
          { value: "locale", label: "Regional" },
          { value: "monday", label: "Monday" },
          { value: "sunday", label: "Sunday" },
        ],
      },
      { type: "boolean", key: "showWeekInfo", label: "Week and day number", default: true },
    ],
    component: CalendarWidget,
  },
  {
    id: "cpu",
    name: "Processor",
    description: "Live CPU utilization with session history.",
    category: "system",
    icon: Cpu,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 3 },
    maxSize: { w: 8, h: 4 },
    dataSource: "system",
    configSchema: [{ type: "boolean", key: "showChart", label: "History chart", default: true }],
    component: CpuWidget,
  },
  {
    id: "memory",
    name: "Memory",
    description: "RAM and page file usage.",
    category: "system",
    icon: MemoryStick,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 3 },
    maxSize: { w: 6, h: 4 },
    dataSource: "system",
    configSchema: [{ type: "boolean", key: "showPageFile", label: "Page file usage", default: true }],
    component: MemoryWidget,
  },
  {
    id: "gpu",
    name: "Graphics",
    description: "GPU utilization and video memory, where the driver reports them.",
    category: "system",
    icon: Zap,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 3 },
    maxSize: { w: 8, h: 4 },
    dataSource: "system",
    configSchema: [{ type: "boolean", key: "showChart", label: "History chart", default: true }],
    component: GpuWidget,
  },
  {
    id: "network",
    name: "Network",
    description: "Live download and upload throughput.",
    category: "system",
    icon: Network,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 2 },
    maxSize: { w: 8, h: 4 },
    dataSource: "system",
    configSchema: [{ type: "boolean", key: "showChart", label: "History chart", default: true }],
    component: NetworkWidget,
  },
  {
    id: "device",
    name: "This device",
    description: "Device name, Windows version, hardware and uptime.",
    category: "system",
    icon: Monitor,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 3 },
    maxSize: { w: 6, h: 4 },
    dataSource: "system",
    configSchema: [
      {
        type: "boolean",
        key: "showDeviceName",
        label: "Show device name",
        description: "Turn off before sharing your screen.",
        default: true,
      },
    ],
    component: DeviceWidget,
  },
  {
    id: "storage",
    name: "Storage",
    description: "Capacity and free space for every volume.",
    category: "system",
    icon: HardDrive,
    defaultSize: { w: 8, h: 2 },
    minSize: { w: 4, h: 2 },
    maxSize: { w: 12, h: 4 },
    dataSource: "system",
    configSchema: [{ type: "boolean", key: "showRemovable", label: "Include removable drives", default: true }],
    component: StorageWidget,
  },
  {
    id: "tasks",
    name: "Today's tasks",
    description: "Overdue and due-today tasks with quick add.",
    category: "productivity",
    icon: ListTodo,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 2 },
    maxSize: { w: 6, h: 5 },
    dataSource: "local",
    configSchema: [{ type: "boolean", key: "showQuickAdd", label: "Quick add field", default: true }],
    component: TasksWidget,
  },
  {
    id: "quick-launch",
    name: "Quick launch",
    description: "Your favorite or most recent apps, one click away.",
    category: "productivity",
    icon: Rocket,
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 2 },
    maxSize: { w: 12, h: 3 },
    dataSource: "local",
    configSchema: [
      {
        type: "select",
        key: "source",
        label: "Show",
        default: "favorites",
        options: [
          { value: "favorites", label: "Favorites" },
          { value: "recent", label: "Recent" },
        ],
      },
    ],
    component: QuickLaunchWidget,
  },
  {
    id: "music",
    name: "Now playing",
    description: "Artwork and controls for whatever is playing.",
    category: "media",
    icon: AudioLines,
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 4, h: 2 },
    maxSize: { w: 8, h: 3 },
    dataSource: "system",
    configSchema: [],
    component: MusicWidget,
  },
  {
    id: "weather",
    name: "Weather",
    description: "Current conditions and a 3-day outlook from Open-Meteo.",
    category: "information",
    icon: CloudSun,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 3 },
    maxSize: { w: 6, h: 4 },
    dataSource: "network",
    configSchema: [],
    component: WeatherWidget,
  },
  {
    id: "news",
    name: "Headlines",
    description: "Latest articles from the feeds you added.",
    category: "information",
    icon: Newspaper,
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 2 },
    maxSize: { w: 8, h: 6 },
    dataSource: "network",
    configSchema: [],
    component: NewsWidget,
  },
  {
    id: "progress",
    name: "Progress",
    description: "How much of the day, week, month and year has passed.",
    category: "time",
    icon: Hourglass,
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 2 },
    maxSize: { w: 6, h: 3 },
    dataSource: "local",
    configSchema: [],
    component: ProgressWidget,
  },
];

export function getWidget(id: string): WidgetDefinition | undefined {
  return WIDGETS.find((widget) => widget.id === id);
}
