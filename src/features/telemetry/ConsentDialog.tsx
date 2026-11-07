import { Check, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { notifyError } from "@/features/notifications/store";
import { callNative, isDesktop } from "@/lib/native";
import { useUi } from "@/stores/ui";
import { trackEvent, useConsentPrompt, useTelemetryDecision, useTelemetryStatus } from "./api";

export const SENT_ITEMS = ["NOVA-Version und Online-Status, auch wenn NOVA im Hintergrund läuft", "Nutzungsdauer und Programmstarts", "welche Bereiche und Funktionen genutzt werden", "Ergebnisse von Updates"];
export const NEVER_SENT = "Chats, Spracheingaben, Dateien, Screenshots, Tastatureingaben, Fenster- und Programmnamen";

/** Asks once. Nothing is sent before a click on "Akzeptieren". */
export function ConsentDialog() {
  const { data: status } = useTelemetryStatus();
  const open = useConsentPrompt((s) => s.open);
  const setOpen = useConsentPrompt((s) => s.setOpen);
  const decide = useTelemetryDecision();
  const asked = useRef(false);

  useEffect(() => {
    if (status?.needsDecision && !asked.current) {
      asked.current = true;
      setOpen(true);
    }
  }, [status?.needsDecision, setOpen]);

  const answer = (accepted: boolean) => {
    decide.mutate(accepted, {
      // Couldn't be saved: nothing is sent, and it asks again at the next start.
      onError: (error) => notifyError("NOVA couldn't save your decision", error),
      onSettled: () => setOpen(false),
    });
  };

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title="Hilf mit, NOVA besser zu machen"
      description="Mit deiner Zustimmung sendet NOVA Nutzungsstatistiken an den Statistikdienst des Entwicklers."
      footer={
        <div className="flex w-full items-center gap-2.5">
          <Button variant="secondary" size="md" className="flex-1" disabled={decide.isPending} onClick={() => answer(false)}>
            Nicht zustimmen
          </Button>
          <Button variant="primary" size="md" className="flex-[1.4]" disabled={decide.isPending} onClick={() => answer(true)}>
            Akzeptieren
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-[13px] leading-relaxed">
        <div className="rounded-[14px] border border-line bg-white/[0.03] p-3.5">
          <p className="mb-1.5 flex items-center gap-2 font-medium text-fg">
            <Check size={15} className="text-success" aria-hidden /> Gesendet wird
          </p>
          <ul className="space-y-0.5 pl-[23px] text-fg-muted">
            {SENT_ITEMS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-[14px] border border-line bg-white/[0.03] p-3.5">
          <p className="mb-1.5 flex items-center gap-2 font-medium text-fg">
            <X size={15} className="text-danger" aria-hidden /> Niemals
          </p>
          <p className="pl-[23px] text-fg-muted">{NEVER_SENT}</p>
        </div>
        <p className="flex items-start gap-2 text-[12px] text-fg-subtle">
          <ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            Du kannst jederzeit unter Settings → Privacy widerrufen. NOVA funktioniert auch ohne Zustimmung vollständig.{" "}
            <button type="button" className="text-accent-text underline underline-offset-2" onClick={() => status && void callNative("open_url", { url: status.privacyUrl }).catch((error: unknown) => notifyError("Couldn't open the page", error))}>
              Datenschutzhinweis
            </button>
          </span>
        </p>
      </div>
    </Dialog>
  );
}

/** Reports how long each page was open. Rust drops this without consent. */
export function usePageTracking(): void {
  const route = useUi((s) => s.route);
  const since = useRef({ route, at: Date.now() });

  useEffect(() => {
    if (!isDesktop() || route === since.current.route) return;
    trackEvent("page", since.current.route, Date.now() - since.current.at);
    since.current = { route, at: Date.now() };
  }, [route]);
}
