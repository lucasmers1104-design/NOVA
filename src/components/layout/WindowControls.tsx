import { getCurrentWindow } from "@tauri-apps/api/window";
import { type ReactNode, useEffect, useState } from "react";
import { flushDashboardSaves } from "@/features/dashboard/store";
import { noteDraft } from "@/features/productivity/store";
import { isDesktop } from "@/lib/native";
import { cn } from "@/lib/cn";

/** Windows-style caption buttons for the frameless main window. */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const desktop = isDesktop();

  useEffect(() => {
    if (!desktop) return;
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const sync = () => {
      win.isMaximized().then((value) => !disposed && setMaximized(value), () => {});
    };
    sync();
    win.onResized(sync).then(
      (fn) => (disposed ? fn() : (unlisten = fn)),
      () => {},
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktop]);

  if (!desktop) return null;
  const win = getCurrentWindow();

  return (
    <div className="flex h-full items-stretch">
      <CaptionButton label="Minimize" onClick={() => void win.minimize()}>
        <path d="M0 5.5h10" />
      </CaptionButton>
      <CaptionButton label={maximized ? "Restore" : "Maximize"} onClick={() => void win.toggleMaximize()}>
        {maximized ? (
          <>
            <path d="M2.5 2.5V0.5h7v7h-2" />
            <rect x="0.5" y="2.5" width="7" height="7" />
          </>
        ) : (
          <rect x="0.5" y="0.5" width="9" height="9" />
        )}
      </CaptionButton>
      <CaptionButton
        label="Close"
        danger
        onClick={() => {
          // Let in-flight saves finish before the window goes away.
          void Promise.allSettled([flushDashboardSaves(), noteDraft.flush()]).finally(() => void win.close());
        }}
      >
        <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
      </CaptionButton>
    </div>
  );
}

function CaptionButton({ label, danger, onClick, children }: { label: string; danger?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex w-[46px] items-center justify-center text-fg-muted transition-colors duration-150",
        danger ? "hover:bg-[#e81123] hover:text-white" : "hover:bg-white/[0.07] hover:text-fg",
      )}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" shapeRendering="crispEdges" aria-hidden>
        {children}
      </svg>
    </button>
  );
}
