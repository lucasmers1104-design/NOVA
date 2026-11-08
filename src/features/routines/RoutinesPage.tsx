import { listen } from "@tauri-apps/api/event";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, CalendarClock, Eye, Play, Plus, Trash2, Workflow } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { Button, IconButton } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { agentStatus, configureAgent } from "@/features/nova-assistant/api";
import type { AgentStatus } from "@/features/nova-assistant/types";
import { notifyError } from "@/features/notifications/store";
import { callNative, isDesktop } from "@/lib/native";
import { useSettings } from "@/stores/settings";
import { clockTime } from "@/features/productivity/model";
import { uiLocale } from "@/lib/time";

/** Mirrors `Automation` in src-tauri/src/agent/auto.rs. */
interface Step {
  tool: string;
  input: Record<string, unknown> | null;
}
interface Routine {
  id: string;
  name: string;
  steps: Step[];
  prompt: string | null;
  time: string | null;
  days: number[];
}
type Condition =
  | { type: "gameReady" | "gameUpdate"; game: string }
  | { type: "cpuAbove" | "memoryAbove"; percent: number }
  | { type: "temperatureAbove"; celsius: number }
  | { type: "diskBelow"; gigabytes: number }
  | { type: "programStarts" | "programEnds"; program: string }
  | { type: "downloadsDone" }
  | { type: "newVideo"; channel: string }
  | { type: "aiCheck"; question: string; callsLeft: number };
interface Watcher {
  id: string;
  say: string;
  condition: Condition;
  repeat: boolean;
  routine: string | null;
}
interface Automation {
  routines: Routine[];
  watchers: Watcher[];
}
interface Note {
  id: string;
  text: string;
}

const AUTOMATION_KEY = ["automation"] as const;
const MEMORY_KEY = ["memory"] as const;
const AGENT_KEY = ["routines", "agent"] as const;
const CHANGED_EVENT = "automation://changed";

const STEP_LABELS: Record<string, string> = {
  open_app: "Open",
  open_website: "Open",
  start_game: "Start",
  media_control: "Sound",
  spotify_play: "Spotify",
  youtube: "YouTube",
  app_volume: "Volume",
  audio_output: "Output",
  timer: "Timer",
  window_action: "Window",
  end_process: "Close",
  power: "PC",
  wait: "Wait",
};

/** One step in a few words: "Open Discord", "Volume discord 30". */
export function stepText(step: Step): string {
  const values = Object.values(step.input ?? {}).map((value) => (typeof value === "string" || typeof value === "number" ? String(value) : ""));
  return [STEP_LABELS[step.tool] ?? step.tool, ...values.filter(Boolean)].join(" ");
}

/** What a watcher is waiting for. */
export function conditionText(condition: Condition): string {
  switch (condition.type) {
    case "gameReady":
      return `${condition.game} has finished downloading`;
    case "gameUpdate":
      return `${condition.game} needs an update`;
    case "cpuAbove":
      return `CPU load stays over ${Math.round(condition.percent)} %`;
    case "memoryAbove":
      return `Memory stays over ${Math.round(condition.percent)} %`;
    case "temperatureAbove":
      return `It gets hotter than ${Math.round(condition.celsius)} °C`;
    case "diskBelow":
      return `Less than ${Math.round(condition.gigabytes)} GB free`;
    case "programStarts":
      return `${condition.program} starts`;
    case "programEnds":
      return `${condition.program} ends`;
    case "downloadsDone":
      return "Your browser's downloads are finished";
    case "newVideo":
      return `${condition.channel} has a new video`;
    case "aiCheck":
      return `NOVA checks for your phone: ${condition.question} (${condition.callsLeft} checks left)`;
  }
}

/** "Mon, Wed at 08:00", "every day at 2:30 PM". */
export function scheduleText(routine: Pick<Routine, "time" | "days">, use24Hour: boolean, locale: string): string | null {
  if (!routine.time) return null;
  const names = [0, 1, 2, 3, 4, 5, 6].map((day) => new Date(2023, 0, 1 + day).toLocaleDateString(locale, { weekday: "short" }));
  const days = routine.days.length === 0 || routine.days.length === 7 ? "Every day" : routine.days.map((day) => names[day]).join(", ");
  return `${days} at ${clockTime(routine.time, use24Hour, locale)}`;
}

