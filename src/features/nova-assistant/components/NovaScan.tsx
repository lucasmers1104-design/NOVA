import { ShieldAlert, ShieldCheck, ShieldQuestion, X } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { cancelScan, dismissScan, elapsedLabel, openWindowsSecurity, type ScanStatus, useScan } from "../scan";

const WORDS = {
  de: {
    running: (kind: ScanStatus["kind"]) => (kind === "full" ? "Vollständiger Virenscan läuft" : "Schneller Virenscan läuft"),
    note: (kind: ScanStatus["kind"]) => (kind === "full" ? "Kann Stunden dauern. Du kannst normal weitermachen." : "Dauert ein paar Minuten. Du kannst normal weitermachen."),
    cancel: "Scan abbrechen",
    clean: "Alles sauber",
    cleanNote: "Windows Defender hat nichts gefunden.",
    threats: (count: number) => (count === 1 ? "1 Bedrohung gefunden" : `${count} Bedrohungen gefunden`),
    failed: "Der Scan konnte nicht laufen",
    details: "Details ansehen",
    close: "Schließen",
  },
  en: {
    running: (kind: ScanStatus["kind"]) => (kind === "full" ? "Full virus scan running" : "Quick virus scan running"),
    note: (kind: ScanStatus["kind"]) => (kind === "full" ? "This can take hours. You can carry on as usual." : "This takes a few minutes. You can carry on as usual."),
    cancel: "Cancel the scan",
    clean: "All clean",
    cleanNote: "Windows Defender found nothing.",
    threats: (count: number) => (count === 1 ? "1 threat found" : `${count} threats found`),
    failed: "The scan couldn't run",
    details: "See details",
    close: "Close",
  },
};

/** The radar: a beam sweeping over a shield, with rings going out from it. */
function ScanRadar() {
  return (
    <span aria-hidden className="nova-scan-radar">
      <span className="nova-scan-ring" />
      <span className="nova-scan-ring nova-scan-ring-late" />
      <span className="nova-scan-beam" />
      <ShieldCheck size={15} className="relative text-accent-text" />
    </span>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="text-[11.5px] text-fg-subtle tabular-nums">{elapsedLabel(now - since)}</span>;
}

/** A virus scan in the panel: running with its radar, then what came of it. */
export function NovaScan({ german }: { german: boolean }) {
  const { status, dismissed } = useScan();
  const words = WORDS[german ? "de" : "en"];
  if (status.state === "idle" || status.state === "cancelled" || (dismissed && status.state !== "running")) return null;

  if (status.state === "running") {
    return (
      <div role="status" aria-label={words.running(status.kind)} className="mx-3 mb-1.5 flex items-center gap-3 rounded-[16px] bg-white/[0.055] py-2 pr-1.5 pl-2.5 ring-1 ring-accent/30">
        <ScanRadar />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[12.5px] font-medium text-fg">{words.running(status.kind)}</span>
            <Elapsed since={status.startedAt} />
          </span>
          <span className="block truncate text-[11.5px] text-fg-muted">{words.note(status.kind)}</span>
        </span>
        <button
          type="button"
          aria-label={words.cancel}
          title={words.cancel}
          onClick={() => void cancelScan()}
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-white/[0.08] hover:text-fg"
        >
          <X size={14} aria-hidden />
        </button>
      </div>
    );
  }

  const threats = status.state === "threats";
  const clean = status.state === "clean";
  const Icon = clean ? ShieldCheck : threats ? ShieldAlert : ShieldQuestion;
  return (
    <motion.div
      role="status"
      initial={{ opacity: 0, y: 8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 420, damping: 30 }}
      className={cn("mx-3 mb-1.5 flex items-start gap-3 rounded-[16px] py-2 pr-1.5 pl-2.5 ring-1", clean ? "bg-success/[0.08] ring-success/30" : threats ? "bg-danger/[0.08] ring-danger/40" : "bg-warning/[0.07] ring-warning/30")}
    >
      <motion.span initial={{ scale: 0.4 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 500, damping: 16 }} className="mt-0.5 shrink-0">
        <Icon size={20} className={clean ? "text-success" : threats ? "text-danger" : "text-warning"} aria-hidden />
      </motion.span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] font-medium text-fg">{clean ? words.clean : threats ? words.threats(status.threats.length) : words.failed}</span>
        <span className="block text-[11.5px] leading-snug text-fg-muted">{clean ? words.cleanNote : threats ? status.threats.join(", ") : status.message}</span>
        {threats && (
          <button type="button" className="mt-0.5 text-[11.5px] font-medium text-accent-text hover:underline" onClick={() => void openWindowsSecurity()}>
            {words.details}
          </button>
        )}
      </span>
      <button type="button" aria-label={words.close} title={words.close} onClick={dismissScan} className="flex size-7 shrink-0 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-white/[0.08] hover:text-fg">
        <X size={14} aria-hidden />
      </button>
    </motion.div>
  );
}
