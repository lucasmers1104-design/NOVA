import { Rocket } from "lucide-react";
import { useMemo } from "react";
import { AppIcon } from "@/features/apps/AppIcon";
import { type AppEntry, useAppPreferences, useApps, useLaunchApp } from "@/features/apps/api";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { useUi } from "@/stores/ui";
import { useWidgetConfig } from "../config";
import { WidgetFrame } from "../WidgetFrame";

export function QuickLaunchWidget() {
  const { source } = useWidgetConfig<{ source: string }>();
  const { data: apps, error } = useApps();
  const favorites = useAppPreferences((s) => s.favorites);
  const recents = useAppPreferences((s) => s.recents);
  const launch = useLaunchApp();
  const navigate = useUi((s) => s.navigate);

  const list = useMemo(() => {
    const byId = new Map((apps ?? []).map((a) => [a.id, a]));
    const ids = source === "recent" ? recents.map((r) => r.id) : favorites;
    return ids.map((id) => byId.get(id)).filter((a): a is AppEntry => Boolean(a)).slice(0, 12);
  }, [apps, favorites, recents, source]);

  return (
    <WidgetFrame title={source === "recent" ? "Recent apps" : "Quick launch"} icon={Rocket}>
      {error ? (
        <StatusMessage error={error} subject="apps" compact />
      ) : list.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
          <p className="text-[13px] text-fg-muted">{source === "recent" ? "Apps you open from NOVA show up here." : "Star apps to pin them here."}</p>
          <button type="button" onClick={() => navigate("apps")} className="text-[12px] font-medium text-accent-text hover:underline">
            Open Apps
          </button>
        </div>
      ) : (
        <ul className="grid h-full grid-cols-[repeat(auto-fill,minmax(72px,1fr))] content-start gap-1">
          {list.map((app) => (
            <li key={app.id}>
              <button
                type="button"
                onClick={() => launch.mutate(app)}
                title={`Open ${app.name}`}
                className="flex w-full flex-col items-center gap-1.5 rounded-[14px] p-2 transition-colors hover:bg-white/[0.06] active:scale-95"
              >
                <AppIcon id={app.id} name={app.name} size={36} />
                <span className="w-full truncate text-center text-[11px] text-fg-muted">{app.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </WidgetFrame>
  );
}
