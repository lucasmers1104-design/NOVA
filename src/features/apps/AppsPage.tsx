import { open } from "@tauri-apps/plugin-dialog";
import { ChevronLeft, ChevronRight, Plus, RefreshCw, Search, Star, Trash, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { notifyError } from "@/features/notifications/store";
import { cn } from "@/lib/cn";
import { AppIcon } from "./AppIcon";
import { type AppEntry, searchApps, useAddShortcut, useAppPreferences, useApps, useLaunchApp, useRemoveShortcut, useRescanApps } from "./api";

type Filter = "all" | "favorites" | "recent" | string;

export default function AppsPage() {
  const { data: apps, error, isPending, refetch } = useApps();
  const favorites = useAppPreferences((s) => s.favorites);
  const recents = useAppPreferences((s) => s.recents);
  const rescan = useRescanApps();
  const launch = useLaunchApp();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [adding, setAdding] = useState(false);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const app of apps ?? []) counts.set(app.category, (counts.get(app.category) ?? 0) + 1);
    return [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c]) => c);
  }, [apps]);

  const byId = useMemo(() => new Map((apps ?? []).map((a) => [a.id, a])), [apps]);
  const favoriteApps = favorites.map((id) => byId.get(id)).filter((a): a is AppEntry => Boolean(a));
  const recentApps = recents.map((r) => byId.get(r.id)).filter((a): a is AppEntry => Boolean(a));

  const visible = useMemo(() => {
    const base =
      filter === "all" ? apps ?? [] : filter === "favorites" ? favoriteApps : filter === "recent" ? recentApps : (apps ?? []).filter((a) => a.category === filter);
    return searchApps(base, query);
  }, [apps, filter, favoriteApps, recentApps, query]);

  return (
    <Page>
      <PageHeader
        title="Apps"
        description="Everything in your Start menu, plus apps you add. Launching only ever opens these entries."
        actions={
          <>
            <Button size="sm" variant="ghost" icon={<RefreshCw size={14} className={rescan.isPending ? "animate-spin" : ""} />} onClick={() => rescan.mutate()} disabled={rescan.isPending}>
              Rescan
            </Button>
            <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
              Add app
            </Button>
          </>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <label className="glass flex h-11 min-w-72 flex-1 items-center gap-2.5 rounded-full px-4 focus-within:border-line-strong">
          <Search size={17} className="text-fg-subtle" aria-hidden />
          <span className="sr-only">Search apps</span>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && visible[0]) launch.mutate(visible[0]);
              else if (e.key === "Escape" && query) {
                e.preventDefault();
                setQuery("");
              }
            }}
            placeholder="Search apps — press Enter to open the top result"
            className="h-full flex-1 bg-transparent text-[14px] text-fg outline-none select-text placeholder:text-fg-subtle"
          />
          {query && (
            <IconButton size="sm" label="Clear search" onClick={() => setQuery("")}>
              <X size={14} />
            </IconButton>
          )}
        </label>
        <div role="tablist" aria-label="App categories" className="flex flex-wrap gap-1.5">
          {[
            ["all", "All"],
            ["favorites", "Favorites"],
            ["recent", "Recent"],
            ...categories.map((c) => [c, c]),
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              onClick={() => setFilter(value!)}
              className={cn(
                "h-8 rounded-full border px-3.5 text-[12.5px] font-medium transition-colors",
                filter === value ? "accent-soft border-accent/40 text-fg" : "border-line bg-white/[0.03] text-fg-muted hover:text-fg",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="glass rounded-widget p-10">
          <StatusMessage error={error} subject="your apps" onRetry={() => void refetch()} />
        </div>
      ) : isPending ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-3">
          {Array.from({ length: 18 }, (_, i) => (
            <Skeleton key={i} className="h-32 rounded-[18px]" />
          ))}
        </div>
      ) : (
        <>
          {filter === "all" && !query && favoriteApps.length > 0 && <FavoritesStrip apps={favoriteApps} />}
          {visible.length === 0 ? (
            <p className="glass rounded-widget py-16 text-center text-[13px] text-fg-muted">
              {query
                ? `No apps match “${query}”.`
                : filter === "favorites"
                  ? "Star apps to keep them here and in Quick launch."
                  : filter === "recent"
                    ? "Apps you open from NOVA show up here."
                    : "Nothing here yet."}
            </p>
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-3">
              {visible.map((app) => (
                <AppTile key={app.id} app={app} favorite={favorites.includes(app.id)} />
              ))}
            </ul>
          )}
        </>
      )}

      <AddAppDialog open={adding} onClose={() => setAdding(false)} />
    </Page>
  );

}

