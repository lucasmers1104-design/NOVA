import {
  Activity,
  BarChart3,
  Bell,
  BookOpen,
  Calendar,
  Camera,
  ChartLine,
  Clock,
  Cloud,
  Code,
  Cpu,
  Film,
  Gamepad2,
  Globe,
  Heart,
  House,
  Image,
  KeyRound,
  type LucideIcon,
  Mail,
  Map as MapIcon,
  MessageSquare,
  Mic,
  Music,
  Palette,
  Puzzle,
  ShieldCheck,
  Smartphone,
  Star,
  Terminal,
  UserPlus,
  Users,
  Wallet,
  Zap,
} from "lucide-react";
import type { PluginInfo } from "./api";

/** The names a manifest's `icon` may use; mirrors `ICONS` in src-tauri/src/plugins.rs. */
export const PLUGIN_ICONS: Record<string, LucideIcon> = {
  smartphone: Smartphone,
  "user-plus": UserPlus,
  users: Users,
  "message-square": MessageSquare,
  "bar-chart": BarChart3,
  activity: Activity,
  palette: Palette,
  music: Music,
  gamepad: Gamepad2,
  calendar: Calendar,
  clock: Clock,
  cloud: Cloud,
  globe: Globe,
  camera: Camera,
  image: Image,
  film: Film,
  mic: Mic,
  bell: Bell,
  shield: ShieldCheck,
  key: KeyRound,
  wallet: Wallet,
  "chart-line": ChartLine,
  cpu: Cpu,
  zap: Zap,
  star: Star,
  heart: Heart,
  book: BookOpen,
  code: Code,
  terminal: Terminal,
  home: House,
  mail: Mail,
  map: MapIcon,
};

/** NOVA's own plugins, for versions whose manifest has no icon yet. */
const KNOWN: Record<string, LucideIcon> = {
  "dev.nova.companion": Smartphone,
  "dev.nova.relay-invite": UserPlus,
};

/** Words in a plugin's name that say what it is, for plugins without an icon. */
const HINTS: [RegExp, LucideIcon][] = [
  [/phone|handy|companion|mobile/i, Smartphone],
  [/discord|chat|message|nachricht/i, MessageSquare],
  [/invite|einlad|friend|freund/i, UserPlus],
  [/stat|analytic|chart|metric|pulse/i, BarChart3],
  [/theme|color|farb|aurora/i, Palette],
  [/music|musik|spotify|song/i, Music],
  [/game|spiel/i, Gamepad2],
  [/weather|wetter/i, Cloud],
];

/** The icon a plugin shows in the sidebar and the plugin list. */
export function pluginIcon(plugin: Pick<PluginInfo, "id" | "name" | "channel"> & { icon?: string | null }): LucideIcon {
  const named = plugin.icon ? PLUGIN_ICONS[plugin.icon] : undefined;
  if (named) return named;
  const known = KNOWN[plugin.id];
  if (known) return known;
  const hint = HINTS.find(([pattern]) => pattern.test(`${plugin.name} ${plugin.id}`));
  if (hint) return hint[1];
  return plugin.channel === "private" ? BarChart3 : Puzzle;
}
