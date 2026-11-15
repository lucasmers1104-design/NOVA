import type { CSSProperties, ReactNode } from "react";
import { Backdrop } from "@/components/layout/Backdrop";
import { cn } from "@/lib/cn";

export type StageBackdrop = "nova" | "dusk" | "daylight";

const BACKDROPS: Record<Exclude<StageBackdrop, "nova">, string> = {
  dusk: "radial-gradient(120% 90% at 20% 0%, #2b3350 0%, transparent 60%), radial-gradient(90% 80% at 100% 100%, #3a2d52 0%, transparent 65%), linear-gradient(180deg, #171b2b, #0d101a)",
  daylight: "radial-gradient(110% 90% at 15% 0%, #f5f7fb 0%, transparent 60%), radial-gradient(90% 90% at 100% 100%, #c9d6ee 0%, transparent 70%), linear-gradient(180deg, #e6ebf5, #b9c6de)",
};

interface PreviewStageProps {
  /** What the stage shows, for screen readers. */
  label: string;
  /** NOVA's own background as it is set right now, or a neutral one. */
  backdrop?: StageBackdrop;
  /** Sketches a taskbar along the bottom, so the stage reads as a desktop. */
  taskbar?: boolean;
  height?: number;
  /** Laid over the stage's bottom left corner (the top belongs to what is previewed), e.g. the backdrop choice. */
  corner?: ReactNode;
  /** Keeps the stage in view at the top while the page below it scrolls. */
  sticky?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/**
 * The live stage of a settings page: a framed piece of desktop on which the thing
 * being set up is shown for real, not as a picture of it.
 */
export function PreviewStage({ label, backdrop = "nova", taskbar = false, height = 260, corner, sticky = false, className, style, children }: PreviewStageProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "isolate overflow-hidden rounded-widget border border-white/10 bg-canvas shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_30px_60px_-30px_rgb(0_0_0/0.8)]",
        sticky ? "sticky top-0 z-20" : "relative",
        className,
      )}
      style={{ height, ...style }}
    >
      {backdrop === "nova" ? <Backdrop /> : <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: BACKDROPS[backdrop] }} />}
      {taskbar && (
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 flex h-9 items-center justify-center gap-2 border-t border-white/10 bg-black/35 backdrop-blur-md">
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className={cn("size-4 rounded-[5px]", i === 0 ? "bg-accent/80" : "bg-white/20")} />
          ))}
        </div>
      )}
      <div className="relative h-full w-full">{children}</div>
      {/* Its own dark pane: the control must read on a light backdrop as well as on a dark one. */}
      {corner && <div className={cn("absolute left-3 z-10 rounded-full bg-[#0d101a]/70 backdrop-blur-md", taskbar ? "bottom-12" : "bottom-3")}>{corner}</div>}
    </div>
  );
}
