import { lazy, Suspense, useEffect, useRef } from "react";
import { useConsentPrompt, useTelemetryStatus } from "@/features/telemetry/api";
import { isDesktop } from "@/lib/native";
import { useSettings } from "@/stores/settings";
import { useTour } from "./store";

const TourCard = lazy(() => import("./TourCard").then((module) => ({ default: module.TourCard })));

/** Starts once, after the consent popup has had its turn. */
function useTourAutostart(): void {
  const { data: telemetry, isError } = useTelemetryStatus();
  const consentOpen = useConsentPrompt((s) => s.open);
  const seen = useSettings((s) => s.tourSeen);
  // Closing the popup without answering decides nothing, but its turn is over.
  const consentShown = useRef(false);
  if (consentOpen) consentShown.current = true;
  const consentSettled = !consentOpen && (isError || (telemetry !== undefined && (!telemetry.needsDecision || consentShown.current)));

  useEffect(() => {
    if (isDesktop() && !seen && consentSettled && !useTour.getState().open) useTour.getState().start();
  }, [seen, consentSettled]);
}

/** The hands-on introduction: appears by itself once, and from Settings or the command palette. */
export function Tour() {
  useTourAutostart();
  const open = useTour((s) => s.open);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <TourCard />
    </Suspense>
  );
}
