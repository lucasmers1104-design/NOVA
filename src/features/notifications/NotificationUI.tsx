import { useSettings } from "@/stores/settings";
import { Bell, BellRing, CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";
import { Button, IconButton } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { type AppNotification, type NotificationKind, useNotifications } from "./store";

const ICONS: Record<NotificationKind, typeof Info> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert,
  reminder: BellRing,
};

const TONES: Record<NotificationKind, string> = {
  info: "text-accent-text",
  success: "text-success",
  warning: "text-warning",
  error: "text-danger",
  reminder: "text-accent-text",
};

function timeAgo(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: useSettings.getState().use24HourClock ? "h23" : "h12" });
}

/** Transient toasts, bottom-right. */
export function Toaster() {
  const items = useNotifications((s) => s.items);
  const toasts = useNotifications((s) => s.toasts);
  const dismiss = useNotifications((s) => s.dismissToast);
  const visible = toasts.map((id) => items.find((i) => i.id === id)).filter((i): i is AppNotification => Boolean(i));

  return (
    <div aria-live="polite" className="pointer-events-none fixed right-5 bottom-5 z-[60] flex w-[360px] flex-col gap-2">
      <AnimatePresence initial={false}>
        {visible.map((item) => {
          const Icon = ICONS[item.kind];
          return (
            <motion.div
              key={item.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
              transition={{ type: "spring", stiffness: 420, damping: 34 }}
              role={item.kind === "error" ? "alert" : "status"}
              className="glass-strong pointer-events-auto flex items-start gap-3 rounded-[16px] p-3.5"
            >
              <Icon size={18} className={cn("mt-0.5 shrink-0", TONES[item.kind])} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-fg">{item.title}</p>
                {item.body && <p className="mt-0.5 line-clamp-3 text-[12px] text-fg-muted">{item.body}</p>}
              </div>
              <IconButton size="sm" label="Dismiss" onClick={() => dismiss(item.id)} className="-mt-1 -mr-1">
                <X size={14} />
              </IconButton>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

/** Title-bar button with unread badge that opens the notification center. */
export function NotificationButton() {
  const unread = useNotifications((s) => s.items.filter((i) => !i.read).length);
  const open = useNotifications((s) => s.centerOpen);
  const setOpen = useNotifications((s) => s.setCenterOpen);
  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
      aria-expanded={open}
      className="relative flex size-8 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-white/[0.08] hover:text-fg"
    >
      <Bell size={16} aria-hidden />
      {unread > 0 && (
        <span className="absolute top-1 right-1 flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] leading-4 font-semibold text-on-accent">
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </button>
  );
}

export function NotificationCenter() {
  const open = useNotifications((s) => s.centerOpen);
  const setOpen = useNotifications((s) => s.setCenterOpen);
  const items = useNotifications((s) => s.items);
  const remove = useNotifications((s) => s.remove);
  const clear = useNotifications((s) => s.clear);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Element;
      if (!panelRef.current?.contains(target) && !target.closest("[aria-label^=Notifications]")) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open, setOpen]);

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          ref={panelRef}
          aria-label="Notification center"
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 24 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="glass-strong fixed top-14 right-3 bottom-3 z-40 flex w-[380px] flex-col rounded-[22px]"
        >
          <header className="flex items-center justify-between px-5 pt-4 pb-3">
            <h2 className="text-[15px] font-semibold text-fg">Notifications</h2>
            <div className="flex items-center gap-1">
              {items.length > 0 && (
                <Button size="sm" variant="ghost" onClick={clear} className="h-7">
                  Clear all
                </Button>
              )}
              <IconButton size="sm" label="Close notifications" onClick={() => setOpen(false)}>
                <X size={15} />
              </IconButton>
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            {items.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <Bell size={22} className="text-fg-subtle" aria-hidden />
                <p className="text-[13px] text-fg-muted">You're all caught up.</p>
                <p className="max-w-60 text-[12px] text-fg-subtle">Reminders, app launches and problems appear here.</p>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {items.map((item) => {
                  const Icon = ICONS[item.kind];
                  return (
                    <li key={item.id} className="group flex items-start gap-3 rounded-[14px] bg-white/[0.035] p-3">
                      <Icon size={16} className={cn("mt-0.5 shrink-0", TONES[item.kind])} aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium text-fg">{item.title}</p>
                        {item.body && <p className="mt-0.5 text-[12px] text-fg-muted">{item.body}</p>}
                        <p className="mt-1 text-[11px] text-fg-subtle">{timeAgo(item.at)}</p>
                      </div>
                      <IconButton size="sm" label={`Remove “${item.title}”`} onClick={() => remove(item.id)} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100">
                        <X size={13} />
                      </IconButton>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