function AppTile({ app, favorite }: { app: AppEntry; favorite: boolean }) {
  const launch = useLaunchApp();
  const toggleFavorite = useAppPreferences((s) => s.toggleFavorite);
  const remove = useRemoveShortcut();
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => launch.mutate(app)}
        title={`Open ${app.name}`}
        className="glass flex h-32 w-full flex-col items-center justify-center gap-2.5 rounded-[18px] px-3 text-center transition-[transform,background-color] duration-200 ease-nova hover:-translate-y-0.5 hover:bg-white/[0.07] active:scale-[0.97]"
      >
        <AppIcon id={app.id} name={app.name} size={44} className="drop-shadow-[0_6px_14px_rgb(0_0_0/0.35)]" />
        <span className="line-clamp-2 text-[12.5px] leading-tight font-medium text-fg">{app.name}</span>
      </button>
      <div className="absolute top-1.5 right-1.5 flex gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <IconButton size="sm" label={favorite ? `Remove ${app.name} from favorites` : `Add ${app.name} to favorites`} onClick={() => toggleFavorite(app.id)}>
          <Star size={14} className={favorite ? "fill-current text-warning" : ""} />
        </IconButton>
        {app.source === "custom" && (
          <IconButton size="sm" label={`Remove ${app.name}`} onClick={() => remove.mutate(app)} className="hover:text-danger">
            <Trash size={14} />
          </IconButton>
        )}
      </div>
      {favorite && <Star aria-hidden size={12} className="absolute top-3 left-3 fill-current text-warning group-hover:opacity-0" />}
    </li>
  );
}

function FavoritesStrip({ apps }: { apps: AppEntry[] }) {
  const launch = useLaunchApp();
  const moveFavorite = useAppPreferences((s) => s.moveFavorite);
  return (
    <section aria-label="Favorites" className="mb-6">
      <h2 className="mb-2.5 text-[12px] font-semibold tracking-wider text-fg-subtle uppercase">Favorites</h2>
      <ul className="flex flex-wrap gap-2.5">
        {apps.map((app, index) => (
          <li key={app.id} className="group glass flex items-center gap-1 rounded-full py-1 pr-1 pl-1.5">
            <button type="button" onClick={() => launch.mutate(app)} className="flex items-center gap-2 rounded-full pr-2 text-[13px] font-medium text-fg">
              <AppIcon id={app.id} name={app.name} size={26} />
              {app.name}
            </button>
            <span className="flex opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
              <IconButton size="sm" label={`Move ${app.name} left`} disabled={index === 0} onClick={() => moveFavorite(app.id, -1)}>
                <ChevronLeft size={14} />
              </IconButton>
              <IconButton size="sm" label={`Move ${app.name} right`} disabled={index === apps.length - 1} onClick={() => moveFavorite(app.id, 1)}>
                <ChevronRight size={14} />
              </IconButton>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AddAppDialog({ open: isOpen, onClose }: { open: boolean; onClose: () => void }) {
  const add = useAddShortcut();
  const [path, setPath] = useState("");
  const [name, setName] = useState("");

  const pick = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title: "Choose an app",
        filters: [{ name: "Apps and shortcuts", extensions: ["exe", "lnk", "url", "appref-ms", "msc"] }],
      });
      if (typeof selected === "string") {
        setPath(selected);
        if (!name) setName(selected.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "");
      }
    } catch (error) {
      notifyError("The file picker couldn't open", error);
    }
  };

  const close = () => {
    setPath("");
    setName("");
    onClose();
  };

  return (
    <Dialog
      open={isOpen}
      onClose={close}
      title="Add an app"
      description="Pick a program or shortcut. NOVA stores the path and opens it only when you click it."
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={!path || add.isPending} onClick={() => add.mutate({ name, path }, { onSuccess: close })}>
            Add app
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-fg">Program</p>
          <div className="flex gap-2">
            <p className="flex h-10 min-w-0 flex-1 items-center truncate rounded-control border border-line bg-black/25 px-3 text-[13px] text-fg-muted" title={path}>
              {path || "No file selected"}
            </p>
            <Button size="md" variant="secondary" onClick={() => void pick()} data-autofocus>
              Browse…
            </Button>
          </div>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-fg">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            className="h-10 w-full rounded-control border border-line bg-black/25 px-3 text-[13px] text-fg outline-none select-text focus:border-line-strong"
          />
        </label>
      </div>
    </Dialog>
  );
}