function Section({ icon, title, hint, action, children }: { icon: ReactNode; title: string; hint: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="glass rounded-widget p-5">
      <header className="mb-3 flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[11px] accent-soft text-accent-text">{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
          <p className="text-[12.5px] leading-snug text-fg-muted">{hint}</p>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-[12px] border border-dashed border-line px-3.5 py-3 text-[12.5px] leading-relaxed text-fg-muted">{children}</p>;
}

export default function RoutinesPage() {
  const client = useQueryClient();
  const use24Hour = useSettings((s) => s.use24HourClock);
  const automation = useQuery({ queryKey: AUTOMATION_KEY, queryFn: () => callNative<Automation>("automation_list") });
  const notes = useQuery({ queryKey: MEMORY_KEY, queryFn: () => callNative<Note[]>("memory_list") });
  const agent = useQuery({ queryKey: AGENT_KEY, queryFn: agentStatus });
  const [note, setNote] = useState("");

  // NOVA saves these from a conversation in another window.
  useEffect(() => {
    if (!isDesktop()) return;
    const stop = listen(CHANGED_EVENT, () => {
      void client.invalidateQueries({ queryKey: AUTOMATION_KEY });
      void client.invalidateQueries({ queryKey: MEMORY_KEY });
    });
    return () => void stop.then((unlisten) => unlisten());
  }, [client]);

  const run = useMutation({ mutationFn: (id: string) => callNative<void>("automation_run", { id }), onError: (error) => notifyError("The routine didn't run", error) });
  const deleteRoutine = useMutation({ mutationFn: (id: string) => callNative<void>("automation_delete_routine", { id }), onError: (error) => notifyError("Couldn't delete it", error) });
  const stopWatcher = useMutation({ mutationFn: (id: string) => callNative<void>("automation_delete_watcher", { id }), onError: (error) => notifyError("Couldn't stop it", error) });
  const deleteNote = useMutation({ mutationFn: (id: string) => callNative<void>("memory_delete", { id }), onError: (error) => notifyError("Couldn't delete it", error) });
  const addNote = useMutation({ mutationFn: (text: string) => callNative<Note>("memory_add", { text }), onSuccess: () => setNote(""), onError: (error) => notifyError("Couldn't save it", error) });
  const setMemory = useMutation({
    // Fresh: auto mode or the voice may have changed in NOVA's window since this page asked.
    mutationFn: async (memory: boolean) => configureAgent({ ...(await agentStatus()).prefs, memory }),
    onSuccess: (status: AgentStatus) => client.setQueryData(AGENT_KEY, status),
    onError: (error) => notifyError("Couldn't change it", error),
  });

  const submitNote = (event: FormEvent) => {
    event.preventDefault();
    if (note.trim()) addNote.mutate(note);
  };
  const routines = automation.data?.routines ?? [];
  const watchers = automation.data?.watchers ?? [];
  const remembered = notes.data ?? [];
  const memoryOn = agent.data?.prefs.memory ?? true;

  return (
    <Page>
      <PageHeader title="Routines" description="What NOVA does by itself. Just tell NOVA what you want, and everything it sets up shows here." />
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-4 xl:col-span-2">
          <Section icon={<Workflow size={17} aria-hidden />} title="Routines" hint="Several steps on one word, or at a set time.">
            {routines.length === 0 ? (
              <Empty>Nothing here yet. Try telling NOVA: “Mach mir einen Gaming-Modus: schließ Chrome, stell Discord auf 30 Prozent und starte Fortnite”, or “Sag mir jeden Morgen um 8 das Wetter und meine Aufgaben”.</Empty>
            ) : (
              <ul className="space-y-2">
                {routines.map((routine) => {
                  const when = scheduleText(routine, use24Hour, uiLocale());
                  return (
                    <li key={routine.id} className="flex items-start gap-3 rounded-[12px] border border-line bg-white/[0.025] p-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-[13.5px] font-medium text-fg">{routine.name}</p>
                        {when && (
                          <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-accent-text">
                            <CalendarClock size={12} aria-hidden /> {when}
                          </p>
                        )}
                        <ul className="mt-1.5 flex flex-wrap gap-1">
                          {routine.steps.map((step, index) => (
                            <li key={index} className="rounded-full bg-white/[0.055] px-2 py-0.5 text-[11.5px] text-fg-muted">
                              {stepText(step)}
                            </li>
                          ))}
                        </ul>
                        {routine.prompt && <p className="mt-1.5 text-[12px] leading-snug text-fg-muted italic">“{routine.prompt}”</p>}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button size="sm" variant="secondary" icon={<Play size={13} aria-hidden />} disabled={run.isPending} onClick={() => run.mutate(routine.id)}>
                          Run
                        </Button>
                        <IconButton label={`Delete ${routine.name}`} size="sm" onClick={() => deleteRoutine.mutate(routine.id)}>
                          <Trash2 size={14} aria-hidden />
                        </IconButton>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        </div>

        <Section icon={<Eye size={17} aria-hidden />} title="Keeping an eye on" hint="NOVA speaks up when it happens, also during a game, as long as it's running.">
          {watchers.length === 0 ? (
            <Empty>Nothing right now. Try: “Sag mir, wenn der Download von Fortnite fertig ist”, “wenn MrBeast ein neues Video hat” or “wenn der Speicher voll wird”.</Empty>
          ) : (
            <ul className="space-y-2">
              {watchers.map((watcher) => (
                <li key={watcher.id} className="flex items-center gap-3 rounded-[12px] border border-line bg-white/[0.025] p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-fg">{conditionText(watcher.condition)}</p>
                    <p className="truncate text-[12px] text-fg-muted" title={watcher.say}>
                      “{watcher.say}”{watcher.repeat ? " · every time" : ""}
                      {watcher.routine ? ` · runs ${watcher.routine}` : ""}
                    </p>
                  </div>
                  <IconButton label="Stop watching this" size="sm" onClick={() => stopWatcher.mutate(watcher.id)}>
                    <Trash2 size={14} aria-hidden />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          icon={<Brain size={17} aria-hidden />}
          title="What NOVA remembers"
          hint="Kept on this PC, and sent to your AI provider with each new conversation."
          action={<Switch label="NOVA remembers things" checked={memoryOn} disabled={!agent.data} onChange={(on) => setMemory.mutate(on)} />}
        >
          {memoryOn && (
            <form onSubmit={submitNote} className="mb-2 flex gap-2">
              <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={300} placeholder="Add something, e.g. “Mein Hauptspiel ist Fortnite”" aria-label="Something for NOVA to remember" className="h-9 min-w-0 flex-1 rounded-[10px] border border-line bg-white/[0.04] px-3 text-[13px] text-fg outline-none placeholder:text-fg-subtle focus:border-accent/60" />
              <Button size="sm" variant="secondary" type="submit" icon={<Plus size={13} aria-hidden />} disabled={!note.trim() || addNote.isPending}>
                Add
              </Button>
            </form>
          )}
          {remembered.length === 0 ? (
            <Empty>{memoryOn ? "Nothing yet. Tell NOVA “Merk dir, dass …”, and it shows up here." : "Memory is off. NOVA doesn't save anything new, and what's listed isn't used."}</Empty>
          ) : (
            <ul className="space-y-1">
              {remembered.map((entry) => (
                <li key={entry.id} className="group flex items-center gap-2 rounded-[10px] px-2 py-1.5 hover:bg-white/[0.04]">
                  <span className="min-w-0 flex-1 text-[13px] leading-snug text-fg select-text">{entry.text}</span>
                  <IconButton label={`Forget: ${entry.text}`} size="sm" onClick={() => deleteNote.mutate(entry.id)}>
                    <Trash2 size={14} aria-hidden />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </Page>
  );
}
