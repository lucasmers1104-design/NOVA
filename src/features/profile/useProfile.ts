import { useSystemInfo } from "@/features/system/api";
import { useSettings } from "@/stores/settings";

export interface Profile {
  fullName: string | null;
  firstName: string | null;
  initials: string;
}

export function profileFromName(name: string | null | undefined): Profile {
  const trimmed = name?.trim();
  if (!trimmed) return { fullName: null, firstName: null, initials: "N" };
  const parts = trimmed.split(/\s+/);
  const initials = ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase();
  return { fullName: trimmed, firstName: parts[0] ?? trimmed, initials: initials || "N" };
}

/** The user's display name: the Settings override, else the Windows account name. */
export function useProfile(): Profile {
  const override = useSettings((s) => s.displayName);
  const { data } = useSystemInfo();
  return profileFromName(override || data?.userName);
}
