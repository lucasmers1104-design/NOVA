import { ChevronDown, type LucideIcon, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { cn } from "@/lib/cn";

/** Settings' search found something folded away. */
export const REVEAL_SETTINGS_EVENT = "nova:reveal-settings";

/**
 * Text fields and selects in Settings. The border lights up in the accent on focus, since the field has no outline.
 * Add width and font to it, never another padding, size or background: class names are joined, not merged.
 */
export const FIELD = "h-9 rounded-control border border-line bg-black/25 px-3 text-[13px] text-fg outline-none select-text placeholder:text-fg-subtle focus:border-accent-text/70 disabled:opacity-45";

interface SettingsSectionProps {
  id: string;
  title: string;
  description?: ReactNode;
  icon: LucideIcon;
  /** Beside the title, e.g. the section's main switch or a reset button. */
  actions?: ReactNode;
  children?: ReactNode;
}

/**
 * One page of Settings, built like Island Studio: a header that says what this is,
 * then a stage (where there is something to see) and the cards of the settings kit.
 */
export function SettingsSection({ id, title, description, icon: Icon, actions, children }: SettingsSectionProps) {
  return (
    <section id={`settings-${id}`} aria-labelledby={`settings-${id}-title`} className="space-y-4">
      <header className="glass flex items-center gap-3 rounded-widget px-5 py-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-line bg-white/[0.04] text-accent-text">
          <Icon size={17} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={`settings-${id}-title`} className="text-[15px] font-semibold text-fg">
            {title}
          </h2>
          {description && <p className="mt-0.5 text-[12.5px] leading-relaxed text-fg-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2.5">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** A section's main switch in its header, with its name beside it. `data-setting` lets the search light it up. */
export function HeaderSwitch({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div data-setting={label} className="flex shrink-0 items-center gap-2.5 border-l border-line pl-4 text-[12.5px] text-fg">
      {label}
      {children}
    </div>
  );
}

/** A plain sentence in place of the cards, e.g. where a section needs the desktop app. */
export function SettingsNotice({ children }: { children: ReactNode }) {
  return <p className="glass rounded-widget px-5 py-4 text-[13px] leading-relaxed text-fg-muted">{children}</p>;
}

/** What a section promises about privacy, under its cards. */
export function PrivacyNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 px-1 text-[12.5px] leading-relaxed text-fg-muted">
      <ShieldCheck size={14} className="mt-0.5 shrink-0 text-success" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

interface MoreOptionsProps {
  title?: string;
  description?: string;
  icon?: LucideIcon;
  children: ReactNode;
}

/**
 * What most people never need: a card that stays folded until asked for.
 * It opens by itself when the search leads to a setting inside it.
 */
export function MoreOptions({ title = "Erweitert", description, icon: Icon = SlidersHorizontal, children }: MoreOptionsProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  useEffect(() => {
    const reveal = () => setOpen(true);
    window.addEventListener(REVEAL_SETTINGS_EVENT, reveal);
    return () => window.removeEventListener(REVEAL_SETTINGS_EVENT, reveal);
  }, []);
  return (
    <section aria-label={title} className="glass min-w-0 rounded-widget">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((now) => !now)} className="flex w-full items-center gap-3 rounded-widget p-5 text-left">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] border border-line bg-white/[0.04] text-accent-text">
          <Icon size={15} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold text-fg">{title}</span>
          {description && <span className="mt-0.5 block text-[12.5px] leading-relaxed text-fg-muted">{description}</span>}
        </span>
        <ChevronDown size={16} className={cn("shrink-0 text-fg-subtle transition-transform duration-200 ease-nova", open && "rotate-180")} aria-hidden />
      </button>
      {/* Hidden, not unmounted: the search finds a row in here before the card has opened. */}
      <div id={id} hidden={!open} className="divide-y divide-line px-5 pb-5">
        {children}
      </div>
    </section>
  );
}
