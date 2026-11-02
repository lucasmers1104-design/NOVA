import { Bell, Check, Flag, Plus, Trash } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { Button, IconButton } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog } from "@/components/ui/Dialog";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/cn";
import { uiLocale, useNow } from "@/lib/time";
import { isOverdue, PRIORITY_LABELS, type Priority, type Task, relativeDueLabel } from "./model";
import { newTask, useProductivity } from "./store";

const PRIORITY_TONE: Record<Priority, string> = { 0: "border-fg-subtle", 1: "border-sky-400", 2: "border-warning", 3: "border-danger" };
const PRIORITY_TEXT: Record<Priority, string> = { 0: "text-fg-subtle", 1: "text-sky-400", 2: "text-warning", 3: "text-danger" };

export function TaskRow({ task, onOpen }: { task: Task; onOpen: (task: Task) => void }) {
  const toggleTask = useProductivity((s) => s.toggleTask);
  const deleteTask = useProductivity((s) => s.deleteTask);
  const projects = useProductivity((s) => s.projects);
  const now = useNow(60_000);
  const project = projects.find((p) => p.id === task.projectId);
  const done = task.completedAt !== null;
  const overdue = isOverdue(task, now);
  const due = relativeDueLabel(task, now, uiLocale());

  return (
    <li className="group flex items-center gap-3 rounded-[12px] px-3 py-2.5 transition-colors hover:bg-white/[0.04]">
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={done ? `Mark “${task.title}” as not done` : `Complete “${task.title}”`}
        onClick={() => toggleTask(task.id)}
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
          done ? "border-accent bg-accent text-on-accent" : cn(PRIORITY_TONE[task.priority], "hover:bg-white/[0.06]"),
        )}
      >
        {done && <Check size={12} strokeWidth={3} />}
      </button>
      <button type="button" onClick={() => onOpen(task)} className="min-w-0 flex-1 text-left">
        <span className={cn("block truncate text-[13.5px]", done ? "text-fg-subtle line-through" : "text-fg")}>{task.title}</span>
        {(due || project || task.notes) && (
          <span className="mt-0.5 flex items-center gap-2 text-[11.5px] text-fg-subtle">
            {due && (
              <span className={cn("flex items-center gap-1", overdue && "font-medium text-danger")}>
                {task.remind && <Bell size={11} aria-label="Reminder set" />}
                {due}
              </span>
            )}
            {project && (
              <span className="flex items-center gap-1">
                <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: project.color || "var(--nova-accent)" }} />
                {project.name}
              </span>
            )}
            {task.notes && <span className="truncate">{task.notes.split("\n")[0]}</span>}
          </span>
        )}
      </button>
      {task.priority > 0 && !done && <Flag size={13} className={PRIORITY_TEXT[task.priority]} aria-label={`${PRIORITY_LABELS[task.priority]} priority`} />}
      <IconButton
        size="sm"
        label={`Delete “${task.title}”`}
        onClick={() => deleteTask(task.id)}
        className="opacity-0 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
      >
        <Trash size={13} />
      </IconButton>
    </li>
  );
}

/** Inline "add a task" field; defaults (due date, project) come from the current view. */
export function QuickAdd({ defaults, placeholder = "Add a task" }: { defaults: Partial<Task>; placeholder?: string }) {
  const saveTask = useProductivity((s) => s.saveTask);
  const [title, setTitle] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    void saveTask(newTask({ ...defaults, title: trimmed }));
    setTitle("");
  };
  return (
    <form onSubmit={submit} className="glass mb-4 flex h-11 items-center gap-2.5 rounded-full pr-1.5 pl-4 focus-within:border-line-strong">
      <Plus size={16} className="text-accent-text" aria-hidden />
      <label className="sr-only" htmlFor="quick-add-task">
        {placeholder}
      </label>
      <input
        id="quick-add-task"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={200}
        placeholder={`${placeholder} — press Enter`}
        className="h-full flex-1 bg-transparent text-[13.5px] text-fg outline-none select-text placeholder:text-fg-subtle"
      />
      {title.trim() && (
        <Button size="sm" variant="primary" type="submit" className="h-8 rounded-full">
          Add
        </Button>
      )}
    </form>
  );
}

