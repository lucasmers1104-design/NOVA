/** Mirrors the structs in src-tauri/src/storage/productivity.rs. */
export interface Project {
  id: string;
  name: string;
  color: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export type Priority = 0 | 1 | 2 | 3;

export interface Task {
  id: string;
  title: string;
  notes: string;
  projectId: string | null;
  priority: Priority;
  /** Local date, YYYY-MM-DD. */
  dueDate: string | null;
  /** Local time, HH:MM. */
  dueTime: string | null;
  remind: boolean;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  projectId: string | null;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export const PRIORITY_LABELS: Record<Priority, string> = { 0: "None", 1: "Low", 2: "Medium", 3: "High" };
export const PROJECT_COLORS = ["#8b5cf6", "#3d7bff", "#22d3ee", "#10b981", "#f59e0b", "#f43f5e", "#a3a3a3"] as const;

/** Local calendar date as YYYY-MM-DD. */
export function toISODate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return toISODate(new Date(y!, m! - 1, d! + days));
}

/** The moment a task is due, in local time (end of day when no time is set). */
export function dueMoment(task: Pick<Task, "dueDate" | "dueTime">): Date | null {
  if (!task.dueDate) return null;
  const [y, m, d] = task.dueDate.split("-").map(Number);
  const [hh, mm] = task.dueTime ? task.dueTime.split(":").map(Number) : [23, 59];
  return new Date(y!, m! - 1, d!, hh, mm);
}

export function isOverdue(task: Task, now: Date): boolean {
  if (task.completedAt !== null || !task.dueDate) return false;
  if (task.dueTime) return dueMoment(task)!.getTime() < now.getTime();
  return task.dueDate < toISODate(now);
}

export interface TaskGroups {
  overdue: Task[];
  today: Task[];
  upcoming: Task[];
  someday: Task[];
  completed: Task[];
}

const byDueThenPriority = (a: Task, b: Task) =>
  (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") ||
  (a.dueTime ?? "99:99").localeCompare(b.dueTime ?? "99:99") ||
  b.priority - a.priority ||
  a.createdAt - b.createdAt;

export function groupTasks(tasks: readonly Task[], now: Date): TaskGroups {
  const today = toISODate(now);
  const groups: TaskGroups = { overdue: [], today: [], upcoming: [], someday: [], completed: [] };
  for (const task of tasks) {
    if (task.completedAt !== null) groups.completed.push(task);
    else if (isOverdue(task, now)) groups.overdue.push(task);
    else if (task.dueDate === today) groups.today.push(task);
    else if (task.dueDate) groups.upcoming.push(task);
    else groups.someday.push(task);
  }
  groups.overdue.sort(byDueThenPriority);
  groups.today.sort(byDueThenPriority);
  groups.upcoming.sort(byDueThenPriority);
  groups.someday.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
  groups.completed.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  return groups;
}

export function searchTasks(tasks: readonly Task[], query: string): Task[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...tasks];
  return tasks.filter((t) => t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q));
}

/** Tasks with a reminder whose due moment has passed and that weren't reminded yet. */
export function dueReminders(tasks: readonly Task[], now: Date, reminded: ReadonlySet<string>): Task[] {
  return tasks.filter((t) => {
    if (!t.remind || t.completedAt !== null || !t.dueTime || reminded.has(reminderKey(t))) return false;
    const due = dueMoment(t)!.getTime();
    // Only remind for things due within the last 12 hours; older ones are simply overdue.
    return due <= now.getTime() && now.getTime() - due < 12 * 3600_000;
  });
}

/** Changes when the due moment changes, so rescheduled tasks remind again. */
export function reminderKey(task: Pick<Task, "id" | "dueDate" | "dueTime">): string {
  return `${task.id}@${task.dueDate}T${task.dueTime}`;
}

export function relativeDueLabel(task: Pick<Task, "dueDate" | "dueTime">, now: Date, locale: string): string | null {
  if (!task.dueDate) return null;
  const today = toISODate(now);
  const time = task.dueTime ? ` ${task.dueTime}` : "";
  if (task.dueDate === today) return `Today${time}`;
  if (task.dueDate === addDays(today, 1)) return `Tomorrow${time}`;
  if (task.dueDate === addDays(today, -1)) return `Yesterday${time}`;
  const [y, m, d] = task.dueDate.split("-").map(Number);
  const date = new Date(y!, m! - 1, d!);
  const sameYear = y === now.getFullYear();
  return `${new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", year: sameYear ? undefined : "numeric" }).format(date)}${time}`;
}

export function noteTitle(note: Pick<Note, "title" | "body">): string {
  return note.title.trim() || note.body.trim().split("\n")[0]?.replace(/^#+\s*/, "").slice(0, 60) || "Untitled note";
}
