import { type ComponentType, lazy } from "react";
import type { RouteId } from "./navigation";

// Feature modules are code-split so startup only loads what the first page needs.
const HomePage = lazy(() => import("@/features/home/HomePage"));
const SystemPage = lazy(() => import("@/features/system/SystemPage"));
const AppsPage = lazy(() => import("@/features/apps/AppsPage"));
const AiPage = lazy(() => import("@/features/ai/AiPage"));
const ProductivityPage = lazy(() => import("@/features/productivity/ProductivityPage"));
const RoutinesPage = lazy(() => import("@/features/routines/RoutinesPage"));
const MediaPage = lazy(() => import("@/features/media/MediaPage"));
const FilesPage = lazy(() => import("@/features/files/FilesPage"));
const LivePage = lazy(() => import("@/features/live/LivePage"));
const WidgetStudioPage = lazy(() => import("@/features/studio/WidgetStudioPage"));
const PluginsPage = lazy(() => import("@/features/plugins/PluginsPage"));
const SettingsPage = lazy(() => import("@/features/settings/SettingsPage"));

/** Exhaustive by type: adding a RouteId without a page fails to compile. */
export const ROUTES: Record<RouteId, ComponentType> = {
  home: HomePage,
  system: SystemPage,
  apps: AppsPage,
  ai: AiPage,
  productivity: ProductivityPage,
  routines: RoutinesPage,
  media: MediaPage,
  files: FilesPage,
  live: LivePage,
  studio: WidgetStudioPage,
  plugins: PluginsPage,
  settings: SettingsPage,
};
