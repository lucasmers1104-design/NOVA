import { cn } from "@/lib/cn";

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-200 ease-nova",
        "disabled:opacity-45",
        checked ? "border-transparent bg-accent" : "border-line-strong bg-white/[0.08]",
      )}
    >
      <span
        className={cn(
          "inline-block size-[18px] rounded-full shadow-sm transition-transform duration-200 ease-nova",
          checked ? "translate-x-[22px] bg-on-accent" : "translate-x-[3px] bg-fg-muted",
        )}
      />
    </button>
  );
}
