import type { LucideIcon } from "lucide-react";
import { type ReactNode, useId } from "react";
import { cn } from "@/lib/cn";

interface SettingCardProps {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  /** Beside the title, e.g. a reset button. */
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** One group of settings that belong together: a glass card with a small header. */
export function SettingCard({ title, description, icon: Icon, actions, className, children }: SettingCardProps) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className={cn("glass min-w-0 rounded-widget p-5", className)}>
      <header className="flex items-start gap-3">
        {Icon && (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] border border-line bg-white/[0.04] text-accent-text">
            <Icon size={15} aria-hidden />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-[14px] font-semibold text-fg">
            {title}
          </h3>
          {description && <p className="mt-0.5 text-[12.5px] leading-relaxed text-fg-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </header>
      <div className="mt-4 divide-y divide-line">{children}</div>
    </section>
  );
}

interface SettingLineProps {
  label: string;
  description?: ReactNode;
  /** The control's id, when the label should focus it. */
  htmlFor?: string;
  /** Stacks the control under the text, for wide controls such as sliders. */
  stacked?: boolean;
  disabled?: boolean;
  children: ReactNode;
}

/**
 * One setting: what it is on the left, its control on the right.
 * `data-setting` is what the search in Settings jumps to and lights up.
 */
export function SettingLine({ label, description, htmlFor, stacked = false, disabled = false, children }: SettingLineProps) {
  return (
    <div
      data-setting={label}
      className={cn("py-3.5 first:pt-0 last:pb-0", stacked ? "space-y-2.5" : "flex items-center justify-between gap-6", disabled && "opacity-45")}
    >
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-[13px] font-medium text-fg">
            {label}
          </label>
        ) : (
          <p className="text-[13px] font-medium text-fg">{label}</p>
        )}
        {description && <div className="mt-0.5 text-[12px] leading-relaxed text-fg-muted">{description}</div>}
      </div>
      <div className={cn(!stacked && "shrink-0")}>{children}</div>
    </div>
  );
}
