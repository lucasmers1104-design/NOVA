import { getVersion } from "@tauri-apps/api/app";
import { Download, RefreshCw, Rocket } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import { Button } from "@/components/ui/Button";
import { notify } from "@/features/notifications/store";
import { trackEvent, useConsentPrompt } from "@/features/telemetry/api";
import { useTourPending } from "@/features/tour/store";
import { formatBytes } from "@/lib/format";
import { isDesktop } from "@/lib/native";
import { useSettings } from "@/stores/settings";
import { effectiveUpdateSource, useUpdates } from "./store";
import { announceUpdate } from "./WhatsNew";

/** Delay after launch before the automatic check, so startup stays fast. */
const STARTUP_CHECK_DELAY_MS = 6000;

/**
 * Runs once per launch (including launches by "Start with Windows"): announces
 * a completed update, then checks for a new one if automatic updates are on.
 */
export function useStartupUpdates(): void {
  useEffect(() => {
    if (!isDesktop()) return;
    void getVersion().then((version) => {
      const settings = useSettings.getState();
      if (settings.lastSeenVersion && settings.lastSeenVersion !== version) {
        trackEvent("update", version, 1);
        if (!announceUpdate(settings.lastSeenVersion, version)) {
          notify(`NOVA was updated to ${version}`, { kind: "success", body: `You were on ${settings.lastSeenVersion}. Enjoy the new version!` });
        }
      }
      if (settings.lastSeenVersion !== version) settings.setLastSeenVersion(version);
    });
    const timer = window.setTimeout(() => {
      if (useSettings.getState().autoUpdate && effectiveUpdateSource()) void useUpdates.getState().check({ automatic: true });
    }, STARTUP_CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
}

export function UpdateBanner() {
  const { status, info, countdown, postponed, downloaded, total, error, installFailed, install, postpone, tick } = useUpdates();
  // The consent popup and the tour come first: no restart while someone is still in them.
  const consentOpen = useConsentPrompt((s) => s.open);
  const tourPending = useTourPending();
  const waiting = consentOpen || tourPending;
  const visible = !waiting && !postponed && info !== null && (status === "available" || status === "downloading" || status === "installing" || (status === "error" && installFailed));

  useEffect(() => {
    if (countdown === null || status !== "available" || waiting) return;
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [countdown === null, status, tick, waiting]);

  const percent = total ? Math.min(100, (downloaded / total) * 100) : null;

  return (
    <AnimatePresence>
      {visible && info && (
        <motion.section
          role="status"
          aria-live="polite"
          aria-label="Software update"
          initial={{ opacity: 0, y: 24, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 24, scale: 0.97 }}
          transition={{ type: "spring", stiffness: 380, damping: 32 }}
          className="glass-strong fixed bottom-6 left-1/2 z-[55] flex w-[min(560px,calc(100vw-48px))] -translate-x-1/2 items-center gap-4 rounded-[24px] p-4 pl-5"
        >
          <span className="accent-gradient flex size-11 shrink-0 items-center justify-center rounded-[14px] text-on-accent shadow-[0_8px_20px_-8px_var(--nova-accent-glow)]">
            {status === "available" ? <Rocket size={20} aria-hidden /> : <Download size={20} aria-hidden />}
          </span>
          <div className="min-w-0 flex-1">
            {status === "available" && (
              <>
                <p className="text-[14px] font-semibold text-fg">NOVA {info.version} is ready</p>
                <p className="mt-0.5 text-[12.5px] text-fg-muted">
                  {countdown !== null
                    ? `Installing in ${countdown} s — NOVA closes and reopens by itself.`
                    : `You have ${info.currentVersion}. Installing restarts NOVA briefly.`}
                </p>
                {info.notes && <p className="mt-1 line-clamp-1 text-[12px] text-fg-subtle">{info.notes.split("\n")[0]}</p>}
              </>
            )}
            {status === "downloading" && (
              <>
                <p className="text-[14px] font-semibold text-fg">Downloading NOVA {info.version}…</p>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.1]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
                  <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${percent ?? 15}%` }} />
                </div>
                <p className="mt-1 text-[11.5px] text-fg-subtle tabular-nums">
                  {formatBytes(downloaded)}
                  {total ? ` of ${formatBytes(total)}` : ""} · signature is verified before installing
                </p>
              </>
            )}
            {status === "installing" && (
              <>
                <p className="text-[14px] font-semibold text-fg">Installing NOVA {info.version}</p>
                <p className="mt-0.5 text-[12.5px] text-fg-muted">NOVA closes now and opens again in a moment.</p>
              </>
            )}
            {status === "error" && (
              <>
                <p className="text-[14px] font-semibold text-danger">The update couldn't be installed</p>
                <p className="mt-0.5 line-clamp-2 text-[12px] text-fg-muted">{error}</p>
              </>
            )}
          </div>
          {status === "available" && (
            <div className="flex shrink-0 gap-1.5">
              <Button size="sm" variant="ghost" onClick={postpone}>
                Later
              </Button>
              <Button size="sm" variant="primary" onClick={() => void install()}>
                Update now
              </Button>
            </div>
          )}
          {status === "error" && (
            <Button size="sm" variant="secondary" icon={<RefreshCw size={13} />} onClick={() => void useUpdates.getState().check({ automatic: false })}>
              Retry
            </Button>
          )}
        </motion.section>
      )}
    </AnimatePresence>
  );
}
