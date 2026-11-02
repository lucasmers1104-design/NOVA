import { useQuery } from "@tanstack/react-query";
import { FileArchive, FileCode, FileImage, FileMusic, FileSpreadsheet, FileText, FileVideoCamera, Folder, type LucideIcon, File as FileIcon } from "lucide-react";
import { create } from "zustand";
import { notify, notifyError } from "@/features/notifications/store";
import { callNative } from "@/lib/native";
import { readJson, writeJson } from "@/lib/persistence";

export interface KnownFolder {
  id: string;
  name: string;
  path: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedMs: number;
}

export interface FavoriteFolder {
  path: string;
  name: string;
}

export function useKnownFolders() {
  return useQuery({ queryKey: ["files", "known"], queryFn: () => callNative<KnownFolder[]>("files_known_folders"), staleTime: Number.POSITIVE_INFINITY });
}

export function useRecentFiles(limit = 24) {
  return useQuery({ queryKey: ["files", "recent", limit], queryFn: () => callNative<FileEntry[]>("files_recent", { limit }), refetchInterval: 60_000 });
}

export function useFolder(path: string | null) {
  return useQuery({ queryKey: ["files", "list", path], queryFn: () => callNative<FileEntry[]>("files_list", { path }), enabled: path !== null });
}

export function useFileSearch(query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: ["files", "search", q],
    queryFn: () => callNative<FileEntry[]>("files_search", { query: q, root: null }),
    enabled: q.length >= 2,
    staleTime: 30_000,
  });
}

export async function openItem(entry: Pick<FileEntry, "path" | "name">) {
  try {
    await callNative("files_open", { path: entry.path });
  } catch (error) {
    notifyError(`Couldn't open ${entry.name}`, error);
  }
}

export async function revealItem(entry: Pick<FileEntry, "path" | "name">) {
  try {
    await callNative("files_reveal", { path: entry.path });
  } catch (error) {
    notifyError(`Couldn't show ${entry.name} in Explorer`, error);
  }
}

// Favorites are written as plain JSON under "nova.files": the Rust side reads
// this exact shape to decide which folders NOVA may list and search.
const FAVORITES_KEY = "nova.files";

interface FavoritesState {
  loaded: boolean;
  favorites: FavoriteFolder[];
  load: () => Promise<void>;
  add: (path: string) => void;
  remove: (path: string) => void;
}

export function folderName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

export const useFavorites = create<FavoritesState>()((set, get) => {
  const save = (favorites: FavoriteFolder[]) => {
    set({ favorites });
    void writeJson(FAVORITES_KEY, { favorites });
  };
  return {
    loaded: false,
    favorites: [],
    load: async () => {
      const stored = (await readJson(FAVORITES_KEY)) as { favorites?: unknown } | null;
      const favorites = Array.isArray(stored?.favorites)
        ? stored.favorites.filter((f): f is FavoriteFolder => typeof f?.path === "string" && typeof f?.name === "string").slice(0, 30)
        : [];
      set({ favorites, loaded: true });
    },
    add: (path) => {
      if (get().favorites.some((f) => f.path.toLowerCase() === path.toLowerCase())) return;
      save([...get().favorites, { path, name: folderName(path) }]);
      notify(`${folderName(path)} added to favorites`, { kind: "success" });
    },
    remove: (path) => save(get().favorites.filter((f) => f.path !== path)),
  };
});

const EXTENSION_ICONS: [RegExp, LucideIcon][] = [
  [/\.(png|jpe?g|gif|webp|bmp|svg|heic|ico)$/i, FileImage],
  [/\.(mp4|mkv|mov|avi|wmv|webm)$/i, FileVideoCamera],
  [/\.(mp3|wav|flac|m4a|ogg|aac)$/i, FileMusic],
  [/\.(zip|rar|7z|tar|gz)$/i, FileArchive],
  [/\.(xlsx?|csv|ods)$/i, FileSpreadsheet],
  [/\.(ts|tsx|js|jsx|rs|py|cs|cpp|c|h|json|html|css|java|go|sh|ps1)$/i, FileCode],
  [/\.(txt|md|docx?|pdf|rtf|odt|pptx?)$/i, FileText],
];

export function iconFor(entry: Pick<FileEntry, "name" | "isDir">): LucideIcon {
  if (entry.isDir) return Folder;
  return EXTENSION_ICONS.find(([pattern]) => pattern.test(entry.name))?.[1] ?? FileIcon;
}
