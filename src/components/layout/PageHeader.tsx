import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 flex items-end justify-between gap-6">
      <div className="min-w-0">
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.015em] text-fg">{title}</h1>
        {description && <p className="mt-1 text-[13px] text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Standard horizontal padding and max width for page content. */
export function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[1440px] px-7 pt-3 pb-10">{children}</div>;
}
