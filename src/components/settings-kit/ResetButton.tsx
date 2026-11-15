import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";

interface ResetButtonProps {
  /** What the button says at rest, e.g. "Auf Standard zurücksetzen". */
  label?: string;
  /** What it says once armed. */
  confirmLabel?: string;
  disabled?: boolean;
  onReset: () => void;
}

/** How long the button stays armed before it calms down again. */
const ARMED_MS = 4000;

/** Resets on the second click, so one stray click never throws a setup away. */
export function ResetButton({ label = "Zurücksetzen …", confirmLabel = "Wirklich zurücksetzen", disabled = false, onReset }: ResetButtonProps) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), ARMED_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);

  return (
    <Button
      size="sm"
      variant={armed ? "danger" : "ghost"}
      disabled={disabled}
      icon={<RotateCcw size={13} aria-hidden />}
      onClick={() => {
        if (armed) onReset();
        setArmed(!armed);
      }}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}
