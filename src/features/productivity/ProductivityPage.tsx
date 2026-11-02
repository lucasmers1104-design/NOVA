import { CalendarDays, CalendarRange, ChevronLeft, ChevronRight, CircleCheck, Inbox, ListTodo, Plus, StickyNote, Sun, Trash } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { Button, IconButton } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog } from "@/components/ui/Dialog";
import { Skeleton } from "@/components/ui/Skeleton";
import { buildMonthGrid, firstDayOfWeek, weekdayLabels } from "@/lib/calendar";
import { cn } from "@/lib/cn";
import { uiLocale, useNow } from "@/lib/time";
import { groupTasks, noteTitle, PROJECT_COLORS, searchTasks, type Task, toISODate } from "./model";
import { NotesView } from "./NotesView";
import { newProject, useProductivity } from "./store";
import { QuickAdd, TaskDialog, TaskRow } from "./TaskComponents";

type View = "today" | "upcoming" | "all" | "completed" | "notes" | "calendar" | `project:${string}`;

export default function ProductivityPage() {
  const status = useProductivity((s) => s.status);
  const error = useProductivity((s) => s.error);
  const load = useProductivity((s) => s.load);
  const [view, setView] = useState<View>("today");
  const [editing, setEditing] = useState<Task | null>(null);

  useEffect(() => {
    if (status === "idle") void load();
  }, [status, load]);

  return (
    <Page>
      <PageHeader title="Productivity" description="Tasks, projects and notes — stored on this PC." />
      {status === "error" ? (
        <div className="glass rounded-widget p-10 text-center">
          <p className="text-[14px] font-medium text-fg">Couldn't load your tasks</p>
          <p className="mt-1 text-[13px] text-fg-muted">{error}</p>
          <Button size="sm" className="mt-4" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : status !== "ready" ? (
        <Skeleton className="h-96 rounded-widget" />
      ) : (
        <div className="grid grid-cols-[220px_minmax(0,1fr)] items-start gap-6">
          <Sidebar view={view} onView={setView} />
          <div className="min-w-0">
            <ViewContent view={view} onOpen={setEditing} />
          </div>
        </div>
      )}
      <TaskDialog task={editing} onClose={() => setEditing(null)} />
    </Page>
  );
}

function Sidebar({ view, onView }: { view: View; onView: (view: View) => void }) {
  const tasks = useProductivity((s) => s.tasks);
  const notes = useProductivity((s) => s.notes);
  const projects = useProductivity((s) => s.projects);
  const deleteProject = useProductivity((s) => s.deleteProject);
  const now = useNow(60_000);
  const groups = useMemo(() => groupTasks(tasks, now), [tasks, now]);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const items: { id: View; label: string; icon: typeof Sun; count?: number }[] = [
    { id: "today", label: "Today", icon: Sun, count: groups.today.length + groups.overdue.length },
    { id: "upcoming", label: "Upcoming", icon: CalendarRange, count: groups.upcoming.length },
    { id: "all", label: "All tasks", icon: Inbox, count: tasks.filter((t) => t.completedAt === null).length },
    { id: "completed", label: "Completed", icon: CircleCheck },
    { id: "calendar", label: "Calendar", icon: CalendarDays },
    { id: "notes", label: "Notes", icon: StickyNote, count: notes.length },
  ];

  return (
    <nav aria-label="Productivity views" className="sticky top-0 space-y-4">
      <ul className="space-y-0.5">
        {items.map(({ id, label, icon: Icon, count }) => (
          <li key={id}>
            <SidebarButton active={view === id} onClick={() => onView(id)} icon={<Icon size={15} aria-hidden />} label={label} count={count} />
          </li>
        ))}
      </ul>
      <div>
        <div className="mb-1 flex items-center justify-between px-3">
          <p className="text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">Projects</p>
          <IconButton size="sm" label="New project" onClick={() => setCreating(true)}>
            <Plus size={14} />
          </IconButton>
        </div>
        <ul className="space-y-0.5">
          {projects.length === 0 && <li className="px-3 text-[12px] text-fg-subtle">Group tasks and notes into projects.</li>}
          {projects.map((project) => (
            <li key={project.id} className="group relative">
              <SidebarButton
                active={view === `project:${project.id}`}
                onClick={() => onView(`project:${project.id}`)}
                icon={<span aria-hidden className="size-2.5 rounded-full" style={{ backgroundColor: project.color || "var(--nova-accent)" }} />}
                label={project.name}
                count={tasks.filter((t) => t.projectId === project.id && t.completedAt === null).length}
              />
              <IconButton
                size="sm"
                label={`Delete project ${project.name}`}
                onClick={() => setConfirmDelete(project.id)}
                className="absolute top-1.5 right-1 opacity-0 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
              >
                <Trash size={12} />
              </IconButton>
            </li>
          ))}
        </ul>
      </div>
      <ProjectDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => onView(`project:${id}`)} />
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete this project?"
        description="Its tasks and notes are kept and move to “No project”."
        confirmLabel="Delete project"
        danger
        onConfirm={() => {
          if (confirmDelete) deleteProject(confirmDelete);
          if (view === `project:${confirmDelete}`) onView("all");
        }}
        onClose={() => setConfirmDelete(null)}
      />
    </nav>
  );
}

