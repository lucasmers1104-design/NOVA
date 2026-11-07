import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { callNative, isDesktop } from "@/lib/native";

/** Mirrors `PluginInfo` in src-tauri/src/plugins.rs. */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  channel: "public" | "private";
  signed: boolean;
  enabled: boolean;
  problem: string | null;
  lastError: string | null;
  entryUrl: string | null;
  permissions: { key: string; label: string; granted: boolean }[];
  pages: { id: string; title: string }[];
  widgets: { key: string; id: string; name: string; description: string; w: number; h: number }[];
  themes: { id: string; name: string; accent: string }[];
}

export interface PendingInstall {
  name: string;
  version: string;
  description: string;
  author: string;
  channel: "public" | "private";
  signed: boolean;
  replaces: string | null;
  permissions: string[];
  addedPermissions: string[];
}

export const PLUGINS_KEY = ["plugins"] as const;

export function usePlugins() {
  return useQuery({ queryKey: PLUGINS_KEY, queryFn: () => callNative<PluginInfo[]>("plugins_list"), enabled: isDesktop() });
}

export function runnable(plugin: PluginInfo): boolean {
  return plugin.enabled && plugin.problem === null && plugin.entryUrl !== null;
}

/** Any change to the plugin list: the sidebar and the widget registry follow the query. */
export function usePluginAction<T>(action: (input: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({ mutationFn: action, onSuccess: () => client.invalidateQueries({ queryKey: PLUGINS_KEY }) });
}
