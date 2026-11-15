import { Check, Hash, Volume2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { cn } from "@/lib/cn";
import type { ChannelKind, RelayAlias, RelayServer } from "./api";

/** Names by `kind:channelId`, the way the editor keeps them while you type. */
export type ChannelNames = Record<string, string>;

const SUGGESTIONS: Record<ChannelKind, string[]> = {
  text: ["die Jungs", "Familie", "Allgemein", "Team"],
  voice: ["Zocken", "Lobby", "Call", "Chill"],
};

export const nameKey = (kind: ChannelKind, id: string) => `${kind}:${id}`;

export function namesFrom(aliases: RelayAlias[]): ChannelNames {
  return Object.fromEntries(aliases.map((a) => [nameKey(a.kind, a.channelId), a.name]));
}

/** Turns what was typed into the list NOVA saves, in the order the server shows its channels. */
export function toAliases(servers: RelayServer[], names: ChannelNames): RelayAlias[] {
  return servers.flatMap((server) =>
    (["text", "voice"] as const).flatMap((kind) =>
      server[kind]
        .map((channel) => ({ name: (names[nameKey(kind, channel.id)] ?? "").trim(), channelId: channel.id, channel: channel.name, server: server.name, kind }))
        .filter((alias) => alias.name),
    ),
  );
}

export function ServerAvatar({ name, className }: { name: string; className?: string }) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  return (
    <span aria-hidden className={cn("grid size-10 shrink-0 place-items-center rounded-2xl bg-[#5865F2] text-[14px] font-semibold text-white shadow-[0_6px_18px_-8px_#5865F2]", className)}>
      {letters || "?"}
    </span>
  );
}

interface ChannelEditorProps {
  servers: RelayServer[];
  names: ChannelNames;
  onChange: (names: ChannelNames) => void;
}

/** Every server as a card, its channels as chips: click one and give it the name you'd say. */
export function ChannelEditor({ servers, names, onChange }: ChannelEditorProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const setName = (key: string, value: string) => onChange({ ...names, [key]: value });

  if (servers.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-line p-6 text-center text-[13px] text-fg-muted">
        Der Bot ist noch auf keinem Server, den dein Schlüssel nutzen darf. Lade ihn über das Discord Developer Portal auf deinen Server ein.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {servers.map((server) => {
        const open = (["text", "voice"] as const).flatMap((kind) => server[kind].map((c) => ({ ...c, kind }))).find((c) => nameKey(c.kind, c.id) === editing);
        return (
          <section key={server.id} aria-label={server.name} className="rounded-2xl border border-line bg-white/[0.02] p-4">
            <header className="flex items-center gap-3">
              <ServerAvatar name={server.name} />
              <div className="min-w-0">
                <p className="truncate text-[14px] font-medium text-fg">{server.name}</p>
                <p className="text-[12px] text-fg-subtle">
                  {server.text.length} Text · {server.voice.length} Sprache
                </p>
              </div>
            </header>

            <div className="mt-3 flex flex-wrap gap-2">
              {(["text", "voice"] as const).flatMap((kind) =>
                server[kind].map((channel) => {
                  const key = nameKey(kind, channel.id);
                  const named = (names[key] ?? "").trim();
                  const people = "people" in channel ? (channel.people as number) : 0;
                  const Icon = kind === "text" ? Hash : Volume2;
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={editing === key}
                      aria-label={`${channel.name} (${kind === "text" ? "Text" : "Sprache"})${named ? `, heißt „${named}“` : ""}`}
                      onClick={() => setEditing(editing === key ? null : key)}
                      className={cn(
                        "flex h-9 items-center gap-1.5 rounded-full border px-3 text-[12.5px] transition-all",
                        named ? "accent-soft border-accent/40 text-fg" : "border-line bg-white/[0.03] text-fg-muted hover:border-line-strong hover:text-fg",
                        editing === key && "ring-2 ring-accent/50",
                      )}
                    >
                      <Icon size={13} aria-hidden className="text-fg-subtle" />
                      {channel.name}
                      {people > 0 && (
                        <span className="ml-0.5 flex items-center gap-1 text-[11px] text-success">
                          <span className="size-1.5 rounded-full bg-success" aria-hidden />
                          {people}
                        </span>
                      )}
                      {named && <span className="ml-1 rounded-full bg-accent/25 px-2 py-0.5 text-[11px] font-medium text-fg">{named}</span>}
                    </button>
                  );
                }),
              )}
            </div>

            <AnimatePresence initial={false}>
              {open && (
                <motion.div key={editing} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                  <NameField
                    kind={open.kind}
                    channel={open.name}
                    value={names[nameKey(open.kind, open.id)] ?? ""}
                    onChange={(value) => setName(nameKey(open.kind, open.id), value)}
                    onDone={() => setEditing(null)}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        );
      })}
    </div>
  );
}

function NameField({ kind, channel, value, onChange, onDone }: { kind: ChannelKind; channel: string; value: string; onChange: (value: string) => void; onDone: () => void }) {
  const label = kind === "text" ? `Wie nennst du #${channel}?` : `Wie nennst du den Sprachkanal ${channel}?`;
  return (
    <div className="mt-3 rounded-xl border border-line bg-black/20 p-3">
      <label className="block text-[12.5px] font-medium text-fg">
        {label}
        <div className="mt-2 flex gap-2">
          <input
            autoFocus
            maxLength={40}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onDone();
            }}
            placeholder={SUGGESTIONS[kind][0]}
            className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-white/[0.04] px-3 text-[13px] text-fg outline-none placeholder:text-fg-subtle focus:border-accent/60"
          />
          <button type="button" onClick={onDone} aria-label="Fertig" className="grid size-9 place-items-center rounded-lg bg-accent text-on-accent hover:bg-accent-strong">
            <Check size={15} aria-hidden />
          </button>
          {value && (
            <button
              type="button"
              onClick={() => {
                onChange("");
                onDone();
              }}
              aria-label="Name entfernen"
              className="grid size-9 place-items-center rounded-lg border border-line text-fg-muted hover:text-fg"
            >
              <X size={15} aria-hidden />
            </button>
          )}
        </div>
      </label>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {[...new Set([...SUGGESTIONS[kind], channel])].map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onChange(suggestion)}
            className="rounded-full border border-line px-2.5 py-1 text-[11.5px] text-fg-muted transition-colors hover:border-accent/40 hover:text-fg"
          >
            {suggestion}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[11.5px] text-fg-subtle">So sagst du es NOVA: {kind === "text" ? `„Schreib in ${value || SUGGESTIONS.text[0]} …“` : `„Sag im ${value || SUGGESTIONS.voice[0]}-Call …“`}</p>
    </div>
  );
}
