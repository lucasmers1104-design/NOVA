// How the PC's three risk levels read on the phone. The PC decides the level per
// tool call (src-tauri/src/agent/tools.rs); the phone only shows it.

import type { Risk } from "@nova/companion-protocol";
import type { IconName } from "./ui";
import type { TintName } from "./theme";

export interface RiskLook {
  /** 1 to 3, for the meter on the approval screen. */
  level: 1 | 2 | 3;
  /** For badges in lists. */
  short: string;
  title: string;
  /** What the level means for the user, in a sentence. */
  text: string;
  tint: TintName;
  icon: IconName;
}

export const RISK: Record<Risk, RiskLook> = {
  safe: { level: 1, short: "Geringes Risiko", title: "Geringes Risiko", text: "NOVA liest oder öffnet nur etwas. An deinen Dateien ändert sich nichts.", tint: "green", icon: "shield" },
  confirm: { level: 2, short: "Ändert etwas", title: "Ändert etwas auf deinem PC", text: "Danach ist etwas anders als vorher. Du kannst es am PC wieder zurücknehmen.", tint: "amber", icon: "info" },
  high: { level: 3, short: "Schwer rückgängig", title: "Schwer rückgängig zu machen", text: "Das lässt sich kaum oder gar nicht zurücknehmen. Gib es nur frei, wenn du diesen Auftrag gerade selbst gegeben hast.", tint: "red", icon: "alert" },
};
