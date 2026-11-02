import { ArrowDown, ArrowUp, Pause, Play, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { type ProcessEntry, useProcesses } from "./api";

type SortKey = "name" | "cpu" | "memory";
const VISIBLE_ROWS = 40;

export function sortProcesses(processes: readonly ProcessEntry[], key: SortKey, descending: boolean, query: string): ProcessEntry[] {
  const needle = query.trim().toLowerCase();
  const filtered = needle ? processes.filter((p) => p.name.toLowerCase().includes(needle) || String(p.pid) === needle) : [...processes];
  const direction = descending ? -1 : 1;
  return filtered.sort((a, b) => {
    const order = key === "name" ? a.name.localeCompare(b.name) : a[key] - b[key];
    return order * direction || a.pid - b.pid;
  });
}

export function ProcessTable() {
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "cpu", descending: true });
  const [showAll, setShowAll] = useState(false);
  const { data, error, isPending, refetch } = useProcesses(paused);

  const rows = useMemo(() => (data ? sortProcesses(data.processes, sort.key, sort.descending, query) : []), [data, sort, query]);
  const visible = showAll ? rows : rows.slice(0, VISIBLE_ROWS);

  const toggleSort = (key: SortKey) =>
    setSort((current) => (current.key === key ? { key, descending: !current.descending } : { key, descending: key !== "name" }));

  if (error) return <StatusMessage error={error} subject="process data" onRetry={() => void refetch()} />;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center gap-2">
        <label className="flex h-9 flex-1 items-center gap-2 rounded-control border border-line bg-black/20 px-3 focus-within:border-line-strong">
          <Search size={15} className="text-fg-subtle" aria-hidden />
          <span className="sr-only">Filter processes</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name or PID"
            className="h-full flex-1 bg-transparent text-[13px] text-fg outline-none select-text placeholder:text-fg-subtle"
          />
        </label>
        <Button size="sm" variant="secondary" icon={paused ? <Play size={14} /> : <Pause size={14} />} onClick={() => setPaused((p) => !p)}>
          {paused ? "Resume" : "Pause"}
        </Button>
      </div>
      {isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-8" />
          ))}
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-auto rounded-[12px] border border-line">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-canvas-raised/95 text-[12px] text-fg-subtle">
                <tr>
                  <SortHeader label="Process" sortKey="name" sort={sort} onSort={toggleSort} className="text-left" />
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    PID
                  </th>
                  <SortHeader label="CPU" sortKey="cpu" sort={sort} onSort={toggleSort} className="text-right" />
                  <SortHeader label="Memory" sortKey="memory" sort={sort} onSort={toggleSort} className="text-right" />
                </tr>
              </thead>
              <tbody>
                {visible.map((p) => (
                  <tr key={p.pid} className="border-t border-line/60 hover:bg-white/[0.03]">
                    <td className="max-w-0 truncate px-3 py-1.5 text-fg" title={p.name}>
                      {p.name}
                    </td>
                    <td className="px-3 py-1.5 text-right text-fg-subtle tabular-nums">{p.pid}</td>
                    <td className="px-3 py-1.5 text-right text-fg tabular-nums">{data?.measuring ? "…" : `${p.cpu.toFixed(1)}%`}</td>
                    <td className="px-3 py-1.5 text-right text-fg-muted tabular-nums">{formatBytes(p.memory)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visible.length === 0 && <p className="py-8 text-center text-[13px] text-fg-muted">No processes match “{query}”.</p>}
          </div>
          <div className="mt-2 flex items-center justify-between text-[12px] text-fg-subtle">
            <span className="tabular-nums">
              {rows.length} processes{paused ? " · paused" : ""}
            </span>
            {rows.length > VISIBLE_ROWS && (
              <Button size="sm" variant="ghost" onClick={() => setShowAll((s) => !s)} className="h-7">
                {showAll ? `Show top ${VISIBLE_ROWS}` : `Show all ${rows.length}`}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; descending: boolean };
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  const Icon = sort.descending ? ArrowDown : ArrowUp;
  return (
    <th scope="col" aria-sort={active ? (sort.descending ? "descending" : "ascending") : "none"} className={cn("px-3 py-2 font-medium", className)}>
      <button type="button" onClick={() => onSort(sortKey)} className={cn("inline-flex items-center gap-1 hover:text-fg", active && "text-fg")}>
        {label}
        {active && <Icon size={12} aria-hidden />}
      </button>
    </th>
  );
}
