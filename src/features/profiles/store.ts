import { Briefcase, Gamepad2, type LucideIcon, Minimize2, Palette, User } from "lucide-react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { type AccentSetting, isAccentSetting } from "@/design/accent";
import { useDashboard } from "@/features/dashboard/store";
import { notify } from "@/features/notifications/store";
import { nativeStorage } from "@/lib/persistence";
import { useSettings } from "@/stores/settings";
import type { WidgetInstance } from "@/widgets/types";

export type ProfileKind = "gaming" | "productivity" | "creative" | "minimal" | "custom";

export interface WorkspaceProfile {
  id: string;
  name: string;
  kind: ProfileKind;
  /** Dashboard layout the profile switches to; created on first use for presets. */
  layoutId: string | null;
  accent: AccentSetting;
  transparency: boolean;
  sidebarCollapsed: boolean;
  wallpaperBackdrop: boolean;
}

export const PROFILE_ICONS: Record<ProfileKind, LucideIcon> = {
  gaming: Gamepad2,
  productivity: Briefcase,
  creative: Palette,
  minimal: Minimize2,
  custom: User,
};

type Template = Omit<WidgetInstance, "instanceId">[];
const w = (widgetId: string, width: number, height: number, config: Record<string, unknown> = {}) => ({ widgetId, w: width, h: height, config });

/** Starting layouts for the built-in profiles. */
export const PRESET_LAYOUTS: Record<Exclude<ProfileKind, "custom">, Template> = {
  gaming: [w("gpu", 4, 3), w("cpu", 4, 3), w("memory", 4, 3), w("network", 6, 3), w("music", 6, 2), w("storage", 6, 2)],
  productivity: [w("welcome", 8, 2), w("calendar", 4, 4), w("tasks", 4, 3), w("weather", 4, 3), w("quick-launch", 8, 2), w("news", 4, 3), w("progress", 4, 2)],
  creative: [w("music", 6, 2), w("quick-launch", 6, 2), w("clock", 4, 2), w("calendar", 4, 4), w("progress", 4, 2), w("tasks", 4, 3)],
  minimal: [w("welcome", 12, 2, { showPulse: false }), w("calendar", 6, 4), w("tasks", 6, 4, { showQuickAdd: false })],
};

const PRESETS: WorkspaceProfile[] = [
  { id: "preset-gaming", name: "Gaming", kind: "gaming", layoutId: null, accent: { kind: "preset", id: "emerald" }, transparency: true, sidebarCollapsed: true, wallpaperBackdrop: true },
  { id: "preset-productivity", name: "Productivity", kind: "productivity", layoutId: null, accent: { kind: "preset", id: "blue" }, transparency: true, sidebarCollapsed: false, wallpaperBackdrop: true },
  { id: "preset-creative", name: "Creative", kind: "creative", layoutId: null, accent: { kind: "preset", id: "amber" }, transparency: true, sidebarCollapsed: false, wallpaperBackdrop: true },
  { id: "preset-minimal", name: "Minimal", kind: "minimal", layoutId: null, accent: { kind: "preset", id: "purple" }, transparency: false, sidebarCollapsed: true, wallpaperBackdrop: false },
];

interface ProfilesState {
  profiles: WorkspaceProfile[];
  activeId: string | null;
  apply: (id: string) => void;
  saveCurrentAs: (name: string) => string;
  updateFromCurrent: (id: string) => void;
  remove: (id: string) => void;
}

function currentSnapshot(): Omit<WorkspaceProfile, "id" | "name" | "kind"> {
  const s = useSettings.getState();
  return {
    layoutId: useDashboard.getState().activeId || null,
    accent: s.accent,
    transparency: s.transparency,
    sidebarCollapsed: s.sidebarCollapsed,
    wallpaperBackdrop: s.wallpaperBackdrop,
  };
}

/** Animates a state change with the View Transitions API where available. */
function transition(run: () => void) {
  const reduced = document.documentElement.dataset.motion === "reduced" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !reduced) doc.startViewTransition(run);
  else run();
}

export function sanitizeProfiles(raw: unknown): WorkspaceProfile[] {
  if (!Array.isArray(raw)) return PRESETS;
  const kinds: ProfileKind[] = ["gaming", "productivity", "creative", "minimal", "custom"];
  const valid = raw.filter(
    (p): p is WorkspaceProfile =>
      typeof p?.id === "string" &&
      typeof p?.name === "string" &&
      kinds.includes(p?.kind) &&
      (p.layoutId === null || typeof p.layoutId === "string") &&
      isAccentSetting(p.accent) &&
      typeof p.transparency === "boolean" &&
      typeof p.sidebarCollapsed === "boolean",
  );
  // Presets are always present, even if a stored list lost one.
  const missing = PRESETS.filter((preset) => !valid.some((p) => p.id === preset.id));
  return [...missing, ...valid].map((p) => ({ ...p, wallpaperBackdrop: p.wallpaperBackdrop !== false }));
}

export const useProfiles = create<ProfilesState>()(
  persist(
    (set, get) => ({
      profiles: PRESETS,
      activeId: null,

      apply: (id) => {
        const profile = get().profiles.find((p) => p.id === id);
        if (!profile) return;
        const dashboard = useDashboard.getState();
        let layoutId = profile.layoutId;
        if (!layoutId || !dashboard.layouts.some((l) => l.id === layoutId)) {
          const template = profile.kind === "custom" ? PRESET_LAYOUTS.productivity : PRESET_LAYOUTS[profile.kind];
          layoutId = dashboard.importLayout(profile.name, template);
          set({ profiles: get().profiles.map((p) => (p.id === id ? { ...p, layoutId } : p)) });
        }
        const targetLayout = layoutId;
        transition(() => {
          useDashboard.getState().setActive(targetLayout);
          const settings = useSettings.getState();
          settings.setAccent(profile.accent);
          settings.setTransparency(profile.transparency);
          settings.setSidebarCollapsed(profile.sidebarCollapsed);
          settings.setWallpaperBackdrop(profile.wallpaperBackdrop);
        });
        set({ activeId: id });
        notify(`Switched to ${profile.name}`, { kind: "success" });
      },

      saveCurrentAs: (name) => {
        const profile: WorkspaceProfile = { id: crypto.randomUUID(), name: name.trim().slice(0, 40) || "My profile", kind: "custom", ...currentSnapshot() };
        set({ profiles: [...get().profiles, profile], activeId: profile.id });
        notify(`Saved “${profile.name}”`, { kind: "success", body: "It remembers your current layout, accent and appearance." });
        return profile.id;
      },

      updateFromCurrent: (id) => {
        set({ profiles: get().profiles.map((p) => (p.id === id ? { ...p, ...currentSnapshot() } : p)), activeId: id });
        notify("Profile updated", { kind: "success" });
      },

      remove: (id) => {
        const profile = get().profiles.find((p) => p.id === id);
        if (!profile || profile.kind !== "custom") return;
        set({ profiles: get().profiles.filter((p) => p.id !== id), activeId: get().activeId === id ? null : get().activeId });
      },
    }),
    {
      name: "nova.profiles",
      storage: createJSONStorage(() => nativeStorage),
      partialize: (s) => ({ profiles: s.profiles, activeId: s.activeId }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as { profiles?: unknown; activeId?: unknown };
        const profiles = sanitizeProfiles(p.profiles);
        const activeId = typeof p.activeId === "string" && profiles.some((x) => x.id === p.activeId) ? p.activeId : null;
        return { ...current, profiles, activeId };
      },
    },
  ),
);
