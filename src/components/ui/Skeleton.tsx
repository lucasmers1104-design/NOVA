import { cn } from "@/lib/cn";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "rounded-[8px] bg-[linear-gradient(90deg,rgb(255_255_255/0.04)_25%,rgb(255_255_255/0.09)_50%,rgb(255_255_255/0.04)_75%)] bg-[length:200%_100%]",
        "animate-[nova-shimmer_1.6s_linear_infinite]",
        className,
      )}
    />
  );
}
