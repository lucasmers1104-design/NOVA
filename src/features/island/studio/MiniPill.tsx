import type { CSSProperties } from "react";
import { islandTone, islandVariables } from "../look";
import type { PresetLook } from "../presets";

/**
 * A look in small: a closed pill drawn by the island's own CSS from the same
 * variables, so a preset's card shows what choosing it really gives.
 */
export function MiniPill({ look, width = 112 }: { look: PresetLook; width?: number }) {
  const height = Math.round(look.look.closedHeight * 0.74);
  return (
    <span
      aria-hidden
      className="island-stage"
      // The stage is sized for a window; here it only carries the variables.
      style={{ ...islandVariables(look), "--island-scale": 1, "--level": 0.7, width: "auto", height: "auto", padding: 0 } as CSSProperties}
    >
      <span className="island" data-theme={look.theme} data-tone={islandTone(look)} style={{ width, height, borderRadius: `calc(var(--island-radius) * 0.74)`, display: "flex", alignItems: "center", gap: 6, padding: "0 8px" }}>
        <i className="island-art island-art--empty" style={{ width: height - 10, height: height - 10, borderRadius: 4, background: "linear-gradient(135deg, var(--nova-accent), #22d3ee)" }} />
        <i style={{ flex: 1, height: 4, borderRadius: 4, background: "var(--muted)", opacity: 0.55 }} />
        <span className="island-bars" data-playing="true">
          {[0.62, 1, 0.78, 0.5].map((weight, i) => (
            <i key={i} style={{ "--w": weight } as CSSProperties} />
          ))}
        </span>
      </span>
    </span>
  );
}
