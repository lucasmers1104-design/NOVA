import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/Button";
import { FOCUSABLE } from "@/components/ui/Dialog";
import { stopSpeaking } from "@/features/nova-assistant/voice";
import { cn } from "@/lib/cn";
import { TOUR_STEPS, TOUR_TITLE_ID } from "./steps";
import { useTour } from "./store";

/**
 * The tour's one card. Most steps sit in the middle over a dimmed NOVA; the
 * steps that happen in NOVA itself move it to the corner and leave the app free.
 */
export function TourCard() {
  const step = useTour((s) => s.step);
  const goTo = useTour((s) => s.goTo);
  const close = useTour((s) => s.close);
  const cardRef = useRef<HTMLDivElement>(null);
  const previous = useRef(step);
  const direction = step >= previous.current ? 1 : -1;
  const current = TOUR_STEPS[step]!;
  const docked = current.docked ?? false;
  const last = step === TOUR_STEPS.length - 1;
  const Body = current.body;

  useEffect(() => {
    previous.current = step;
    stopSpeaking();
  }, [step]);

  useEffect(() => {
    const card = cardRef.current;
    if (card && !card.contains(document.activeElement)) card.querySelector<HTMLElement>("[data-tour-next]")?.focus();
  }, [step]);

  // Keys stay with NOVA while the card is in the corner: that's what those steps practice.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (docked || !cardRef.current) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...cardRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const lastOne = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      lastOne.focus();
    } else if (!event.shiftKey && document.activeElement === lastOne) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <>
      <AnimatePresence>
        {!docked && <motion.div key="scrim" className="fixed inset-0 z-[56] bg-black/60" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} />}
      </AnimatePresence>
      <div className={cn("pointer-events-none fixed inset-0 z-[56] flex p-6", docked ? "items-end justify-end" : "items-center justify-center")}>
        <motion.div
          ref={cardRef}
          layout="position"
          role="dialog"
          aria-modal={!docked}
          aria-labelledby={TOUR_TITLE_ID}
          onKeyDown={onKeyDown}
          initial={{ opacity: 0, y: 14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
          className={cn("glass-strong pointer-events-auto flex max-h-full w-full flex-col overflow-hidden rounded-[28px] outline-none", docked ? "max-w-[400px]" : "max-w-[640px]")}
        >
          <header className="flex items-center gap-4 px-6 pt-5">
            <ol aria-label={`Schritt ${step + 1} von ${TOUR_STEPS.length}`} className="flex min-w-0 flex-1 gap-1">
              {TOUR_STEPS.map((item, index) => (
                <li key={item.id} className="min-w-0 flex-1">
                  <button
                    type="button"
                    title={item.label}
                    aria-label={item.label}
                    aria-current={index === step ? "step" : undefined}
                    onClick={() => goTo(index)}
                    className="group flex h-5 w-full items-center"
                  >
                    <span className={cn("h-1 w-full rounded-full transition-colors duration-300 group-hover:bg-accent-text", index <= step ? "bg-accent" : "bg-white/[0.1]")} />
                  </button>
                </li>
              ))}
            </ol>
            {!last && (
              <button type="button" onClick={close} className="shrink-0 text-[12px] text-fg-subtle transition-colors hover:text-fg">
                Überspringen
              </button>
            )}
          </header>

          <div className={cn("min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-6 pt-3 pb-5", !docked && "min-h-[372px]")}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={current.id}
                initial={{ opacity: 0, x: 18 * direction }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -14 * direction }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              >
                <Body />
              </motion.div>
            </AnimatePresence>
          </div>

          <footer className="flex items-center justify-between gap-2 border-t border-line px-6 py-3.5">
            <Button variant="ghost" size="sm" disabled={step === 0} className={cn(step === 0 && "invisible")} onClick={() => goTo(step - 1)}>
              Zurück
            </Button>
            <Button variant="primary" size="md" data-tour-next onClick={() => (last ? close() : goTo(step + 1))}>
              {last ? "Los geht's" : step === 0 ? "Zeig's mir" : "Weiter"}
            </Button>
          </footer>
        </motion.div>
      </div>
    </>,
    document.body,
  );
}
