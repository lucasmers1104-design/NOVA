import { Eye, Pencil, Pin, PinOff, Plus, Search, StickyNote, Trash } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, IconButton } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Markdown } from "@/components/ui/Markdown";
import { cn } from "@/lib/cn";
import { type Note, noteTitle } from "./model";
import { newNote, useProductivity } from "./store";

export function NotesView({ projectId }: { projectId: string | null }) {
  const notes = useProductivity((s) => s.notes);
  const saveNote = useProductivity((s) => s.saveNote);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return notes
      .filter((n) => (projectId ? n.projectId === projectId : true))
      .filter((n) => !q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  }, [notes, query, projectId]);

  const selected = notes.find((n) => n.id === selectedId) ?? visible[0] ?? null;

  const create = async () => {
    const note = await saveNote(newNote({ projectId }));
    if (note) setSelectedId(note.id);
  };

  return (
    <div className="grid h-[calc(100vh-13rem)] min-h-[460px] grid-cols-[280px_minmax(0,1fr)] gap-4">
      <div className="glass flex flex-col rounded-widget p-3">
        <div className="mb-2 flex gap-2">
          <label className="flex h-9 flex-1 items-center gap-2 rounded-control border border-line bg-black/20 px-2.5 focus-within:border-line-strong">
            <Search size={14} className="text-fg-subtle" aria-hidden />
            <span className="sr-only">Search notes</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search notes" className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none select-text placeholder:text-fg-subtle" />
          </label>
          <IconButton label="New note" onClick={() => void create()} className="border border-line">
            <Plus size={16} />
          </IconButton>
        </div>
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {visible.length === 0 && <li className="px-2 py-6 text-center text-[12.5px] text-fg-muted">{query ? "No matching notes." : "No notes yet."}</li>}
          {visible.map((note) => (
            <li key={note.id}>
              <button
                type="button"
                onClick={() => setSelectedId(note.id)}
                aria-current={selected?.id === note.id ? "true" : undefined}
                className={cn(
                  "w-full rounded-[12px] px-3 py-2.5 text-left transition-colors",
                  selected?.id === note.id ? "bg-white/[0.08]" : "hover:bg-white/[0.04]",
                )}
              >
                <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
                  {note.pinned && <Pin size={11} className="shrink-0 text-accent-text" aria-label="Pinned" />}
                  <span className="truncate">{noteTitle(note)}</span>
                </span>
                <span className="mt-0.5 block truncate text-[11.5px] text-fg-subtle">
                  {new Date(note.updatedAt || Date.now()).toLocaleDateString()} · {note.body.replace(/[#*`>\-\n]+/g, " ").trim().slice(0, 60) || "Empty"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {selected ? (
        <NoteEditor key={selected.id} note={selected} />
      ) : (
        <div className="glass flex flex-col items-center justify-center gap-3 rounded-widget text-center">
          <StickyNote size={28} className="text-fg-subtle" aria-hidden />
          <p className="text-[14px] font-medium text-fg">Capture an idea</p>
          <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => void create()}>
            New note
          </Button>
        </div>
      )}
    </div>
  );
}

function NoteEditor({ note }: { note: Note }) {
  const saveNote = useProductivity((s) => s.saveNote);
  const deleteNote = useProductivity((s) => s.deleteNote);
  const [draft, setDraft] = useState(note);
  const [preview, setPreview] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(draft);
  latest.current = draft;

  // Autosave shortly after typing stops, and flush on unmount.
  const schedule = (next: Note) => {
    setDraft(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void saveNote(next), 600);
  };
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      const pending = latest.current;
      if (pending.title !== note.title || pending.body !== note.body) void saveNote(pending);
    },
    // Runs once on unmount; `latest` holds the newest draft.
    [],
  );

  return (
    <div className="glass flex flex-col rounded-widget">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <input
          value={draft.title}
          onChange={(e) => schedule({ ...draft, title: e.target.value })}
          placeholder={noteTitle(draft)}
          maxLength={200}
          aria-label="Note title"
          className="min-w-0 flex-1 bg-transparent text-[18px] font-semibold text-fg outline-none select-text placeholder:text-fg-subtle"
        />
        <IconButton label={preview ? "Edit note" : "Preview note"} onClick={() => setPreview((p) => !p)}>
          {preview ? <Pencil size={15} /> : <Eye size={15} />}
        </IconButton>
        <IconButton label={draft.pinned ? "Unpin note" : "Pin note"} onClick={() => schedule({ ...draft, pinned: !draft.pinned })}>
          {draft.pinned ? <PinOff size={15} /> : <Pin size={15} />}
        </IconButton>
        <IconButton label="Delete note" onClick={() => setConfirmDelete(true)} className="hover:text-danger">
          <Trash size={15} />
        </IconButton>
      </div>
      {preview ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 text-[14px] text-fg-muted select-text">
          {draft.body.trim() ? <Markdown source={draft.body} /> : <p className="text-fg-subtle">Nothing to preview.</p>}
        </div>
      ) : (
        <textarea
          value={draft.body}
          onChange={(e) => schedule({ ...draft, body: e.target.value })}
          placeholder="Write in Markdown — # headings, - lists, **bold**, `code`…"
          aria-label="Note text"
          maxLength={200000}
          className="min-h-0 flex-1 resize-none bg-transparent px-6 py-5 font-mono text-[13.5px] leading-relaxed text-fg outline-none select-text placeholder:text-fg-subtle"
        />
      )}
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this note?"
        description={`“${noteTitle(draft)}” will be removed permanently.`}
        confirmLabel="Delete note"
        danger
        onConfirm={() => deleteNote(note.id)}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}
