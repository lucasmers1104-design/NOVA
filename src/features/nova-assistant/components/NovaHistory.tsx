import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { actionHistory } from "../api";
import type { ActionEntry } from "../types";

const STATUS_STYLE: Record<ActionEntry["status"], string> = {
  done: "text-success",
  failed: "text-danger",
  declined: "text-fg-subtle",
};

/** Everything NOVA AI did (or was refused), newest first. The panel header carries the title. */
export function NovaHistory() {
  const [entries, setEntries] = useState<ActionEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    actionHistory(100).then(setEntries, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pt-1 pb-3">
      <p className="text-[11.5px] leading-snug text-fg-subtle">Searches, opened items, created documents, file changes and screenshots. Stored only on this PC.</p>
      {error && (
        <p role="alert" className="mt-3 text-[12px] text-danger">
          {error}
        </p>
      )}
      {!entries && !error && <p className="m-auto text-[12.5px] text-fg-subtle">Loading…</p>}
      {entries?.length === 0 && <p className="m-auto text-[12.5px] text-fg-subtle">Nothing yet. Actions NOVA takes for you will show up here.</p>}
      {entries && entries.length > 0 && (
        <ul className="mt-3 -mx-2.5 space-y-0.5" aria-label="Actions">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-start gap-3 rounded-[12px] px-2.5 py-2 transition-colors hover:bg-white/[0.04]">
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] leading-snug text-fg">{entry.title}</p>
                <p className="mt-0.5 truncate text-[11px] text-fg-subtle" title={entry.detail || undefined}>
                  {new Date(entry.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                  {entry.detail && ` · ${entry.detail}`}
                </p>
              </div>
              <span className={cn("shrink-0 pt-px text-[11px] font-medium capitalize", STATUS_STYLE[entry.status])}>{entry.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
