import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { callNative } from "@/lib/native";
import { useSettings } from "@/stores/settings";
import { extractPalette } from "./palette";

/** Mirrors `WallpaperInfo` in src-tauri/src/wallpaper.rs. */
export interface WallpaperInfo {
  fileName: string;
  modifiedMs: number;
  sizeBytes: number;
}

/** Decodes the wallpaper in the webview at thumbnail size and samples its colors. */
async function sampleWallpaper(): Promise<string[]> {
  const bytes = await callNative<ArrayBuffer>("wallpaper_image");
  const bitmap = await createImageBitmap(new Blob([bytes]), { resizeWidth: 128, resizeHeight: 72, resizeQuality: "medium" });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas is unavailable");
    context.drawImage(bitmap, 0, 0);
    return extractPalette(context.getImageData(0, 0, bitmap.width, bitmap.height).data);
  } finally {
    bitmap.close();
  }
}

export type WallpaperPaletteResult =
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "none" }
  | { status: "ready"; colors: string[]; fileName: string };

/**
 * Colors of the current wallpaper. Only metadata is re-checked when the window
 * regains focus; the image itself is re-read only when the file changes.
 */
export function useWallpaperPalette(enabled = true): WallpaperPaletteResult {
  const info = useQuery({
    queryKey: ["wallpaper", "info"],
    queryFn: () => callNative<WallpaperInfo | null>("wallpaper_info"),
    enabled,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });
  const palette = useQuery({
    queryKey: ["wallpaper", "palette", info.data?.fileName, info.data?.modifiedMs, info.data?.sizeBytes],
    queryFn: sampleWallpaper,
    enabled: enabled && Boolean(info.data),
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (info.error) return { status: "error", error: info.error };
  if (info.data === null) return { status: "none" };
  if (palette.error) return { status: "error", error: palette.error };
  if (!info.data || !palette.data) return { status: "loading" };
  return { status: "ready", colors: palette.data, fileName: info.data.fileName };
}

/** Re-encodes the wallpaper at a small size: the backdrop is blurred anyway, and small images composite cheaply. */
async function renderBackdrop(): Promise<string> {
  const bytes = await callNative<ArrayBuffer>("wallpaper_image");
  const bitmap = await createImageBitmap(new Blob([bytes]), { resizeWidth: 960, resizeHeight: 540, resizeQuality: "medium" });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    return URL.createObjectURL(await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 }));
  } finally {
    bitmap.close();
  }
}

/** Object URL of a downscaled copy of the wallpaper, or null when off/unavailable. */
export function useWallpaperBackdrop(enabled: boolean): string | null {
  const info = useQuery({
    queryKey: ["wallpaper", "info"],
    queryFn: () => callNative<WallpaperInfo | null>("wallpaper_info"),
    enabled,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });
  const image = useQuery({
    queryKey: ["wallpaper", "backdrop", info.data?.fileName, info.data?.modifiedMs, info.data?.sizeBytes],
    queryFn: renderBackdrop,
    enabled: enabled && Boolean(info.data),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 60_000,
    retry: false,
  });
  const url = enabled ? (image.data ?? null) : null;
  useEffect(() => {
    if (!image.data) return;
    const created = image.data;
    return () => URL.revokeObjectURL(created);
  }, [image.data]);
  return url;
}

/** In "match wallpaper" mode, follows the wallpaper's dominant color. */
export function useWallpaperAccentSync(): void {
  const accent = useSettings((s) => s.accent);
  const following = accent.kind === "wallpaper";
  const palette = useWallpaperPalette(following);
  const dominant = palette.status === "ready" ? palette.colors[0] : undefined;

  useEffect(() => {
    if (following && dominant && accent.kind === "wallpaper" && accent.color !== dominant) {
      useSettings.getState().setAccent({ kind: "wallpaper", color: dominant });
    }
  }, [following, dominant, accent]);
}
