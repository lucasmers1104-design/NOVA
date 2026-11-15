import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, CircleCheck, ImageUp, KeyRound, Link2, MessageSquareText, PartyPopper, Sparkles } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ClipboardEvent, useEffect, useState } from "react";
import { NovaMark } from "@/components/brand/NovaMark";
import { Button } from "@/components/ui/Button";
import { notifyError } from "@/features/notifications/store";
import { cn } from "@/lib/cn";
import { callNative } from "@/lib/native";
import { CHANNELS_KEY, examples, ME_KEY, parseInvite, type RelayMe, type RelayStatus, STATUS_KEY, useRelayChannels, useRelayMe } from "./api";
import { ChannelEditor, type ChannelNames, namesFrom, toAliases } from "./ChannelEditor";
import { DiscordPreview } from "./DiscordPreview";
import { ProfileLink } from "./ProfileLink";

const STEPS = ["Verbinden", "Kanäle", "Profilbild", "Los geht's"] as const;

const FIELD = "h-11 w-full rounded-xl border border-line bg-white/[0.04] px-3.5 text-[13.5px] text-fg outline-none placeholder:text-fg-subtle focus:border-accent/60";

/** First run: four short steps instead of a wall of fields. */
export function Setup({ status, onDone }: { status: RelayStatus; onDone: () => void }) {
  const [step, setStep] = useState(status.configured ? 1 : 0);
  return (
    <div className="glass mx-auto max-w-3xl overflow-hidden rounded-widget">
      <Progress step={step} />
      <div className="p-7">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={step} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={{ duration: 0.22 }}>
            {step === 0 && <ConnectStep onNext={() => setStep(1)} />}
            {step === 1 && <ChannelsStep status={status} onBack={() => setStep(0)} onNext={() => setStep(2)} />}
            {step === 2 && <PictureStep status={status} onNext={() => setStep(3)} />}
            {step === 3 && <DoneStep status={status} onDone={onDone} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function Progress({ step }: { step: number }) {
  return (
    <div className="border-b border-line px-7 pt-5 pb-4">
      <ol className="flex items-center gap-2" aria-label="Einrichtung">
        {STEPS.map((label, index) => (
          <li key={label} className="flex flex-1 items-center gap-2" aria-current={index === step ? "step" : undefined}>
            <span
              className={cn(
                "grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold transition-colors",
                index < step ? "bg-success/20 text-success" : index === step ? "bg-accent text-on-accent" : "bg-white/[0.06] text-fg-subtle",
              )}
            >
              {index < step ? <Check size={12} aria-hidden /> : index + 1}
            </span>
            <span className={cn("hidden text-[12px] sm:inline", index === step ? "font-medium text-fg" : "text-fg-subtle")}>{label}</span>
            {index < STEPS.length - 1 && <span className={cn("h-px flex-1 transition-colors", index < step ? "bg-success/40" : "bg-line")} aria-hidden />}
          </li>
        ))}
      </ol>
    </div>
  );
}

function StepTitle({ icon: Icon, title, text }: { icon: typeof Link2; title: string; text: string }) {
  return (
    <div className="mb-6">
      <span className="accent-soft mb-3 inline-grid size-10 place-items-center rounded-2xl">
        <Icon size={18} className="text-accent-text" aria-hidden />
      </span>
      <h2 className="text-[20px] font-semibold tracking-[-0.01em] text-fg">{title}</h2>
      <p className="mt-1 max-w-xl text-[13px] text-fg-muted">{text}</p>
    </div>
  );
}

/** NOVA ↔ Discord, with little dots running between them while it connects. */
function Bridge({ busy, done }: { busy: boolean; done: boolean }) {
  return (
    <div className="mb-6 flex items-center justify-center gap-4" aria-hidden>
      <span className="grid size-14 place-items-center rounded-2xl bg-white/[0.05]">
        <NovaMark size={30} />
      </span>
      <span className="relative flex w-24 items-center justify-between">
        {[0, 1, 2, 3, 4].map((i) => (
          <motion.span
            key={i}
            className={cn("size-1.5 rounded-full", done ? "bg-success" : "bg-fg-subtle")}
            animate={busy ? { opacity: [0.2, 1, 0.2] } : { opacity: done ? 1 : 0.35 }}
            transition={busy ? { duration: 1, repeat: Number.POSITIVE_INFINITY, delay: i * 0.12 } : { duration: 0.3 }}
          />
        ))}
      </span>
      <span className="grid size-14 place-items-center rounded-2xl bg-[#5865F2] text-white shadow-[0_10px_30px_-12px_#5865F2]">
        <MessageSquareText size={26} />
      </span>
    </div>
  );
}

function ConnectStep({ onNext }: { onNext: () => void }) {
  const client = useQueryClient();
  const [address, setAddress] = useState("");
  const [key, setKey] = useState("");
  const [welcome, setWelcome] = useState<RelayMe | null>(null);

  const connect = useMutation({
    mutationFn: async () => {
      const status = await callNative<RelayStatus>("relay_set", { address, key });
      try {
        const me = await callNative<RelayMe>("relay_check");
        return { status, me };
      } catch (error) {
        // Saved but not reachable or not accepted: don't keep a key that doesn't work.
        await callNative<RelayStatus>("relay_set", { address: "", key: "" }).catch(() => {});
        throw error;
      }
    },
    onSuccess: ({ status, me }) => {
      client.setQueryData(STATUS_KEY, status);
      client.setQueryData(ME_KEY, me);
      setWelcome(me);
    },
    onError: (error) => notifyError("Das hat nicht geklappt", error),
  });

  useEffect(() => {
    if (!welcome) return;
    const timer = setTimeout(onNext, 1800);
    return () => clearTimeout(timer);
  }, [welcome, onNext]);

  /** Pasting an invite with both parts into either field fills both. */
  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    const found = parseInvite(event.clipboardData.getData("text"));
    if (found.address && found.key) {
      event.preventDefault();
      setAddress(found.address);
      setKey(found.key);
    }
  };

  if (welcome) {
    return (
      <div className="py-6 text-center">
        <Bridge busy={false} done />
        <motion.p initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="text-[22px] font-semibold text-fg">
          Hey {welcome.name}! 👋
        </motion.p>
        <p className="mt-2 text-[13px] text-fg-muted">
          Verbunden. Deine Nachrichten erscheinen als <strong className="text-fg">{welcome.shownAs}</strong>.
        </p>
      </div>
    );
  }

  const ready = parseInvite(address).address && parseInvite(key).key;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) connect.mutate();
      }}
    >
      <Bridge busy={connect.isPending} done={false} />
      <StepTitle icon={Link2} title="Verbinde NOVA mit Discord" text="Du brauchst die Adresse eures Relays und deinen eigenen Schlüssel. Beides bekommst du von dem, der den Relay betreibt. Hast du beides in einer Nachricht? Füg sie einfach in ein Feld ein." />
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-fg">
            <Link2 size={13} aria-hidden /> Relay-Adresse
            {parseInvite(address).address && <CircleCheck size={13} className="text-success" aria-label="erkannt" />}
          </span>
          <input value={address} onChange={(event) => setAddress(event.target.value)} onPaste={paste} type="url" autoComplete="off" placeholder="https://…" className={FIELD} />
        </label>
        <label className="block">
          <span className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-fg">
            <KeyRound size={13} aria-hidden /> Dein Schlüssel
            {parseInvite(key).key && <CircleCheck size={13} className="text-success" aria-label="erkannt" />}
          </span>
          <input value={key} onChange={(event) => setKey(event.target.value)} onPaste={paste} type="password" autoComplete="off" placeholder="nova_…" className={FIELD} />
          <span className="mt-1.5 block text-[11.5px] text-fg-subtle">Er bleibt im Windows-Tresor auf diesem PC und wird nirgends angezeigt.</span>
        </label>
      </div>
      <div className="mt-6 flex justify-end">
        <Button variant="primary" type="submit" disabled={!ready || connect.isPending} icon={<ArrowRight size={15} aria-hidden />}>
          {connect.isPending ? "Verbinde …" : "Verbinden"}
        </Button>
      </div>
    </form>
  );
}

