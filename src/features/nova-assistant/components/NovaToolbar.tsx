import { History, Mic, TriangleAlert, Volume2, Zap } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { AgentPrefs } from "../types";

interface ChipProps {
  on?: boolean;
  danger?: boolean;
  label: string;
  title: string;
  icon: ReactNode;
  onClick: () => void;
}

function Chip({ on, danger, label, title, icon, onClick }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={cn(
        "flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-medium whitespace-nowrap transition-colors",
        on && danger && "bg-warning/20 text-warning ring-1 ring-warning/40",
        on && !danger && "accent-soft text-accent-text",
        !on && "bg-white/[0.045] text-fg-muted hover:bg-white/[0.09] hover:text-fg",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

interface NovaToolbarProps {
  prefs: AgentPrefs | null;
  german: boolean;
  onPrefs: (patch: Partial<AgentPrefs>) => void;
  onHistory: () => void;
}

/** What people switch while talking to NOVA, one click away. */
export function NovaToolbar({ prefs, german, onPrefs, onHistory }: NovaToolbarProps) {
  const [asking, setAsking] = useState(false);
  const auto = prefs?.autoMode ?? false;
  return (
    <div className="shrink-0 px-3 pb-1.5">
      <div role="toolbar" aria-label={german ? "Schnellzugriff" : "Quick settings"} className="flex items-center gap-1.5">
        <Chip
          on={auto}
          danger
          label={german ? "Auto-Modus" : "Auto mode"}
          title={auto ? (german ? "An: NOVA handelt, ohne zu fragen. Klicken zum Ausschalten." : "On: NOVA acts without asking. Click to turn off.") : german ? "NOVA handelt, ohne vorher zu fragen" : "NOVA acts without asking first"}
          icon={<Zap size={13} aria-hidden />}
          onClick={() => {
            if (auto) onPrefs({ autoMode: false });
            else setAsking((now) => !now);
          }}
        />
        <Chip
          on={prefs?.speakReplies}
          label={german ? "Vorlesen" : "Read aloud"}
          title={german ? "NOVA liest auch getippte Antworten vor" : "NOVA also reads replies to typed messages aloud"}
          icon={<Volume2 size={13} aria-hidden />}
          onClick={() => onPrefs({ speakReplies: !prefs?.speakReplies })}
        />
        <Chip
          on={prefs?.keepListening}
          label={german ? "Weiterhören" : "Keep listening"}
          title={german ? "Nach einer gesprochenen Antwort geht das Mikro wieder auf" : "The microphone opens again after a spoken reply"}
          icon={<Mic size={13} aria-hidden />}
          onClick={() => onPrefs({ keepListening: !prefs?.keepListening })}
        />
        <span className="flex-1" />
        <Chip label={german ? "Verlauf" : "History"} title={german ? "Was NOVA getan hat" : "What NOVA did"} icon={<History size={13} aria-hidden />} onClick={onHistory} />
      </div>
      <AnimatePresence initial={false}>
        {asking && !auto && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.16 }} className="overflow-hidden">
            <div role="alertdialog" aria-label={german ? "Auto-Modus einschalten?" : "Turn on auto mode?"} className="mt-1.5 rounded-[12px] border border-warning/35 bg-warning/[0.07] p-2.5">
              <p className="flex items-start gap-2 text-[11.5px] leading-snug text-fg-muted">
                <TriangleAlert size={13} className="mt-[1px] shrink-0 text-warning" aria-hidden />
                {german
                  ? "NOVA löscht, beendet und klickt dann, ohne zu fragen. Ein falsch verstandener Satz kann echten Schaden anrichten. Auf eigenes Risiko."
                  : "NOVA then deletes, ends programs and clicks without asking. A misheard sentence can do real damage. At your own risk."}
              </p>
              <div className="mt-2 flex gap-1.5">
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    setAsking(false);
                    onPrefs({ autoMode: true });
                  }}
                >
                  {german ? "Auf eigenes Risiko einschalten" : "Turn on at my own risk"}
                </Button>
                {/* Focus on the safe answer. */}
                <Button size="sm" variant="ghost" autoFocus onClick={() => setAsking(false)}>
                  {german ? "Abbrechen" : "Cancel"}
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
