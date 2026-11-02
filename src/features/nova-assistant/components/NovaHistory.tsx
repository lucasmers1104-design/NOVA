import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { actionHistory } from "../api";
import type { ActionEntry } from "../types";

const STATUS_STYLE: Record<ActionEntry["status"], string> = {
  done: "text-success border-success/25 bg-success/10",
  failed: "text-danger border-danger/25 bg-danger/10",
  declined: "text-fg-muted border-line bg-white/[0.04]",
};

/** Everything NOVA AI did (or was refused), newest first. */
export function NovaHistory() {
  const [entries, setEntries] = useState<ActionEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    actionHistory(100).then(setEntries, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <h2 className="text-[13px] font-semibold text-fg">What NOVA did</h2>
      <p className="mt-0.5 text-[11.5px] text-fg-muted">Searches, opened items, created documents, file changes and screenshots. Stored only on this PC.</p>
      {error && <p className="mt-3 text-[12px] text-danger">{error}</p>}
      {entries?.length === 0 && <p className="mt-6 text-center text-[12.5px] text-fg-subtle">No actions yet.</p>}
      <ul className="mt-3 space-y-1.5">
        {entries?.map((entry) => (
          <li key={entry.id} className="flex items-start gap-2.5 rounded-[12px] border border-line bg-white/[0.025] px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] leading-snug text-fg">{entry.title}</p>
              <p className="mt-0.5 truncate text-[11px] text-fg-subtle">
                {new Date(entry.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                {entry.detail && ` · ${entry.detail}`}
              </p>
            </div>
            <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] font-medium capitalize", STATUS_STYLE[entry.status])}>{entry.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
