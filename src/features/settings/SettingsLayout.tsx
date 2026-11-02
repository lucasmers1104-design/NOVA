import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

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
    <div className="flex items-center justify-between gap-8 py-4 first:pt-0 last:pb-0">
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
