import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ImageUp, Unlink } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { notifyError } from "@/features/notifications/store";
import { cn } from "@/lib/cn";
import { callNative } from "@/lib/native";
import { ME_KEY, type RelayLinkCode, type RelayMe, useRelayMe } from "./api";

/** The user's Discord picture once linked, else their initial on Discord's colors. */
export function Avatar({ me, className }: { me: RelayMe | undefined; className?: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [me?.avatar]);
  if (me?.avatar && !broken) {
    return <img src={me.avatar} alt="" onError={() => setBroken(true)} className={cn("shrink-0 rounded-full object-cover", className)} />;
  }
  return (
    <span aria-hidden className={cn("grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#8b5cf6] to-[#5865F2] font-semibold text-white", className)}>
      {(me?.name ?? "N").trim()[0]?.toUpperCase()}
    </span>
  );
}

/**
 * Linking the user's Discord account, so messages carry their own picture: NOVA gets a code from
 * the relay, the user types `/nova code:<code>` in Discord, and this watches until it's linked.
 */
export function ProfileLink({ compact = false }: { compact?: boolean }) {
  const client = useQueryClient();
  const me = useRelayMe(true);
  const [code, setCode] = useState<RelayLinkCode | null>(null);
  const [copied, setCopied] = useState(false);
  const linked = me.data?.linked ?? false;
  const command = code ? `/nova code:${code.code}` : "";

  const create = useMutation({
    mutationFn: () => callNative<RelayLinkCode>("relay_link"),
    onSuccess: setCode,
    onError: (error) => notifyError("Kein Code bekommen", error),
  });
  const unlink = useMutation({
    mutationFn: () => callNative("relay_unlink"),
    onSuccess: () => void client.invalidateQueries({ queryKey: ME_KEY }),
    onError: (error) => notifyError("Trennen hat nicht geklappt", error),
  });

  // While a code is out, look every few seconds whether it was typed in Discord.
  useEffect(() => {
    if (!code || linked) return;
    const poll = setInterval(() => void client.invalidateQueries({ queryKey: ME_KEY }), 3000);
    const expire = setTimeout(() => setCode(null), code.expiresIn * 1000);
    return () => {
      clearInterval(poll);
      clearTimeout(expire);
    };
  }, [code, linked, client]);
  useEffect(() => {
    if (linked) setCode(null);
  }, [linked]);

  const copy = () => {
    void navigator.clipboard
      .writeText(command)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => notifyError("Kopieren hat nicht geklappt", command));
  };

  return (
    <div className={cn("flex flex-col items-center text-center", compact && "items-start text-left")}>
      <div className="relative">
        <motion.div key={me.data?.avatar ?? "none"} initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 300, damping: 20 }}>
          <Avatar me={me.data} className={compact ? "size-14 text-[20px]" : "size-20 text-[28px]"} />
        </motion.div>
        {linked && (
          <span className="absolute -right-1 -bottom-1 grid size-6 place-items-center rounded-full border-2 border-[#1e1f22] bg-success text-white">
            <Check size={12} strokeWidth={3} aria-label="verknüpft" />
          </span>
        )}
      </div>

      {linked ? (
        <>
          <p className="mt-3 text-[13px] text-fg">Deine Nachrichten tragen dein Discord-Profilbild.</p>
          <Button className="mt-3" size="sm" variant="ghost" icon={<Unlink size={13} aria-hidden />} disabled={unlink.isPending} onClick={() => unlink.mutate()}>
            Verknüpfung lösen
          </Button>
        </>
      ) : code ? (
        <AnimatePresence>
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className={cn("mt-4 w-full max-w-sm", compact && "max-w-none")}>
            <p className="text-[12.5px] text-fg-muted">Schreib das in Discord, in irgendeinen Kanal mit dem Bot:</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 rounded-xl bg-black/30 px-3 py-2.5 font-mono text-[15px] tracking-wide text-fg">{command}</code>
              <button
                type="button"
                aria-label="Befehl kopieren"
                onClick={copy}
                className="grid size-10 shrink-0 place-items-center rounded-xl border border-line text-fg-muted transition-colors hover:text-fg"
              >
                {copied ? <Check size={15} className="text-success" aria-hidden /> : <Copy size={15} aria-hidden />}
              </button>
            </div>
            <p className="mt-2 flex items-center gap-2 text-[11.5px] text-fg-subtle">
              <motion.span className="size-1.5 rounded-full bg-accent" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.4, repeat: Number.POSITIVE_INFINITY }} aria-hidden />
              Warte auf Discord … Nur du siehst die Antwort des Bots.
            </p>
          </motion.div>
        </AnimatePresence>
      ) : (
        <>
          <p className="mt-3 max-w-sm text-[13px] text-fg-muted">Ohne Verknüpfung zeigt Discord das Standardbild. Verknüpf dein Konto, und NOVA schreibt mit deinem Profilbild.</p>
          <Button className="mt-3" size="sm" variant="primary" icon={<ImageUp size={14} aria-hidden />} disabled={create.isPending || !me.isSuccess} onClick={() => create.mutate()}>
            Profilbild verknüpfen
          </Button>
        </>
      )}
    </div>
  );
}
