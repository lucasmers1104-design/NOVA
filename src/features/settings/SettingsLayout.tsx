import { ChevronDown, type LucideIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { cn } from "@/lib/cn";

/** Settings' search found something folded away. */
export const REVEAL_SETTINGS_EVENT = "nova:reveal-settings";

interface SettingsSectionProps {
  id: string;
  title: string;
  description?: string;
  icon: LucideIcon;
  children: ReactNode;
}

export function SettingsSection({ id, title, description, icon: Icon, children }: SettingsSectionProps) {
  return (
    <section id={`settings-${id}`} aria-labelledby={`settings-${id}-title`} className="glass scroll-mt-4 rounded-widget p-6">
      <header className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-line bg-white/[0.04] text-accent-text">
          <Icon size={17} aria-hidden />
        </span>
        <div>
          <h2 id={`settings-${id}-title`} className="text-[15px] font-semibold text-fg">
            {title}
          </h2>
          {description && <p className="mt-0.5 text-[13px] text-fg-muted">{description}</p>}
        </div>
      </header>
      <div className="mt-5 divide-y divide-line">{children}</div>
    </section>
  );
}

interface SettingRowProps {
  label: string;
  description?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}

export function SettingRow({ label, description, htmlFor, children }: SettingRowProps) {
  return (
    <div data-setting={label} className="flex items-center justify-between gap-8 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-[13.5px] font-medium text-fg">
            {label}
          </label>
        ) : (
          <p className="text-[13.5px] font-medium text-fg">{label}</p>
        )}
        {description && <div className="mt-0.5 text-[12.5px] leading-relaxed text-fg-muted">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** What most people never need: folded away until asked for. */
export function MoreOptions({ label = "More options", children }: { label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  useEffect(() => {
    const reveal = () => setOpen(true);
    window.addEventListener(REVEAL_SETTINGS_EVENT, reveal);
    return () => window.removeEventListener(REVEAL_SETTINGS_EVENT, reveal);
  }, []);
  return (
    <div>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((now) => !now)} className="flex w-full items-center gap-1.5 py-3 text-left text-[12.5px] font-medium text-fg-muted transition-colors hover:text-fg">
        <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} aria-hidden />
        {label}
      </button>
      <div id={id} hidden={!open} className="divide-y divide-line pb-1">
        {children}
      </div>
    </div>
  );
}
