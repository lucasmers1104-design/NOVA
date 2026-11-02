import { ListTodo } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { groupTasks, toISODate, type Task } from "@/features/productivity/model";
import { useProductivity } from "@/features/productivity/store";
import { QuickAdd, TaskDialog, TaskRow } from "@/features/productivity/TaskComponents";
import { useNow } from "@/lib/time";
import { useUi } from "@/stores/ui";
import { useWidgetConfig } from "../config";
import { WidgetFrame } from "../WidgetFrame";

export function TasksWidget() {
  const { showQuickAdd } = useWidgetConfig<{ showQuickAdd: boolean }>();
  const status = useProductivity((s) => s.status);
  const load = useProductivity((s) => s.load);
  const tasks = useProductivity((s) => s.tasks);
  const navigate = useUi((s) => s.navigate);
  const now = useNow(60_000);
  const [editing, setEditing] = useState<Task | null>(null);

  useEffect(() => {
    if (status === "idle") void load();
  }, [status, load]);

  const groups = useMemo(() => groupTasks(tasks, now), [tasks, now]);
  const list = [...groups.overdue, ...groups.today];

  return (
    <WidgetFrame
      title="Today's tasks"
      icon={ListTodo}
      actions={
        <button type="button" onClick={() => navigate("productivity")} className="text-[12px] font-medium text-accent-text hover:underline">
          Open
        </button>
      }
    >
      <div className="flex h-full flex-col">
        {showQuickAdd && <QuickAdd defaults={{ dueDate: toISODate(now) }} placeholder="Add for today" />}
        {list.length === 0 ? (
          <p className="flex flex-1 items-center justify-center text-[13px] text-fg-muted">{status === "ready" ? "Nothing due today." : "Loading…"}</p>
        ) : (
          <ul className="-mx-2 min-h-0 flex-1 overflow-y-auto">
            {list.map((task) => (
              <TaskRow key={task.id} task={task} onOpen={setEditing} />
            ))}
          </ul>
        )}
      </div>
      <TaskDialog task={editing} onClose={() => setEditing(null)} />
    </WidgetFrame>
  );
}
