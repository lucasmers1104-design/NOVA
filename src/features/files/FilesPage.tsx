import { open } from "@tauri-apps/plugin-dialog";
import { ChevronRight, Clock, Download, ExternalLink, FileText, FolderOpen, FolderPlus, Image, Monitor, Music, Search, Star, Video, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { Button, IconButton } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { notifyError } from "@/features/notifications/store";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { WidgetFrame } from "@/widgets/WidgetFrame";
import { type FileEntry, folderName, iconFor, openItem, revealItem, useFavorites, useFileSearch, useFolder, useKnownFolders, useRecentFiles } from "./api";

const KNOWN_ICONS: Record<string, typeof Monitor> = {
  desktop: Monitor,
  documents: FileText,
  downloads: Download,
  pictures: Image,
  music: Music,
  videos: Video,
};

interface Location {
  root: string;
  path: string;
  label: string;
}

export default function FilesPage() {
  const { data: known, error: knownError } = useKnownFolders();
  const favorites = useFavorites((s) => s.favorites);
  const loaded = useFavorites((s) => s.loaded);
  const load = useFavorites((s) => s.load);
  const addFavorite = useFavorites((s) => s.add);
  const removeFavorite = useFavorites((s) => s.remove);
  const [location, setLocation] = useState<Location | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const pickFavorite = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "Choose a folder to add to favorites" });
      if (typeof selected === "string") addFavorite(selected);
    } catch (error) {
      notifyError("The folder picker couldn't open", error);
    }
  };

  return (
    <Page>
      <PageHeader
        title="Files"
        description="Your folders, favorites and recent files. NOVA only reads these locations and never changes or deletes files."
        actions={
          <Button size="sm" variant="secondary" icon={<FolderPlus size={14} />} onClick={() => void pickFavorite()}>
            Add favorite folder
          </Button>
        }
      />

      <label className="glass mb-5 flex h-11 items-center gap-2.5 rounded-full px-4 focus-within:border-line-strong">
        <Search size={17} className="text-fg-subtle" aria-hidden />
        <span className="sr-only">Search files</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your standard folders and favorites by name"
          className="h-full flex-1 bg-transparent text-[14px] text-fg outline-none select-text placeholder:text-fg-subtle"
        />
        {query && (
          <IconButton size="sm" label="Clear search" onClick={() => setQuery("")}>
            <X size={14} />
          </IconButton>
        )}
      </label>

      {query.trim().length >= 2 ? (
        <SearchResults query={query} />
      ) : (
        <div className="grid grid-cols-12 gap-4">
          <section aria-label="Quick access" className="col-span-12">
            <h2 className="mb-2.5 text-[12px] font-semibold tracking-wider text-fg-subtle uppercase">Quick access</h2>
            {knownError ? (
              <StatusMessage error={knownError} subject="folders" compact />
            ) : (
              <ul className="grid grid-cols-6 gap-3">
                {(known ?? []).map((folder) => {
                  const Icon = KNOWN_ICONS[folder.id] ?? FolderOpen;
                  return (
                    <li key={folder.id}>
                      <button
                        type="button"
                        onClick={() => setLocation({ root: folder.path, path: folder.path, label: folder.name })}
                        className={cn(
                          "glass flex h-24 w-full flex-col items-center justify-center gap-2 rounded-[18px] transition-[transform,background-color] duration-200 hover:-translate-y-0.5 hover:bg-white/[0.07]",
                          location?.root === folder.path && "border-accent/50",
                        )}
                      >
                        <Icon size={24} className="text-accent-text" aria-hidden />
                        <span className="text-[13px] font-medium text-fg">{folder.name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <div className="col-span-4 flex flex-col gap-4">
            <div className="h-64">
              <WidgetFrame title="Favorites" icon={Star}>
                {favorites.length === 0 ? (
                  <p className="text-[13px] text-fg-muted">Add project folders you use often — they become browsable and searchable here.</p>
                ) : (
                  <ul className="h-full space-y-1 overflow-y-auto">
                    {favorites.map((fav) => (
                      <li key={fav.path} className="group flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setLocation({ root: fav.path, path: fav.path, label: fav.name })}
                          title={fav.path}
                          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left hover:bg-white/[0.05]"
                        >
                          <FolderOpen size={15} className="shrink-0 text-accent-text" aria-hidden />
                          <span className="truncate text-[13px] text-fg">{fav.name}</span>
                        </button>
                        <IconButton size="sm" label={`Remove ${fav.name} from favorites`} onClick={() => removeFavorite(fav.path)} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100">
                          <X size={13} />
                        </IconButton>
                      </li>
                    ))}
                  </ul>
                )}
              </WidgetFrame>
            </div>
            <div className="h-80">
              <RecentFiles />
            </div>
          </div>

          <div className="col-span-8 h-[calc(20rem+16rem+1rem)]">
            {location ? (
              <FolderBrowser location={location} onNavigate={setLocation} />
            ) : (
              <div className="glass flex h-full flex-col items-center justify-center gap-2 rounded-widget text-center">
                <FolderOpen size={26} className="text-fg-subtle" aria-hidden />
                <p className="text-[14px] font-medium text-fg">Choose a folder</p>
                <p className="max-w-xs text-[13px] text-fg-muted">Pick a quick-access or favorite folder to browse it. Double-click opens a file with its usual app.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </Page>
  );
}

function FileRow({ entry, onOpenFolder }: { entry: FileEntry; onOpenFolder?: (entry: FileEntry) => void }) {
  const Icon = iconFor(entry);
  const activate = () => (entry.isDir && onOpenFolder ? onOpenFolder(entry) : void openItem(entry));
  return (
    <li className="group flex items-center gap-3 rounded-[10px] px-2.5 py-1.5 hover:bg-white/[0.04]">
      <Icon size={16} className={entry.isDir ? "shrink-0 text-accent-text" : "shrink-0 text-fg-subtle"} aria-hidden />
      <button type="button" onDoubleClick={activate} onClick={(e) => e.detail === 0 && activate()} className="min-w-0 flex-1 truncate text-left text-[13px] text-fg" title={entry.path}>
        {entry.name}
      </button>
      <span className="w-20 shrink-0 text-right text-[11.5px] text-fg-subtle tabular-nums">{entry.isDir ? "" : formatBytes(entry.size)}</span>
      <span className="w-24 shrink-0 text-right text-[11.5px] text-fg-subtle tabular-nums">{entry.modifiedMs ? new Date(entry.modifiedMs).toLocaleDateString() : ""}</span>
      <IconButton size="sm" label={`Show ${entry.name} in Explorer`} onClick={() => void revealItem(entry)} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100">
        <ExternalLink size={13} />
      </IconButton>
    </li>
  );
}

function FolderBrowser({ location, onNavigate }: { location: Location; onNavigate: (location: Location) => void }) {
  const { data, error, isPending, refetch } = useFolder(location.path);
  const crumbs = useMemo(() => {
    const relative = location.path.slice(location.root.length).split(/[\\/]/).filter(Boolean);
    const list = [{ label: location.label, path: location.root }];
    let current = location.root;
    for (const part of relative) {
      current = `${current.replace(/[\\/]+$/, "")}\\${part}`;
      list.push({ label: part, path: current });
    }
    return list;
  }, [location]);

  return (
    <section aria-label="Folder contents" className="glass flex h-full flex-col rounded-widget p-4">
      <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-1 overflow-hidden text-[13px]">
        {crumbs.map((crumb, i) => (
          <span key={crumb.path} className="flex min-w-0 items-center gap-1">
            {i > 0 && <ChevronRight size={13} className="shrink-0 text-fg-subtle" aria-hidden />}
            <button
              type="button"
              onClick={() => onNavigate({ ...location, path: crumb.path })}
              aria-current={i === crumbs.length - 1 ? "page" : undefined}
              className={cn("truncate rounded px-1.5 py-0.5 hover:bg-white/[0.06]", i === crumbs.length - 1 ? "font-medium text-fg" : "text-fg-muted")}
            >
              {crumb.label}
            </button>
          </span>
        ))}
        <span className="ml-auto shrink-0">
          <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => void openItem({ path: location.path, name: folderName(location.path) })} className="h-7">
            Open in Explorer
          </Button>
        </span>
      </nav>
      {error ? (
        <StatusMessage error={error} subject="this folder" onRetry={() => void refetch()} />
      ) : isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-7" />
          ))}
        </div>
      ) : data.length === 0 ? (
        <p className="flex flex-1 items-center justify-center text-[13px] text-fg-muted">This folder is empty.</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {data.map((entry) => (
            <FileRow key={entry.path} entry={entry} onOpenFolder={(folder) => onNavigate({ ...location, path: folder.path })} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentFiles() {
  const { data, error, isPending } = useRecentFiles();
  return (
    <WidgetFrame title="Recent" icon={Clock}>
      {error ? (
        <StatusMessage error={error} subject="recent files" compact />
      ) : isPending ? (
        <Skeleton className="h-full" />
      ) : data.length === 0 ? (
        <p className="text-[13px] text-fg-muted">Files you open in Windows appear here.</p>
      ) : (
        <ul className="-mx-2 h-full overflow-y-auto">
          {data.map((entry) => {
            const Icon = iconFor({ name: entry.name, isDir: false });
            return (
              <li key={entry.path}>
                <button
                  type="button"
                  onClick={() => void openItem(entry)}
                  className="flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left hover:bg-white/[0.05]"
                  title={`Open ${entry.name}`}
                >
                  <Icon size={15} className="shrink-0 text-fg-subtle" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{entry.name}</span>
                  <span className="shrink-0 text-[11px] text-fg-subtle">{new Date(entry.modifiedMs).toLocaleDateString()}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetFrame>
  );
}

function SearchResults({ query }: { query: string }) {
  const { data, error, isFetching } = useFileSearch(query);
  return (
    <section aria-label="Search results" className="glass rounded-widget p-4">
      <p className="mb-2 px-2 text-[12px] text-fg-subtle">
        {isFetching ? "Searching…" : data ? `${data.length}${data.length === 100 ? "+" : ""} results` : ""}
      </p>
      {error ? (
        <StatusMessage error={error} subject="search results" compact />
      ) : (
        <ul>
          {(data ?? []).map((entry) => (
            <FileRow key={entry.path} entry={entry} />
          ))}
        </ul>
      )}
      {data?.length === 0 && !isFetching && <p className="py-8 text-center text-[13px] text-fg-muted">No files or folders named like “{query}”.</p>}
    </section>
  );
}