function SidebarButton({ active, onClick, icon, label, count }: { active: boolean; onClick: () => void; icon: ReactNode; label: string; count?: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-9 w-full items-center gap-2.5 rounded-control px-3 text-left text-[13px] font-medium transition-colors",
        active ? "bg-white/[0.08] text-fg" : "text-fg-muted hover:bg-white/[0.04] hover:text-fg",
      )}
    >
      <span className={cn("flex w-4 justify-center", active ? "text-accent-text" : "text-fg-subtle")}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && <span className="text-[11px] text-fg-subtle tabular-nums">{count}</span>}
    </button>
  );
}

function ProjectDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const saveProject = useProductivity((s) => s.saveProject);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(PROJECT_COLORS[0]);
  const submit = async () => {
    if (!name.trim()) return;
    const project = await saveProject(newProject(name.trim(), color));
    if (project) onCreated(project.id);
    setName("");
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New project"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={!name.trim()} onClick={() => void submit()}>
            Create project
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-4"
      >
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-fg">Name</span>
          <input
            data-autofocus
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            className="h-10 w-full rounded-control border border-line bg-black/25 px-3 text-[13px] text-fg outline-none select-text focus:border-line-strong"
          />
        </label>
        <fieldset>
          <legend className="mb-2 text-[13px] font-medium text-fg">Color</legend>
          <div className="flex gap-2.5">
            {PROJECT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Color ${c}`}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className={cn("size-8 rounded-full transition-transform hover:scale-110", color === c && "ring-2 ring-fg ring-offset-2 ring-offset-canvas-raised")}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}

function TaskSection({ title, tasks, onOpen, tone }: { title: string; tasks: Task[]; onOpen: (task: Task) => void; tone?: "danger" }) {
  if (tasks.length === 0) return null;
  return (
    <section aria-label={title} className="mb-5">
      <h3 className={cn("mb-1.5 px-3 text-[12px] font-semibold tracking-wider uppercase", tone === "danger" ? "text-danger" : "text-fg-subtle")}>
        {title} <span className="font-normal tabular-nums">· {tasks.length}</span>
      </h3>
      <ul className="glass rounded-widget p-1.5">
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

function EmptyState({ icon: Icon, title, body }: { icon: typeof Sun; title: string; body: string }) {
  return (
    <div className="glass flex flex-col items-center gap-2 rounded-widget py-14 text-center">
      <Icon size={26} className="text-fg-subtle" aria-hidden />
      <p className="text-[14px] font-medium text-fg">{title}</p>
      <p className="max-w-sm text-[13px] text-fg-muted">{body}</p>
    </div>
  );
}

function ViewContent({ view, onOpen }: { view: View; onOpen: (task: Task) => void }) {
  const tasks = useProductivity((s) => s.tasks);
  const projects = useProductivity((s) => s.projects);
  const notes = useProductivity((s) => s.notes);
  const now = useNow(60_000);
  const today = toISODate(now);
  const [query, setQuery] = useState("");
  const groups = useMemo(() => groupTasks(tasks, now), [tasks, now]);

  if (view === "notes") return <NotesView projectId={null} />;
  if (view === "calendar") return <CalendarView onOpen={onOpen} />;

  if (view === "today") {
    const doneToday = groups.completed.filter((t) => t.completedAt && toISODate(new Date(t.completedAt)) === today);
    const pinned = notes.filter((n) => n.pinned).slice(0, 3);
    return (
      <>
        <div className="mb-5 grid grid-cols-3 gap-3">
          <Stat label="Due today" value={groups.today.length} />
          <Stat label="Overdue" value={groups.overdue.length} tone={groups.overdue.length ? "danger" : undefined} />
          <Stat label="Done today" value={doneToday.length} />
        </div>
        <QuickAdd defaults={{ dueDate: today }} placeholder="Add a task for today" />
        <TaskSection title="Overdue" tasks={groups.overdue} onOpen={onOpen} tone="danger" />
        <TaskSection title="Today" tasks={groups.today} onOpen={onOpen} />
        <TaskSection title="Done today" tasks={doneToday} onOpen={onOpen} />
        {groups.today.length === 0 && groups.overdue.length === 0 && (
          <EmptyState icon={Sun} title="Nothing due today" body="Enjoy the space — or add something above." />
        )}
        {pinned.length > 0 && (
          <section aria-label="Pinned notes" className="mt-6">
            <h3 className="mb-1.5 px-3 text-[12px] font-semibold tracking-wider text-fg-subtle uppercase">Pinned notes</h3>
            <div className="grid grid-cols-3 gap-3">
              {pinned.map((note) => (
                <article key={note.id} className="glass rounded-widget p-4">
                  <p className="truncate text-[13px] font-medium text-fg">{noteTitle(note)}</p>
                  <p className="mt-1 line-clamp-3 text-[12px] text-fg-muted">{note.body.replace(/[#*`>]/g, "")}</p>
                </article>
              ))}
            </div>
          </section>
        )}
      </>
    );
  }

  if (view === "upcoming") {
    const byDay = new Map<string, Task[]>();
    for (const task of groups.upcoming) byDay.set(task.dueDate!, [...(byDay.get(task.dueDate!) ?? []), task]);
    return (
      <>
        <QuickAdd defaults={{ dueDate: toISODate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)) }} placeholder="Add a task for tomorrow" />
        {byDay.size === 0 ? (
          <EmptyState icon={CalendarRange} title="Nothing scheduled" body="Tasks with a future due date appear here, grouped by day." />
        ) : (
          [...byDay.entries()].map(([day, list]) => (
            <TaskSection
              key={day}
              title={new Intl.DateTimeFormat(uiLocale(), { weekday: "long", day: "numeric", month: "long" }).format(new Date(`${day}T00:00`))}
              tasks={list}
              onOpen={onOpen}
            />
          ))
        )}
      </>
    );
  }

  if (view === "completed") {
    return groups.completed.length ? (
      <TaskSection title="Completed" tasks={groups.completed} onOpen={onOpen} />
    ) : (
      <EmptyState icon={CircleCheck} title="No completed tasks yet" body="Checked-off tasks are kept here." />
    );
  }

  const projectId = view.startsWith("project:") ? view.slice(8) : null;
  const project = projects.find((p) => p.id === projectId);
  const scoped = projectId ? tasks.filter((t) => t.projectId === projectId) : tasks;
  const filtered = groupTasks(searchTasks(scoped, query), now);
  return (
    <>
      {project && (
        <div className="mb-4 flex items-center gap-2.5">
          <span aria-hidden className="size-3 rounded-full" style={{ backgroundColor: project.color || "var(--nova-accent)" }} />
          <h2 className="text-[18px] font-semibold text-fg">{project.name}</h2>
        </div>
      )}
      <div className="mb-4 flex gap-3">
        <div className="flex-1">
          <QuickAdd defaults={{ projectId }} placeholder={project ? `Add a task to ${project.name}` : "Add a task"} />
        </div>
        <label className="glass flex h-11 w-60 items-center rounded-full px-4">
          <span className="sr-only">Search tasks</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tasks" className="h-full w-full bg-transparent text-[13px] text-fg outline-none select-text placeholder:text-fg-subtle" />
        </label>
      </div>
      <TaskSection title="Overdue" tasks={filtered.overdue} onOpen={onOpen} tone="danger" />
      <TaskSection title="Today" tasks={filtered.today} onOpen={onOpen} />
      <TaskSection title="Upcoming" tasks={filtered.upcoming} onOpen={onOpen} />
      <TaskSection title="No date" tasks={filtered.someday} onOpen={onOpen} />
      {project && <TaskSection title="Completed" tasks={filtered.completed} onOpen={onOpen} />}
      {filtered.overdue.length + filtered.today.length + filtered.upcoming.length + filtered.someday.length === 0 && (
        <EmptyState icon={ListTodo} title={query ? "No matching tasks" : "No open tasks"} body={query ? "Try a different search." : "Add one above."} />
      )}
      {project && (
        <div className="mt-6">
          <h3 className="mb-2 px-3 text-[12px] font-semibold tracking-wider text-fg-subtle uppercase">Notes in {project.name}</h3>
          <NotesView projectId={project.id} />
        </div>
      )}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "danger" }) {
  return (
    <div className="glass rounded-widget px-4 py-3">
      <p className="text-[12px] text-fg-subtle">{label}</p>
      <p className={cn("mt-0.5 text-[24px] font-semibold tabular-nums", tone === "danger" ? "text-danger" : "text-fg")}>{value}</p>
    </div>
  );
}

