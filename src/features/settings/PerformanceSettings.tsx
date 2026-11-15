import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLines, Gauge, MemoryStick, Recycle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SettingCard, SettingLine, SliderRow } from "@/components/settings-kit";
import { Switch } from "@/components/ui/Switch";
import { notifyError } from "@/features/notifications/store";
import { cn } from "@/lib/cn";
import { callNative, isDesktop } from "@/lib/native";
import { useUi } from "@/stores/ui";
import { SettingsNotice, SettingsSection } from "./SettingsLayout";

/** Mirrors `PerformancePrefs` in src-tauri/src/performance.rs. */
export interface PerformancePrefs {
  releaseMainWindow: boolean;
  /** 0 keeps the panel for good. */
  panelIdleMinutes: number;
}

/** Mirrors `PerformanceStatus`. */
export interface PerformanceStatus {
  prefs: PerformancePrefs;
  timings: { mainReopenMs: number | null; panelOpenMs: number | null };
}

export type MemoryPart = "nova" | "speech" | "webView" | "other";

/** Mirrors `MemoryReport`: NOVA as Task Manager would have to add it up. */
export interface MemoryReport {
  privateBytes: number;
  workingBytes: number;
  processes: number;
  parts: { part: MemoryPart; processes: number; privateBytes: number; workingBytes: number }[];
}

const STATUS_KEY = ["performance", "status"];
const MEMORY_KEY = ["performance", "memory"];
/** Adding up every process costs a little each time: often enough to watch, no more. */
export const MEMORY_POLL_MS = 2000;
const PANEL_IDLE_DEFAULT = 5;
/** A slider being dragged is saved once the hand rests. */
const SAVE_AFTER_MS = 300;

const PARTS: Record<MemoryPart, { label: string; hint: string; color: string }> = {
  nova: { label: "NOVA", hint: "nova.exe selbst", color: "bg-accent" },
  speech: { label: "Sprache", hint: "Stimme und Spracherkennung in eigenen Prozessen", color: "bg-success" },
  webView: { label: "Oberfläche", hint: "WebView2 zeichnet NOVAs Fenster", color: "bg-fg-muted" },
  other: { label: "Sonstiges", hint: "was NOVA sonst gestartet hat", color: "bg-fg-subtle" },
};

