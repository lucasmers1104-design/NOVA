import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { Suspense, useEffect, useRef } from "react";
import { Backdrop } from "@/components/layout/Backdrop";
import { Sidebar } from "@/components/layout/Sidebar";
import { TitleBar } from "@/components/layout/TitleBar";
import { Skeleton } from "@/components/ui/Skeleton";
import { useThemeSync } from "@/design/theme";
import { useWallpaperAccentSync } from "@/design/wallpaper";
import { CommandPalette } from "@/features/command-palette/CommandPalette";
import { useDesktopSync } from "@/features/desktop/useDesktopSync";
import { NotificationCenter, Toaster } from "@/features/notifications/NotificationUI";
import { useReminders } from "@/features/productivity/reminders";
import { type MotionPreference, useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { ROUTES } from "./routes";
import { useGlobalShortcuts } from "./useGlobalShortcuts";

const REDUCED_MOTION: Record<MotionPreference, "user" | "always" | "never"> = {
  system: "user",
  reduced: "always",
  full: "never",
};

export function AppShell() {
  useThemeSync();
  useWallpaperAccentSync();
  useGlobalShortcuts();
  useReminders();
  useDesktopSync();
  const route = useUi((s) => s.route);
  const motionPreference = useSettings((s) => s.motion);
  const mainRef = useRef<HTMLElement>(null);
  const Page = ROUTES[route];

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [route]);

  return (
    <MotionConfig reducedMotion={REDUCED_MOTION[motionPreference]}>
      {/* overflow-clip (not hidden): the shell must never be scrolled programmatically, e.g. by scrollIntoView. */}
      <div className="relative flex h-full overflow-clip bg-canvas">
        <Backdrop />
        <Sidebar />
        <div className="relative flex min-w-0 flex-1 flex-col">
          <TitleBar />
          {/* relative: absolutely positioned descendants (e.g. sr-only live regions) stay inside the scroll area. */}
          <main ref={mainRef} id="main" tabIndex={-1} className="relative min-h-0 flex-1 overflow-y-auto outline-none">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={route}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0, transition: { duration: 0.26, ease: [0.22, 1, 0.36, 1] } }}
                exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
              >
                <Suspense fallback={<PageFallback />}>
                  <Page />
                </Suspense>
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
        <CommandPalette />
        <NotificationCenter />
        <Toaster />
      </div>
    </MotionConfig>
  );
}

function PageFallback() {
  return (
    <div className="mx-auto grid max-w-[1440px] grid-cols-12 gap-4 px-7 pt-3" aria-busy="true" aria-label="Loading">
      <Skeleton className="col-span-8 h-52 rounded-widget" />
      <Skeleton className="col-span-4 h-52 rounded-widget" />
      <Skeleton className="col-span-4 h-72 rounded-widget" />
      <Skeleton className="col-span-4 h-72 rounded-widget" />
      <Skeleton className="col-span-4 h-72 rounded-widget" />
    </div>
  );
}
