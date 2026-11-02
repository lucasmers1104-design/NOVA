import { useId } from "react";
import { cn } from "@/lib/cn";

/** The NOVA sparkle, tinted by the active accent. */
export function NovaMark({ size = 32, className }: { size?: number; className?: string }) {
  const gradientId = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={cn("shrink-0", className)}>
      <defs>
        <linearGradient id={gradientId} x1="0.15" y1="0.1" x2="0.85" y2="0.9">
          {/* CSS variables only resolve via style, not SVG presentation attributes. */}
          <stop offset="0" style={{ stopColor: "var(--nova-accent-text)" }} />
          <stop offset="0.55" style={{ stopColor: "var(--nova-accent)" }} />
          <stop offset="1" style={{ stopColor: "var(--nova-accent-secondary)" }} />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="31" height="31" rx="9" fill="rgb(255 255 255 / 0.04)" stroke="rgb(255 255 255 / 0.1)" />
      <path d="M16 5.5 Q17.2 14.8 26.5 16 Q17.2 17.2 16 26.5 Q14.8 17.2 5.5 16 Q14.8 14.8 16 5.5 Z" fill={`url(#${gradientId})`} />
      <path d="M23.2 6.6 Q23.5 8.5 25.4 8.8 Q23.5 9.1 23.2 11 Q22.9 9.1 21 8.8 Q22.9 8.5 23.2 6.6 Z" fill="#ece8ff" opacity="0.85" />
    </svg>
  );
}