/** "356 MB", or "1,12 GB" from a gigabyte on. */
export function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GB` : `${Math.round(mb).toLocaleString("de-DE")} MB`;
}

const processes = (count: number) => (count === 1 ? "1 Prozess" : `${count} Prozesse`);

function MemoryReadout({ report }: { report: MemoryReport }) {
  return (
    <div className="space-y-3">
      <p className="flex items-baseline gap-2" aria-live="off">
        <span className="text-[28px] leading-none font-semibold text-fg tabular-nums">{megabytes(report.privateBytes)}</span>
        <span className="text-[12px] text-fg-muted">
          in {processes(report.processes)} · davon gerade im RAM: {megabytes(report.workingBytes)}
        </span>
      </p>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-white/[0.07]" role="img" aria-label={report.parts.map((p) => `${PARTS[p.part].label} ${megabytes(p.privateBytes)}`).join(", ")}>
        {report.parts.map((p) => (
          <div key={p.part} className={cn("h-full transition-[width] duration-500", PARTS[p.part].color)} style={{ width: `${report.privateBytes > 0 ? (p.privateBytes / report.privateBytes) * 100 : 0}%` }} />
        ))}
      </div>
      <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {report.parts.map((p) => (
          <li key={p.part} className="flex items-baseline gap-2 text-[12.5px]">
            <span className={cn("size-2 shrink-0 translate-y-[-1px] rounded-full", PARTS[p.part].color)} aria-hidden />
            <span className="min-w-0 flex-1 truncate text-fg" title={PARTS[p.part].hint}>
              {PARTS[p.part].label}
              <span className="text-fg-subtle"> · {processes(p.processes)}</span>
            </span>
            <span className="shrink-0 font-medium text-fg tabular-nums">{megabytes(p.privateBytes)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** How much memory NOVA uses right now, and what it gives back to Windows while nobody looks. */
export function PerformanceSettings() {
  const client = useQueryClient();
  const desktop = isDesktop();
  const { data: status } = useQuery({ queryKey: STATUS_KEY, queryFn: () => callNative<PerformanceStatus>("performance_status"), enabled: desktop });
  // Only while this section is on screen: the query ends with the component, and it
  // rests while the window is hidden or minimized (the page isn't visible then).
  const { data: memory } = useQuery({
    queryKey: MEMORY_KEY,
    queryFn: () => callNative<MemoryReport>("performance_memory"),
    enabled: desktop,
    refetchInterval: MEMORY_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: MEMORY_POLL_MS,
    gcTime: 0,
  });
  // What the controls show until Rust has answered: they must follow the hand, not the answer.
  const [draft, setDraft] = useState<PerformancePrefs | null>(null);
  // What a dragged slider will save once it rests.
  const unsaved = useRef<{ prefs: PerformancePrefs; timer: number } | null>(null);
  const configure = useMutation({
    mutationFn: (prefs: PerformancePrefs) => callNative<PerformanceStatus>("performance_configure", { prefs }),
    onSuccess: (data) => client.setQueryData(STATUS_KEY, data),
    onError: (error) => notifyError("Das ließ sich nicht speichern", error),
    onSettled: () => {
      if (!unsaved.current) setDraft(null);
    },
  });
  const save = (prefs: PerformancePrefs, wait = 0) => {
    setDraft(prefs);
    if (unsaved.current) window.clearTimeout(unsaved.current.timer);
    const timer = window.setTimeout(() => {
      unsaved.current = null;
      configure.mutate(prefs);
    }, wait);
    unsaved.current = { prefs, timer };
  };
  // Leaving the page while a change still waits saves it now.
  useEffect(
    () => () => {
      if (!unsaved.current) return;
      window.clearTimeout(unsaved.current.timer);
      void callNative("performance_configure", { prefs: unsaved.current.prefs }).catch(() => {});
    },
    [],
  );

  const title = "Leistung";
  const description = "Was NOVA an Arbeitsspeicher braucht – und was es Windows zurückgibt, solange du es nicht siehst.";
  if (!desktop) {
    return (
      <SettingsSection id="performance" title={title} description={description} icon={Gauge}>
        <SettingsNotice>Das gibt es in der NOVA-Desktop-App.</SettingsNotice>
      </SettingsSection>
    );
  }
  if (!status) return null;
  const { timings } = status;
  const prefs = draft ?? status.prefs;
  const speech = memory?.parts.find((p) => p.part === "speech");

  return (
    <SettingsSection id="performance" title={title} description={description} icon={Gauge}>
      <SettingCard title="Arbeitsspeicher" description="Jetzt gerade, alle zwei Sekunden neu gemessen, solange du diese Seite siehst." icon={MemoryStick}>
        <SettingLine
          label="Arbeitsspeicher"
          stacked
          description="Privater Speicher von nova.exe, seinen Sprach-Prozessen und den WebView2-Prozessen seiner Fenster – das, was Windows zurückbekommt, wenn NOVA endet."
        >
          {memory ? <MemoryReadout report={memory} /> : <p className="text-[12.5px] text-fg-muted">Wird gemessen …</p>}
        </SettingLine>
      </SettingCard>

      <SettingCard title="Speicher freigeben" description="Fenster, die niemand sieht, müssen nicht im Speicher bleiben." icon={Recycle}>
        <SettingLine
          label="Hauptfenster beim Schließen freigeben"
          description={
            <>
              Schließt du NOVA in den Infobereich, endet das Fenster ganz, statt nur versteckt zu werden. Beim Öffnen ist es wieder da, wo du warst; Erinnerungen kommen weiterhin.
              {timings.mainReopenMs !== null && <span className="block text-fg-subtle">Zuletzt wieder da nach {timings.mainReopenMs.toLocaleString("de-DE")} ms.</span>}
            </>
          }
        >
          <Switch label="Hauptfenster beim Schließen freigeben" checked={prefs.releaseMainWindow} onChange={(releaseMainWindow) => save({ ...prefs, releaseMainWindow })} />
        </SettingLine>
        <SliderRow
          label="NOVA-AI-Fenster freigeben nach"
          description={`So lange bleibt das geschlossene NOVA-AI-Fenster im Speicher. Die Unterhaltung ist danach wieder da.${timings.panelOpenMs !== null ? ` Zuletzt neu geöffnet in ${timings.panelOpenMs.toLocaleString("de-DE")} ms.` : ""}`}
          value={prefs.panelIdleMinutes}
          min={0}
          max={60}
          defaultValue={PANEL_IDLE_DEFAULT}
          format={(minutes) => (minutes === 0 ? "Nie" : `${minutes} min`)}
          onChange={(panelIdleMinutes) => save({ ...prefs, panelIdleMinutes }, SAVE_AFTER_MS)}
        />
      </SettingCard>

      <SettingCard title="Sprache" description="NOVAs Stimmen und die Offline-Spracherkennung laufen in eigenen Prozessen, die sich nach einer Pause beenden." icon={AudioLines}>
        <SettingLine
          label="Sprach-Prozesse"
          description={
            <>
              {speech ? `Gerade geladen: ${megabytes(speech.privateBytes)} in ${processes(speech.processes)}.` : "Gerade ist nichts geladen."} Die Stimme bleibt nach dem letzten Satz 20 Minuten, die Erkennung 5 Minuten (im
              Sparmodus 2 Minuten und 20 Sekunden). Hört „Hey NOVA“ mit der Offline-Erkennung zu, bleibt sie geladen – rund 700 MB.
            </>
          }
        >
          <button type="button" className="text-[12.5px] font-medium text-accent-text hover:underline" onClick={() => useUi.getState().openSettings("local-ai")}>
            Modus ändern
          </button>
        </SettingLine>
      </SettingCard>
    </SettingsSection>
  );
}