function ChannelsStep({ status, onBack, onNext }: { status: RelayStatus; onBack: () => void; onNext: () => void }) {
  const client = useQueryClient();
  const channels = useRelayChannels(true);
  const [names, setNames] = useState<ChannelNames>(() => namesFrom(status.aliases));
  const aliases = toAliases(channels.data?.servers ?? [], names);

  const save = useMutation({
    mutationFn: () => callNative<RelayStatus>("relay_aliases_set", { aliases }),
    onSuccess: (data) => {
      client.setQueryData(STATUS_KEY, data);
      onNext();
    },
    onError: (error) => notifyError("Die Namen ließen sich nicht speichern", error),
  });
  const disconnect = useMutation({
    mutationFn: () => callNative<RelayStatus>("relay_set", { address: "", key: "" }),
    onSuccess: (data) => {
      client.setQueryData(STATUS_KEY, data);
      client.removeQueries({ queryKey: CHANNELS_KEY });
      onBack();
    },
  });

  return (
    <div>
      <StepTitle
        icon={MessageSquareText}
        title="Gib deinen Kanälen Namen"
        text="Klick einen Kanal an und sag, wie du ihn nennst. Genau so sprichst du später mit NOVA: „Schreib in die Jungs …“ oder „Sag im Zocken-Call …“."
      />
      {channels.isPending && <p className="py-8 text-center text-[13px] text-fg-muted">Kanäle werden geladen …</p>}
      {channels.isError && <p className="py-8 text-center text-[13px] text-warning">{String(channels.error)}</p>}
      {channels.data && <ChannelEditor servers={channels.data.servers} names={names} onChange={setNames} />}
      <div className="mt-6 flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" icon={<ArrowLeft size={14} aria-hidden />} disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
          Anderer Schlüssel
        </Button>
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-fg-subtle">{aliases.length ? `${aliases.length} benannt` : "Noch keiner benannt"}</span>
          <Button variant="primary" disabled={aliases.length === 0 || save.isPending} onClick={() => save.mutate()} icon={<ArrowRight size={15} aria-hidden />}>
            Weiter
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Optional: the user's own Discord picture on their messages, shown in a preview. */
function PictureStep({ status, onNext }: { status: RelayStatus; onNext: () => void }) {
  const me = useRelayMe(true);
  const channel = status.aliases.find((a) => a.kind === "text")?.channel;
  const linked = me.data?.linked ?? false;
  return (
    <div>
      <StepTitle icon={ImageUp} title="Dein Profilbild" text="So sehen deine Nachrichten über NOVA in Discord aus. Mit einem Befehl in Discord tragen sie dein eigenes Profilbild statt des Standardbilds." />
      <div className="grid items-center gap-6 md:grid-cols-[1fr_1.2fr]">
        <ProfileLink />
        <DiscordPreview author={me.data?.shownAs ?? "NOVA"} avatar={me.data?.avatar} channel={channel} text="Bin in 10 Minuten online 🎮" />
      </div>
      <div className="mt-6 flex justify-end">
        <Button variant={linked ? "primary" : "ghost"} onClick={onNext} icon={<ArrowRight size={15} aria-hidden />}>
          {linked ? "Weiter" : "Später"}
        </Button>
      </div>
    </div>
  );
}

function DoneStep({ status, onDone }: { status: RelayStatus; onDone: () => void }) {
  return (
    <div className="text-center">
      <motion.span
        initial={{ scale: 0.6, rotate: -12, opacity: 0 }}
        animate={{ scale: 1, rotate: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 14 }}
        className="accent-soft mx-auto mb-4 grid size-16 place-items-center rounded-3xl"
      >
        <PartyPopper size={28} className="text-accent-text" aria-hidden />
      </motion.span>
      <h2 className="text-[22px] font-semibold text-fg">Alles bereit!</h2>
      <p className="mt-1 text-[13px] text-fg-muted">Sag NOVA einfach, was es in Discord tun soll. Du siehst vorher immer genau, was rausgeht.</p>
      <ul className="mx-auto mt-6 max-w-md space-y-2 text-left">
        {examples(status.aliases).map((sentence, index) => (
          <motion.li
            key={sentence}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 + index * 0.08 }}
            className="flex items-start gap-2.5 rounded-xl border border-line bg-white/[0.03] px-3.5 py-2.5 text-[13px] text-fg"
          >
            <Sparkles size={14} className="mt-0.5 shrink-0 text-accent-text" aria-hidden />„{sentence}“
          </motion.li>
        ))}
      </ul>
      <div className="mt-7 flex justify-center">
        <Button variant="primary" onClick={onDone} icon={<ArrowRight size={15} aria-hidden />}>
          Zur Übersicht
        </Button>
      </div>
    </div>
  );
}
