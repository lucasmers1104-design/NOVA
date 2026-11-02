import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { LiveDot } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";

interface WidgetFrameProps {
  title: string;
  icon: LucideIcon;
  live?: boolean;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function WidgetFrame({ title, icon: Icon, live, actions, className, children }: WidgetFrameProps) {
  return (
    <section aria-label={title} className={cn("glass flex h-full flex-col overflow-hidden rounded-widget p-5", className)}>
      <header className="mb-3 flex h-7 shrink-0 items-center gap-2">
        <Icon size={15} strokeWidth={2} className="text-accent-text" aria-hidden />
        <h2 className="text-[13px] font-semibold text-fg-muted">{title}</h2>
        {live && (
          <span className="ml-1 flex items-center gap-1.5 text-[11px] font-medium text-fg-subtle">
            <LiveDot />
            Live
          </span>
        )}
        {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}
