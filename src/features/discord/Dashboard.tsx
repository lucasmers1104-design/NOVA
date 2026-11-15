import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Hash, ImageUp, Pencil, RefreshCw, Sparkles, Users, Volume2, Wand2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { LiveDot } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { notifyError } from "@/features/notifications/store";
import { DiscordBotCard } from "@/features/settings/DiscordBotCard";
import { cn } from "@/lib/cn";
import { callNative } from "@/lib/native";
import { CHANNELS_KEY, examples, hostOf, ME_KEY, type RelayMe, type RelayStatus, STATUS_KEY, useRelayChannels, useRelayMe } from "./api";
import { ChannelEditor, type ChannelNames, namesFrom, ServerAvatar, toAliases } from "./ChannelEditor";
import { ClipDiscordCard } from "./ClipDiscordCard";
import { Avatar, ProfileLink } from "./ProfileLink";

function Card({ title, icon: Icon, actions, className, children }: { title: string; icon: typeof Hash; actions?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className={cn("glass rounded-widget p-5", className)}>
      <header className="mb-3 flex h-8 items-center gap-2">
        <Icon size={15} strokeWidth={1.8} className="text-fg-subtle" aria-hidden />
        <h2 className="flex-1 truncate text-[13px] font-medium text-fg-muted">{title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}

/** After setup: who you are, your channels, who's in a call and your picture. */
export function Dashboard({ status, onSetup, onDisconnected }: { status: RelayStatus; onSetup: () => void; onDisconnected: () => void }) {
  const channels = useRelayChannels(true);
  const calls = (channels.data?.servers ?? []).flatMap((server) => server.voice.filter((v) => v.people > 0).map((v) => ({ ...v, server: server.name })));

  return (
    <div className="grid grid-cols-12 gap-4">
      <Hero status={status} onSetup={onSetup} onDisconnected={onDisconnected} className="col-span-12" />
      <Channels status={status} className="col-span-12 lg:col-span-7" />
      <Card title="Gerade im Call" icon={Users} className="col-span-12 lg:col-span-5" actions={<LiveDot />}>
        {calls.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-fg-subtle">{channels.isError ? "Der Relay antwortet gerade nicht." : "Gerade ist niemand im Call."}</p>
        ) : (
          <ul className="space-y-2">
            {calls.map((call) => (
              <li key={call.id} className="flex items-center gap-3 rounded-xl border border-line bg-white/[0.03] px-3 py-2.5">
                <Volume2 size={15} className="text-success" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-fg">{call.name}</span>
                  <span className="block truncate text-[11.5px] text-fg-subtle">{call.server}</span>
                </span>
                <span className="rounded-full bg-success/15 px-2 py-0.5 text-[11.5px] font-medium text-success">
                  {call.people} {call.people === 1 ? "Person" : "Leute"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Sag einfach …" icon={Sparkles} className="col-span-12 lg:col-span-7">
        <ul className="space-y-2">
          {examples(status.aliases).map((sentence) => (
            <li key={sentence} className="rounded-xl border border-line bg-white/[0.03] px-3.5 py-2.5 text-[13px] text-fg">
              „{sentence}“
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11.5px] text-fg-subtle">NOVA zeigt dir vorher genau, was rausgeht. Erst wenn du bestätigst, wird geschrieben oder gesprochen.</p>
      </Card>
      <Card title="Dein Profilbild" icon={ImageUp} className="col-span-12 lg:col-span-5">
        <ProfileLink compact />
      </Card>
      <Advanced className="col-span-12" />
    </div>
  );
}

function Hero({ status, onSetup, onDisconnected, className }: { status: RelayStatus; onSetup: () => void; onDisconnected: () => void; className?: string }) {
  const client = useQueryClient();
  const me = useRelayMe(true);
  const [confirm, setConfirm] = useState(false);
  const disconnect = useMutation({
    mutationFn: () => callNative<RelayStatus>("relay_set", { address: "", key: "" }),
    onSuccess: (data) => {
      client.setQueryData(STATUS_KEY, data);
      client.removeQueries({ queryKey: ME_KEY });
      client.removeQueries({ queryKey: CHANNELS_KEY });
      onDisconnected();
    },
    onError: (error) => notifyError("Trennen hat nicht geklappt", error),
  });
  const ok = me.isSuccess;
  return (
    <section aria-label="Verbindung" className={cn("glass relative overflow-hidden rounded-widget p-6", className)}>
      <div aria-hidden className="pointer-events-none absolute -top-24 -right-16 size-72 rounded-full bg-[#5865F2]/20 blur-3xl" />
      <div className="relative flex flex-wrap items-center gap-5">
        <Avatar me={me.data} className="size-14 text-[22px] shadow-[0_12px_30px_-12px_#5865F2]" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[12px] text-fg-subtle">
            {ok ? <LiveDot /> : <span className="size-1.5 rounded-full bg-warning" aria-hidden />}
            {me.isPending ? "Verbinde …" : ok ? `Verbunden mit ${hostOf(status.address)}` : "Relay nicht erreichbar"}
          </p>
          <p className="mt-0.5 truncate text-[20px] font-semibold text-fg">{ok ? me.data.shownAs : me.isPending ? "…" : "Keine Verbindung"}</p>
          {me.isError && <p className="mt-0.5 text-[12px] text-warning">{String(me.error)}</p>}
          {ok && <Cooldowns me={me.data} fetchedAt={me.dataUpdatedAt} />}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" icon={<RefreshCw size={13} aria-hidden />} disabled={me.isFetching} onClick={() => void me.refetch()}>
            Prüfen
          </Button>
          <Button size="sm" variant="secondary" icon={<Wand2 size={13} aria-hidden />} onClick={onSetup}>
            Einrichtung
          </Button>
          {confirm ? (
            <Button size="sm" variant="danger" disabled={disconnect.isPending} onClick={() => disconnect.mutate()} onBlur={() => setConfirm(false)}>
              Wirklich trennen?
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
              Trennen
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

/** Spam protection: when the next message and announcement may go out. */
function Cooldowns({ me, fetchedAt }: { me: RelayMe; fetchedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  if (me.unlimited) {
    return <p className="mt-2 text-[12px] text-fg-subtle">Entwickler-Schlüssel aktiv: keine Pausen.</p>;
  }
  const left = (seconds = 0) => Math.max(0, seconds - (now - fetchedAt) / 1000);
  const chip = (label: string, seconds: number) => (
    <span className={cn("rounded-full px-2.5 py-1 text-[11.5px] font-medium", seconds > 0 ? "bg-warning/15 text-warning" : "bg-success/15 text-success")}>
      {label}: {seconds > 0 ? `in ${Math.ceil(seconds / 60)} Min` : "bereit"}
    </span>
  );
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" title="Schutz vor Spam: eine Nachricht alle 20 Minuten, eine Ansage alle 30 Minuten.">
      {chip("Nachricht", left(me.cooldowns?.text))}
      {chip("Ansage", left(me.cooldowns?.voice))}
    </div>
  );
}

function Channels({ status, className }: { status: RelayStatus; className?: string }) {
  const client = useQueryClient();
  const channels = useRelayChannels(true);
  const [editing, setEditing] = useState<ChannelNames | null>(null);
  const save = useMutation({
    mutationFn: (names: ChannelNames) => callNative<RelayStatus>("relay_aliases_set", { aliases: toAliases(channels.data?.servers ?? [], names) }),
    onSuccess: (data) => {
      client.setQueryData(STATUS_KEY, data);
      setEditing(null);
    },
    onError: (error) => notifyError("Die Namen ließen sich nicht speichern", error),
  });
  const people = (id: string) => channels.data?.servers.flatMap((s) => s.voice).find((v) => v.id === id)?.people ?? 0;
  const byServer = [...new Set(status.aliases.map((a) => a.server))];

  return (
    <Card
      title="Deine Kanäle"
      icon={Hash}
      className={className}
      actions={
        !editing && (
          <Button size="sm" variant="ghost" icon={<Pencil size={13} aria-hidden />} disabled={!channels.data} onClick={() => setEditing(namesFrom(status.aliases))}>
            Bearbeiten
          </Button>
        )
      }
    >
      {editing && channels.data ? (
        <div>
          <ChannelEditor servers={channels.data.servers} names={editing} onChange={setEditing} />
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              Abbrechen
            </Button>
            <Button size="sm" variant="primary" disabled={save.isPending} onClick={() => save.mutate(editing)} icon={<Check size={13} aria-hidden />}>
              Speichern
            </Button>
          </div>
        </div>
      ) : status.aliases.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-fg-subtle">Noch keine Kanäle benannt. Klick auf „Bearbeiten“.</p>
      ) : (
        <div className="space-y-4">
          {byServer.map((server) => (
            <div key={server}>
              <p className="mb-2 flex items-center gap-2 text-[12px] font-medium text-fg-muted">
                <ServerAvatar name={server} className="size-6 rounded-lg text-[10px]" />
                {server}
              </p>
              <ul className="grid gap-2 sm:grid-cols-2">
                {status.aliases
                  .filter((a) => a.server === server)
                  .map((alias) => {
                    const Icon = alias.kind === "text" ? Hash : Volume2;
                    const count = alias.kind === "voice" ? people(alias.channelId) : 0;
                    return (
                      <li key={`${alias.kind}:${alias.channelId}`} className="flex items-center gap-2.5 rounded-xl border border-line bg-white/[0.03] px-3 py-2.5">
                        <Icon size={15} className={count > 0 ? "text-success" : "text-fg-subtle"} aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-fg">{alias.name}</span>
                          <span className="block truncate text-[11.5px] text-fg-subtle">
                            {alias.kind === "text" ? "#" : ""}
                            {alias.channel}
                            {count > 0 && ` · ${count} im Call`}
                          </span>
                        </span>
                      </li>
                    );
                  })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** The older ways in: a clip webhook and an own bot for this PC only. */
function Advanced({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Erweitert" className={className}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex items-center gap-2 px-1 text-[13px] font-medium text-fg-muted hover:text-fg">
        <ChevronDown size={15} className={cn("transition-transform", open && "rotate-180")} aria-hidden />
        Erweitert: Clips schicken und eigener Bot
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="mt-3 grid gap-4 lg:grid-cols-2">
              <ClipDiscordCard />
              <DiscordBotCard />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

export { Advanced };
