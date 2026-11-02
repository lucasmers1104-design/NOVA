import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { ShieldCheck, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Kbd } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { notifyError } from "@/features/notifications/store";
import { SettingRow, SettingsSection } from "@/features/settings/SettingsLayout";
import { cn } from "@/lib/cn";
import { isDesktop } from "@/lib/native";
import { assistantStatus, configureAssistant, resetDotPosition } from "./api";
import { captureShortcut, shortcutLabels } from "./shortcut";
import { ASSISTANT_EVENTS, type AssistantPrefsUpdate, type AssistantStatus, type DotCorner, type DotSize } from "./types";

export const ASSISTANT_STATUS_KEY = ["assistant", "status"] as const;

const CORNERS = [
  { value: "bottomRight", label: "Bottom right" },
  { value: "bottomLeft", label: "Bottom left" },
  { value: "topRight", label: "Top right" },
  { value: "topLeft", label: "Top left" },
] as const satisfies readonly { value: DotCorner; label: string }[];

const SIZES = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
] as const satisfies readonly { value: DotSize; label: string }[];

/** Settings → NOVA AI assistant. The preferences live on the Rust side, which applies them to the windows. */
export function AssistantSettings() {
  const desktop = isDesktop();
  const client = useQueryClient();
  const { data: status } = useQuery({ queryKey: ASSISTANT_STATUS_KEY, queryFn: assistantStatus, enabled: desktop });
  const [rejected, setRejected] = useState<string | null>(null);

  const configure = useMutation({
    mutationFn: configureAssistant,
    onSuccess: (next) => {
      client.setQueryData(ASSISTANT_STATUS_KEY, next);
      setRejected(null);
    },
    onError: (error) => setRejected(error instanceof Error ? error.message : String(error)),
  });
  const reset = useMutation({
    mutationFn: resetDotPosition,
    onSuccess: (next) => client.setQueryData(ASSISTANT_STATUS_KEY, next),
    onError: (error) => notifyError("Couldn't move the dot", error),
  });

  // The dot changes preferences too: dragging it, or "Hide the dot" in its menu.
  useEffect(() => {
    if (!desktop) return;
    const unlisten = listen<AssistantStatus>(ASSISTANT_EVENTS.prefs, (event) => client.setQueryData(ASSISTANT_STATUS_KEY, event.payload));
    return () => void unlisten.then((stop) => stop());
  }, [client, desktop]);

  const update = (patch: Partial<AssistantPrefsUpdate>) => {
    if (!status) return;
    const { enabled, corner, size, shortcut, background, hideInFullscreen } = status;
    configure.mutate({ enabled, corner, size, shortcut, background, hideInFullscreen, ...patch });
  };

  if (!desktop) {
    return (
      <SettingsSection id="assistant" title="NOVA AI assistant" description="A floating dot that opens NOVA AI from anywhere on your desktop." icon={Sparkles}>
        <p className="text-[13px] text-fg-muted">Available in the NOVA desktop app.</p>
      </SettingsSection>
    );
  }

  const busy = !status || configure.isPending;
  const shortcutProblem = rejected ?? status?.shortcutError ?? null;

  return (
    <SettingsSection id="assistant" title="NOVA AI assistant" description="A floating dot that opens NOVA AI from anywhere on your desktop." icon={Sparkles}>
      <SettingRow label="Show the NOVA dot" description="Floats above other windows. Click it to open NOVA AI, drag it to move it, right-click it for options.">
        <Switch label="Show the NOVA dot" checked={status?.enabled ?? false} disabled={busy} onChange={(enabled) => update({ enabled })} />
      </SettingRow>
      <SettingRow
        label="Position"
        description={
          status?.customPosition ? (
            <>
              Where you dragged it.{" "}
              <button type="button" className="font-medium text-accent-text hover:underline" onClick={() => reset.mutate()}>
                Move it back to the corner
              </button>
            </>
          ) : (
            "A corner of your main display. You can also drag the dot anywhere, on any display."
          )
        }
      >
        <SegmentedControl label="Dot position" value={status?.corner ?? "bottomRight"} options={CORNERS} onChange={(corner) => update({ corner })} />
      </SettingRow>
      <SettingRow label="Size">
        <SegmentedControl label="Dot size" value={status?.size ?? "medium"} options={SIZES} onChange={(size) => update({ size })} />
      </SettingRow>
      <SettingRow
        label="Keyboard shortcut"
        description={shortcutProblem ? <span className="text-danger">{shortcutProblem}</span> : "Opens and closes NOVA AI from any app."}
      >
        <ShortcutField
          value={status?.shortcut ?? ""}
          defaultShortcut={status?.defaultShortcut ?? ""}
          disabled={busy}
          onChange={(shortcut) => update({ shortcut })}
        />
      </SettingRow>
      <SettingRow label="Hide the dot in fullscreen apps" description="While a game, video or presentation fills the screen. Off: the dot stays on top of everything.">
        <Switch
          label="Hide the dot in fullscreen apps"
          checked={status?.hideInFullscreen ?? false}
          disabled={busy || !status?.enabled}
          onChange={(hideInFullscreen) => update({ hideInFullscreen })}
        />
      </SettingRow>
      <SettingRow
        label="Keep NOVA AI available when the window is closed"
        description="Closing NOVA's window keeps the dot and the shortcut working; quit from the tray icon. Together with Start with Windows, NOVA starts with just the dot."
      >
        <Switch
          label="Keep NOVA AI available when the window is closed"
          checked={status?.background ?? false}
          disabled={busy}
          onChange={(background) => update({ background })}
        />
      </SettingRow>
      <p className="flex items-start gap-2 pt-4 text-[12.5px] leading-relaxed text-fg-muted">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-success" aria-hidden />
        The dot doesn't use your microphone or capture your screen. Voice and screen features will only ever run when you start them.
      </p>
    </SettingsSection>
  );
}

