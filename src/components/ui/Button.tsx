import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-accent bg-[linear-gradient(180deg,rgb(255_255_255/0.2),rgb(255_255_255/0))] text-on-accent shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_8px_24px_-10px_var(--nova-accent-glow)] hover:bg-accent-strong",
  secondary:
    "bg-white/[0.07] text-fg border border-white/[0.1] shadow-[inset_0_1px_0_rgb(255_255_255/0.1)] hover:bg-white/[0.12] hover:border-white/[0.16]",
  ghost: "text-fg-muted hover:text-fg hover:bg-white/[0.06]",
  danger: "bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
};

export function Button({ variant = "secondary", size = "md", icon, className, children, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-medium whitespace-nowrap",
        "transition-[background-color,border-color,color,box-shadow,transform] duration-200 ease-nova active:scale-[0.98]",
        "disabled:pointer-events-none disabled:opacity-45",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: "sm" | "md";
}

export function IconButton({ label, size = "md", className, children, type = "button", ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full text-fg-muted",
        "transition-colors duration-200 ease-nova hover:bg-white/[0.07] hover:text-fg",
        "disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "size-7" : "size-9",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
