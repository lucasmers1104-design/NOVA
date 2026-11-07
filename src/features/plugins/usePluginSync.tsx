import { Puzzle } from "lucide-react";
import { useEffect, useRef } from "react";
import { usePluginWidgets } from "@/widgets/pluginRegistry";
import type { WidgetDefinition, WidgetDataSource } from "@/widgets/types";
import { type PluginInfo, runnable, usePlugins } from "./api";
import { PluginWidget } from "./PluginFrame";

function dataSource(plugin: PluginInfo): WidgetDataSource {
  if (plugin.permissions.some((p) => p.key === "network" && p.granted)) return "network";
  return plugin.permissions.some((p) => p.key === "system.metrics" && p.granted) ? "system" : "local";
}

export function pluginWidgetDefinitions(plugins: readonly PluginInfo[]): WidgetDefinition[] {
  return plugins.filter(runnable).flatMap((plugin) =>
    plugin.widgets.map((widget) => ({
      id: widget.key,
      name: widget.name,
      description: widget.description || `From the plugin ${plugin.name}.`,
      category: "plugin" as const,
      icon: Puzzle,
      defaultSize: { w: widget.w, h: widget.h },
      minSize: { w: Math.min(widget.w, 2), h: 1 },
      maxSize: { w: 12, h: 8 },
      dataSource: dataSource(plugin),
      configSchema: [],
      component: () => <PluginWidget plugin={plugin} widgetId={widget.id} name={widget.name} />,
    })),
  );
}

/** Keeps the widget registry in step with the installed plugins. */
export function usePluginSync(): void {
  const { data: plugins } = usePlugins();
  const last = useRef("");

  useEffect(() => {
    if (!plugins) return;
    // Components are made anew here, which remounts frames: only when something really changed.
    const signature = JSON.stringify(plugins);
    if (signature === last.current) return;
    last.current = signature;
    usePluginWidgets.setState({ widgets: pluginWidgetDefinitions(plugins) });
  }, [plugins]);
}
