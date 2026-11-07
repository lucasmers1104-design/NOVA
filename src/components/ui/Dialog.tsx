import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { IconButton } from "./Button";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "md" | "lg";
}

export const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])';

export function Dialog(props: DialogProps) {
  // In the body: inside a glass widget, `fixed` would be relative to the widget and get clipped.
  return createPortal(<AnimatePresence>{props.open && <DialogPanel {...props} />}</AnimatePresence>, document.body);
}

/** Modal dialog: traps focus, closes on Escape or backdrop click, restores focus on close. */
function DialogPanel({ onClose, title, description, children, footer, size = "md" }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>("[data-autofocus]") ?? panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
    return () => previous?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) return;
    const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        initial={{ opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 6, scale: 0.98 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className={cn(
          "glass-strong flex max-h-[85vh] w-full flex-col overflow-hidden rounded-[28px] outline-none",
          size === "lg" ? "max-w-2xl" : "max-w-md",
        )}
      >
        <header className="flex items-start justify-between gap-4 px-6 pt-5 pb-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[16px] font-semibold text-fg">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-1 text-[13px] text-fg-muted">
                {description}
              </p>
            )}
          </div>
          <IconButton label="Close" size="sm" onClick={onClose} className="-mt-0.5 -mr-2">
            <X size={16} />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line px-6 py-4">{footer}</footer>}
      </motion.div>
    </motion.div>
  );
}
