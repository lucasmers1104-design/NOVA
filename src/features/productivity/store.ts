import { create } from "zustand";
import { notifyError } from "@/features/notifications/store";
import { callNative, isDesktop } from "@/lib/native";
import type { Note, Project, Task } from "./model";

interface ProductivityData {
  projects: Project[];
  tasks: Task[];
  notes: Note[];
}

/** SQLite via commands in the desktop app; localStorage in the browser preview and tests. */
const LOCAL_KEY = "nova.productivity";

function readLocal(): ProductivityData {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "{}") as Partial<ProductivityData>;
    return { projects: parsed.projects ?? [], tasks: parsed.tasks ?? [], notes: parsed.notes ?? [] };
  } catch {
    return { projects: [], tasks: [], notes: [] };
  }
}

function writeLocal(update: (data: ProductivityData) => ProductivityData) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(update(readLocal())));
}

type Entity = "project" | "task" | "note";
const COLLECTION = { project: "projects", task: "tasks", note: "notes" } as const;

async function persist<T extends { id: string; createdAt: number; updatedAt: number }>(entity: Entity, item: T): Promise<T> {
  if (isDesktop()) return callNative<T>(`${entity}_save`, { [entity]: item });
  const now = Date.now();
  const saved = { ...item, createdAt: item.createdAt || now, updatedAt: now };
  writeLocal((data) => {
    const list = data[COLLECTION[entity]] as unknown as T[];
    const index = list.findIndex((x) => x.id === item.id);
    const next = index === -1 ? [...list, saved] : list.map((x) => (x.id === item.id ? saved : x));
    return { ...data, [COLLECTION[entity]]: next };
  });
  return saved;
}

async function remove(entity: Entity, id: string): Promise<void> {
  if (isDesktop()) return callNative("productivity_delete", { entity, id });
  writeLocal((data) => {
    const next = { ...data, [COLLECTION[entity]]: (data[COLLECTION[entity]] as { id: string }[]).filter((x) => x.id !== id) } as ProductivityData;
    if (entity === "project") {
      // Mirror ON DELETE SET NULL.
      next.tasks = next.tasks.map((t) => (t.projectId === id ? { ...t, projectId: null } : t));
      next.notes = next.notes.map((n) => (n.projectId === id ? { ...n, projectId: null } : n));
    }
    return next;
  });
}

interface ProductivityState extends ProductivityData {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  load: () => Promise<void>;
  saveTask: (task: Task) => Promise<Task | null>;
  toggleTask: (id: string) => void;
  deleteTask: (id: string) => void;
  saveProject: (project: Project) => Promise<Project | null>;
  deleteProject: (id: string) => void;
  saveNote: (note: Note) => Promise<Note | null>;
  deleteNote: (id: string) => void;
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  return list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item];
}

export const useProductivity = create<ProductivityState>()((set, get) => {
  /** Optimistic write: show immediately, reconcile with what storage returns, roll back on failure. */
  const save = async <K extends "tasks" | "projects" | "notes">(key: K, entity: Entity, item: ProductivityData[K][number]) => {
    const previous = get()[key];
    set({ [key]: upsert(previous as { id: string }[], item) } as Partial<ProductivityState>);
    try {
      const saved = await persist(entity, item);
      set({ [key]: upsert(get()[key] as { id: string }[], saved) } as Partial<ProductivityState>);
      return saved;
    } catch (error) {
      set({ [key]: previous } as Partial<ProductivityState>);
      notifyError(`Couldn't save the ${entity}`, error);
      return null;
    }
  };

  const destroy = <K extends "tasks" | "projects" | "notes">(key: K, entity: Entity, id: string) => {
    const previous = { tasks: get().tasks, projects: get().projects, notes: get().notes };
    set({ [key]: (get()[key] as { id: string }[]).filter((x) => x.id !== id) } as Partial<ProductivityState>);
    if (entity === "project") {
      set({
        tasks: get().tasks.map((t) => (t.projectId === id ? { ...t, projectId: null } : t)),
        notes: get().notes.map((n) => (n.projectId === id ? { ...n, projectId: null } : n)),
      });
    }
    remove(entity, id).catch((error) => {
      set(previous);
      notifyError(`Couldn't delete the ${entity}`, error);
    });
  };

  return {
    projects: [],
    tasks: [],
    notes: [],
    status: "idle",
    error: null,

    load: async () => {
      if (get().status === "loading") return;
      set({ status: "loading" });
      try {
        const data = isDesktop() ? await callNative<ProductivityData>("productivity_load") : readLocal();
        set({ ...data, status: "ready", error: null });
      } catch (error) {
        set({ status: "error", error: error instanceof Error ? error.message : String(error) });
      }
    },

    saveTask: (task) => save("tasks", "task", task),
    toggleTask: (id) => {
      const task = get().tasks.find((t) => t.id === id);
      if (task) void save("tasks", "task", { ...task, completedAt: task.completedAt === null ? Date.now() : null });
    },
    deleteTask: (id) => destroy("tasks", "task", id),
    saveProject: (project) => save("projects", "project", project),
    deleteProject: (id) => destroy("projects", "project", id),
    saveNote: (note) => save("notes", "note", note),
    deleteNote: (id) => destroy("notes", "note", id),
  };
});

export function newTask(partial: Partial<Task> & Pick<Task, "title">): Task {
  return {
    id: crypto.randomUUID(),
    notes: "",
    projectId: null,
    priority: 0,
    dueDate: null,
    dueTime: null,
    remind: false,
    completedAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

export function newNote(partial: Partial<Note> = {}): Note {
  return { id: crypto.randomUUID(), title: "", body: "", projectId: null, pinned: false, createdAt: 0, updatedAt: 0, ...partial };
}

export function newProject(name: string, color: string): Project {
  return { id: crypto.randomUUID(), name, color, archived: false, createdAt: 0, updatedAt: 0 };
}
