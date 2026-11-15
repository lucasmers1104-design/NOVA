// New versions of the app come from the same GitHub repository as NOVA's own updates:
// releases/companion.json says which version is current, releases/NOVA-Companion.apk is it.
// The download is checked against the manifest's SHA-256, then handed to Android's
// installer, which asks the user and only accepts an APK signed like the installed app.

import { type AppRelease, parseRelease } from "@nova/companion-protocol/app";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import { type DownloadTask, File, Paths } from "expo-file-system";
import { create } from "zustand";
import { NovaBridge } from "../modules/nova-bridge";
import { updateOffered } from "./logic";

/** NOVA's update source; the PC's default too (src/features/updates/store.ts). */
export const REPOSITORY = "lucasmers1104-design/NOVA";
const MANIFEST = `https://raw.githubusercontent.com/${REPOSITORY}/main/releases/companion.json`;
const TIMEOUT_MS = 12_000;
const APK_NAME = /^NOVA-Companion-.*\.apk$/;

export function installedVersion(): { version: string; code: number } {
  const config = Constants.expoConfig;
  return { version: config?.version ?? "0.0.0", code: config?.android?.versionCode ?? 0 };
}

type Phase = "idle" | "checking" | "current" | "available" | "downloading" | "verifying" | "ready" | "error";

interface UpdateStore {
  phase: Phase;
  release: AppRelease | null;
  error: string | null;
  checkedAt: number | null;
  /** Share of the download that arrived, 0 to 1; `null` while the size isn't known. */
  progress: number | null;
  check(): Promise<void>;
  download(): Promise<void>;
  cancelDownload(): void;
  /** `"permission"` if Android's "install unknown apps" page was opened instead; the user comes back and taps again. */
  install(): "started" | "permission" | "failed";
}

let downloaded: File | null = null;
let task: DownloadTask | null = null;

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The file's SHA-256 as hex. */
async function sha256(file: File): Promise<string> {
  // The app's own Android module reads the file in pieces. Without it (Expo Go, iOS), or
  // if it can't read the file, the whole APK is held in memory once and copied over the bridge.
  if (NovaBridge) {
    try {
      return await NovaBridge.fileSha256(file.uri);
    } catch {
      // Fall through to the slower way; the result is the same.
    }
  }
  return hex(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, await file.bytes()));
}

/** SECURITY: only the exact file the manifest names gets to the installer. */
async function matches(file: File, release: AppRelease): Promise<boolean> {
  return file.exists && file.size === release.size && (await sha256(file)) === release.sha256;
}

function apkFile(release: AppRelease): File {
  return new File(Paths.cache, `NOVA-Companion-${release.version}.apk`);
}

/** Earlier downloads are 40 MB each and of no use once a newer release exists. */
function removeOtherApks(keep: File): void {
  try {
    for (const entry of Paths.cache.list()) {
      if (entry instanceof File && APK_NAME.test(entry.name) && entry.uri !== keep.uri) entry.delete();
    }
  } catch {
    // The cache is Android's to clean up anyway.
  }
}

export const useUpdates = create<UpdateStore>((set, get) => ({
  phase: "idle",
  release: null,
  error: null,
  checkedAt: null,
  progress: null,

  async check() {
    const phase = get().phase;
    if (phase === "checking" || phase === "downloading" || phase === "verifying") return;
    set({ phase: "checking", error: null });
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const response = await fetch(MANIFEST, { signal: controller.signal, headers: { "Cache-Control": "no-cache" } }).finally(() => clearTimeout(timer));
      if (!response.ok) throw new Error(response.status === 404 ? "Auf GitHub liegt noch keine App-Version." : `GitHub antwortet nicht (${response.status}).`);
      const release = parseRelease(await response.json(), REPOSITORY);
      if (!release) throw new Error("Die Versionsangabe auf GitHub ist ungültig.");
      if (!updateOffered(release, installedVersion())) {
        set({ phase: "current", release, checkedAt: Date.now() });
        return;
      }
      // Loaded before the app was closed: it doesn't have to come down again.
      const file = apkFile(release);
      removeOtherApks(file);
      const ready = await matches(file, release).catch(() => false);
      if (ready) downloaded = file;
      set({ phase: ready ? "ready" : "available", release, checkedAt: Date.now() });
    } catch (error) {
      const offline = error instanceof Error && error.name === "AbortError";
      set({ phase: "error", error: offline ? "Keine Verbindung zu GitHub." : error instanceof Error ? error.message : "Prüfen hat nicht geklappt.", checkedAt: Date.now() });
    }
  },

  async download() {
    const release = get().release;
    const phase = get().phase;
    if (!release || phase === "downloading" || phase === "verifying") return;
    set({ phase: "downloading", error: null, progress: null });
    const file = apkFile(release);
    try {
      if (file.exists) file.delete();
      const running = File.createDownloadTask(release.url, file, {
        onProgress: ({ bytesWritten, totalBytes }) => {
          // GitHub's CDN sometimes sends no length; the manifest knows the size anyway.
          const total = totalBytes > 0 ? totalBytes : release.size;
          set({ progress: Math.min(1, bytesWritten / total) });
        },
      });
      task = running;
      const saved = await running.downloadAsync();
      task = null;
      if (!saved) throw new Error("Der Download wurde angehalten.");
      set({ phase: "verifying", progress: 1 });
      if (!(await matches(saved, release))) {
        saved.delete();
        throw new Error("Die heruntergeladene Datei stimmt nicht mit GitHub überein und wurde gelöscht.");
      }
      downloaded = saved;
      set({ phase: "ready", progress: null });
    } catch (error) {
      const cancelled = task === null && get().phase === "available";
      task = null;
      // `cancelDownload` already put the state back; its rejection is not an error to show.
      if (!cancelled) set({ phase: "error", progress: null, error: error instanceof Error && error.message ? error.message : "Der Download hat nicht geklappt." });
    }
  },

  cancelDownload() {
    const running = task;
    if (!running || get().phase !== "downloading") return;
    task = null;
    set({ phase: "available", progress: null, error: null });
    running.cancel();
    const release = get().release;
    if (release) {
      try {
        const partial = apkFile(release);
        if (partial.exists) partial.delete();
      } catch {
        // Half a file in the cache harms nothing; the next download replaces it.
      }
    }
  },

  install() {
    if (!NovaBridge || !downloaded) {
      set({ phase: "error", error: "Diese Version der App kann Updates noch nicht selbst installieren. Lade sie einmal über den QR-Code am PC." });
      return "failed";
    }
    if (!NovaBridge.canInstallUpdates()) {
      // Android's own page: "Allow from this source". The user comes back and taps again.
      NovaBridge.openInstallPermission();
      set({ error: "Erlaube NOVA Companion in den Einstellungen, Apps zu installieren, und tippe dann noch einmal auf „Installieren“." });
      return "permission";
    }
    try {
      NovaBridge.installApk(downloaded.contentUri);
      set({ error: null });
      return "started";
    } catch (error) {
      set({ phase: "error", error: error instanceof Error ? error.message : "Android hat die Installation nicht gestartet." });
      return "failed";
    }
  },
}));
