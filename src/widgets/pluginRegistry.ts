import { create } from "zustand";
import type { WidgetDefinition } from "./types";

/** Widgets of enabled plugins. Kept apart so the registry doesn't load the plugin host. */
export const usePluginWidgets = create<{ widgets: readonly WidgetDefinition[] }>()(() => ({ widgets: [] }));