interface ShortcutFieldProps {
  value: string;
  defaultShortcut: string;
  disabled: boolean;
  onChange: (shortcut: string) => void;
}

/** Records a shortcut from the next key combination pressed. Esc cancels. */
function ShortcutField({ value, defaultShortcut, disabled, onChange }: ShortcutFieldProps) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Captured first, so NOVA's own shortcuts (Ctrl+K, ...) don't fire while recording.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey) {
        setRecording(false);
        setHint(null);
        return;
      }
      const capture = captureShortcut(event);
      if (capture.kind === "pending") return;
      if (capture.kind === "invalid") {
        setHint("Add Ctrl, Alt or Win");
        return;
      }
      setRecording(false);
      setHint(null);
      onChangeRef.current(capture.shortcut);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording]);

  const keys = shortcutLabels(value);
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        disabled={disabled}
        aria-label={recording ? "Press the new shortcut, or Esc to cancel" : "Change keyboard shortcut"}
        onClick={() => {
          setHint(null);
          setRecording((r) => !r);
        }}
        onBlur={() => setRecording(false)}
        className={cn(
          "flex h-9 min-w-40 items-center justify-center gap-1 rounded-control border bg-black/25 px-3 text-[13px] transition-colors disabled:opacity-50",
          recording ? "border-accent/60" : "border-line hover:border-line-strong",
        )}
      >
        {recording ? (
          <span className={hint ? "text-warning" : "text-accent-text"}>{hint ?? "Press keys…"}</span>
        ) : keys.length > 0 ? (
          keys.map((key) => <Kbd key={key}>{key}</Kbd>)
        ) : (
          <span className="text-fg-subtle">None</span>
        )}
      </button>
      {!recording && value && (
        <IconButton label="Remove shortcut" size="sm" disabled={disabled} onClick={() => onChange("")}>
          <X size={14} aria-hidden />
        </IconButton>
      )}
      {!recording && !value && defaultShortcut && (
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(defaultShortcut)}>
          Use {shortcutLabels(defaultShortcut).join("+")}
        </Button>
      )}
    </div>
  );
}