const PRIORITY_OPTIONS = ([0, 1, 2, 3] as const).map((p) => ({ value: p, label: PRIORITY_LABELS[p] }));

export function TaskDialog({ task, onClose }: { task: Task | null; onClose: () => void }) {
  const saveTask = useProductivity((s) => s.saveTask);
  const deleteTask = useProductivity((s) => s.deleteTask);
  const projects = useProductivity((s) => s.projects);
  const [draft, setDraft] = useState<Task | null>(task);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const formId = useId();

  useEffect(() => setDraft(task), [task]);

  const update = (patch: Partial<Task>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !draft.title.trim()) return;
    const clean: Task = {
      ...draft,
      title: draft.title.trim(),
      dueTime: draft.dueDate ? draft.dueTime : null,
      remind: Boolean(draft.dueDate && draft.dueTime && draft.remind),
    };
    void saveTask(clean);
    onClose();
  };

  const field = "h-10 w-full rounded-control border border-line bg-black/25 px-3 text-[13px] text-fg outline-none select-text focus:border-line-strong";

  return (
    <>
      <Dialog
        open={task !== null}
        onClose={onClose}
        title={task?.createdAt ? "Edit task" : "New task"}
        footer={
          <>
            {task?.createdAt ? (
              <Button size="sm" variant="ghost" icon={<Trash size={14} />} onClick={() => setConfirmDelete(true)} className="mr-auto hover:text-danger">
                Delete
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" form={formId} disabled={!draft?.title.trim()}>
              Save
            </Button>
          </>
        }
      >
        {draft && (
          <form id={formId} onSubmit={submit} className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-fg">Title</span>
              <input data-autofocus value={draft.title} maxLength={200} onChange={(e) => update({ title: e.target.value })} className={field} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-fg">Notes</span>
              <textarea
                value={draft.notes}
                rows={3}
                maxLength={20000}
                onChange={(e) => update({ notes: e.target.value })}
                className={cn(field, "h-auto resize-none py-2.5 leading-relaxed")}
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-medium text-fg">Due date</span>
                <input type="date" value={draft.dueDate ?? ""} onChange={(e) => update({ dueDate: e.target.value || null })} className={field} />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-medium text-fg">Time</span>
                <input
                  type="time"
                  value={draft.dueTime ?? ""}
                  disabled={!draft.dueDate}
                  onChange={(e) => update({ dueTime: e.target.value || null })}
                  className={cn(field, "disabled:opacity-40")}
                />
              </label>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[13px] font-medium text-fg">Remind me</p>
                <p className="text-[12px] text-fg-muted">Notifies you at the due time while NOVA is running.</p>
              </div>
              <Switch label="Remind me" checked={draft.remind} disabled={!draft.dueDate || !draft.dueTime} onChange={(remind) => update({ remind })} />
            </div>
            <div>
              <p className="mb-1.5 text-[13px] font-medium text-fg">Priority</p>
              <SegmentedControl label="Priority" value={draft.priority} options={PRIORITY_OPTIONS} onChange={(priority) => update({ priority })} />
            </div>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-fg">Project</span>
              <select value={draft.projectId ?? ""} onChange={(e) => update({ projectId: e.target.value || null })} className={cn(field, "bg-canvas-raised")}>
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </form>
        )}
      </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this task?"
        description={`“${task?.title ?? ""}” will be removed permanently.`}
        confirmLabel="Delete task"
        danger
        onConfirm={() => {
          if (task) deleteTask(task.id);
          onClose();
        }}
        onClose={() => setConfirmDelete(false)}
      />
    </>
  );
}
