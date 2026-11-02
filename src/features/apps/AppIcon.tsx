import { cn } from "@/lib/cn";
import { useAppIcon } from "./api";

/** The app's real Windows icon, with a monogram while loading or when none exists. */
export function AppIcon({ id, name, size = 40, className }: { id: string; name: string; size?: number; className?: string }) {
  const { data: src } = useAppIcon(id);
  const style = { width: size, height: size };
  if (src) {
    return <img src={src} alt="" draggable={false} style={style} className={cn("shrink-0 object-contain", className)} />;
  }
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();
  return (
    <span
      aria-hidden
      style={style}
      className={cn("accent-gradient flex shrink-0 items-center justify-center rounded-[28%] text-[13px] font-semibold text-on-accent", className)}
    >
      {initials || "?"}
    </span>
  );
}