function CalendarView({ onOpen }: { onOpen: (task: Task) => void }) {
  const tasks = useProductivity((s) => s.tasks);
  const now = useNow(60_000);
  const locale = uiLocale();
  const weekStart = firstDayOfWeek(locale);
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() });
  const [selected, setSelected] = useState(toISODate(now));
  const days = useMemo(() => buildMonthGrid(cursor.year, cursor.month, weekStart, now), [cursor, weekStart, now]);
  const byDay = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of tasks) if (t.dueDate) map.set(t.dueDate, [...(map.get(t.dueDate) ?? []), t]);
    return map;
  }, [tasks]);
  const shift = (delta: number) =>
    setCursor(({ year, month }) => {
      const d = new Date(year, month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  const selectedTasks = byDay.get(selected) ?? [];

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_300px] gap-4">
      <section aria-label="Month" className="glass rounded-widget p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[18px] font-semibold text-fg">
            {new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(new Date(cursor.year, cursor.month, 1))}
          </h2>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setCursor({ year: now.getFullYear(), month: now.getMonth() })}>
              Today
            </Button>
            <IconButton size="sm" label="Previous month" onClick={() => shift(-1)}>
              <ChevronLeft size={16} />
            </IconButton>
            <IconButton size="sm" label="Next month" onClick={() => shift(1)}>
              <ChevronRight size={16} />
            </IconButton>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-fg-subtle">
          {weekdayLabels(locale, weekStart).map((l, i) => (
            <span key={i} className="pb-1">
              {l}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {days.map((day) => {
            const iso = toISODate(day.date);
            const list = byDay.get(iso) ?? [];
            const open = list.filter((t) => t.completedAt === null);
            return (
              <button
                key={iso}
                type="button"
                onClick={() => setSelected(iso)}
                aria-pressed={selected === iso}
                aria-label={`${day.date.toDateString()}, ${open.length} open tasks`}
                className={cn(
                  "flex h-20 flex-col items-start rounded-[10px] border p-1.5 text-left transition-colors",
                  selected === iso ? "border-accent/60 bg-accent/10" : "border-transparent hover:bg-white/[0.04]",
                  !day.inMonth && "opacity-40",
                )}
              >
                <span className={cn("flex size-6 items-center justify-center rounded-full text-[12px] tabular-nums", day.isToday ? "bg-accent font-semibold text-on-accent" : "text-fg")}>
                  {day.date.getDate()}
                </span>
                <span className="mt-auto w-full space-y-0.5">
                  {open.slice(0, 2).map((t) => (
                    <span key={t.id} className="block truncate rounded-[4px] bg-white/[0.06] px-1 text-[10px] text-fg-muted">
                      {t.title}
                    </span>
                  ))}
                  {open.length > 2 && <span className="block text-[10px] text-fg-subtle">+{open.length - 2} more</span>}
                </span>
              </button>
            );
          })}
        </div>
      </section>
      <section aria-label="Selected day" className="glass flex flex-col rounded-widget p-4">
        <h3 className="mb-3 text-[14px] font-semibold text-fg">
          {new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" }).format(new Date(`${selected}T00:00`))}
        </h3>
        <QuickAdd defaults={{ dueDate: selected }} placeholder="Add a task" />
        {selectedTasks.length === 0 ? (
          <p className="text-[13px] text-fg-muted">No tasks on this day.</p>
        ) : (
          <ul className="-mx-1.5">
            {selectedTasks.map((t) => (
              <TaskRow key={t.id} task={t} onOpen={onOpen} />
            ))}
          </ul>
        )}
        <p className="mt-auto pt-4 text-[11px] text-fg-subtle">Calendar sync with Outlook or Google is planned as an optional adapter.</p>
      </section>
    </div>
  );
}

