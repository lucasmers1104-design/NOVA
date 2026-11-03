import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { Check, RotateCcw, ShieldCheck, Sparkles, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Kbd } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { notifyError } from "@/features/notifications/store";
import { SettingRow, SettingsSection } from "@/features/settings/SettingsLayout";
import { cn } from "@/lib/cn";
import { callNative, isDesktop } from "@/lib/native";
import { assistantStatus, configureAssistant, resetDotPosition } from "./api";
import { NovaDot } from "./components/NovaDot";
import { captureShortcut, shortcutLabels } from "./shortcut";
import { ASSISTANT_EVENTS, type AssistantPrefsUpdate, type AssistantStatus, DEFAULT_DOT_LOOK, type DotCorner, type DotLook, type DotPlacement, type DotStyle } from "./types";

export const ASSISTANT_STATUS_KEY = ["assistant", "status"] as const;
/** Shared with Settings → Startup, so both switches stay in sync. */
const AUTOSTART_KEY = ["desktop", "autostart"] as const;

const PLACEMENTS = [
  { value: "taskbar", label: "In the taskbar" },
  { value: "corner", label: "In a corner" },
] as const satisfies readonly { value: DotPlacement; label: string }[];

const CORNERS = [
  { value: "bottomRight", label: "Bottom right" },
  { value: "bottomLeft", label: "Bottom left" },
  { value: "topRight", label: "Top right" },
  { value: "topLeft", label: "Top left" },
] as const satisfies readonly { value: DotCorner; label: string }[];

const STYLES = [
  { value: "glass", label: "Glass" },
  { value: "orb", label: "Orb" },
  { value: "solid", label: "Flat" },
  { value: "ring", label: "Ring" },
] as const satisfies readonly { value: DotStyle; label: string }[];

/** Color choices besides a custom one: the accent follows NOVA's theme. */
const SWATCHES = [
  { value: "accent", label: "Accent color", css: "var(--color-accent)" },
  { value: "white", label: "White", css: "#f3f4f8" },
  { value: "#60a5fa", label: "Blue", css: "#60a5fa" },
  { value: "#34d399", label: "Green", css: "#34d399" },
  { value: "#f472b6", label: "Pink", css: "#f472b6" },
  { value: "#fbbf24", label: "Amber", css: "#fbbf24" },
  { value: "#94a3b8", label: "Slate", css: "#94a3b8" },
] as const;

/** Changes from sliders are sent this long after the last move. */
const SAVE_DELAY_MS = 220;

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
  const { data: autostart } = useQuery({ queryKey: AUTOSTART_KEY, queryFn: () => callNative<boolean>("autostart_get"), enabled: desktop });
  const setAutostart = useMutation({
    mutationFn: (enabled: boolean) => callNative<boolean>("autostart_set", { enabled }),
    onSuccess: (enabled) => client.setQueryData(AUTOSTART_KEY, enabled),
    onError: (error) => notifyError("Couldn't change the startup setting", error),
  });

  // The dot changes preferences too: dragging it, or "Hide the dot" in its menu.
  useEffect(() => {
    if (!desktop) return;
    const unlisten = listen<AssistantStatus>(ASSISTANT_EVENTS.prefs, (event) => client.setQueryData(ASSISTANT_STATUS_KEY, event.payload));
    return () => void unlisten.then((stop) => stop());
  }, [client, desktop]);

  const update = (patch: Partial<AssistantPrefsUpdate>) => {
    if (!status) return;
    const { enabled, placement, corner, look, shortcut, background, hideInFullscreen } = status;
    configure.mutate({ enabled, placement, corner, look, shortcut, background, hideInFullscreen, ...patch });
  };

  if (!desktop) {
    return (
      <SettingsSection id="assistant" title="NOVA AI assistant" description="A small dot that opens NOVA AI from anywhere on your desktop." icon={Sparkles}>
        <p className="text-[13px] text-fg-muted">Available in the NOVA desktop app.</p>
      </SettingsSection>
    );
  }

  const busy = !status || configure.isPending;
  const shortcutProblem = rejected ?? status?.shortcutError ?? null;
  const placement = status?.placement ?? "taskbar";
  const inTaskbar = placement === "taskbar" && (status?.taskbarAvailable ?? true) && !status?.customPosition;

  return (
    <SettingsSection id="assistant" title="NOVA AI assistant" description="A small dot that opens NOVA AI from anywhere on your desktop." icon={Sparkles}>
      <SettingRow label="Show the NOVA dot" description="Click it to open NOVA AI, drag it to move it, right-click it for options.">
        <Switch label="Show the NOVA dot" checked={status?.enabled ?? false} disabled={busy} onChange={(enabled) => update({ enabled })} />
      </SettingRow>

      {status && (
        <DotLookEditor
          look={status.look}
          placement={inTaskbar ? "taskbar" : "corner"}
          disabled={!status.enabled}
          onChange={(look) => update({ look })}
        />
      )}

      <SettingRow
        label="Where it sits"
        description={
          status?.customPosition ? (
            <>
              Where you dragged it.{" "}
              <button type="button" className="font-medium text-accent-text hover:underline" onClick={() => reset.mutate()}>
                Put it back
              </button>
            </>
          ) : placement === "taskbar" && status && !status.taskbarAvailable ? (
            "Your taskbar hides itself, so the dot uses the corner below instead."
          ) : placement === "taskbar" ? (
            "In the taskbar, right after your app buttons. It hides with the taskbar while a fullscreen app runs."
          ) : (
            "Above the taskbar in a corner of your main display. You can also drag the dot anywhere, on any display."
          )
        }
      >
        <SegmentedControl label="Dot placement" value={placement} options={PLACEMENTS} onChange={(next) => update({ placement: next })} />
      </SettingRow>
      {(placement === "corner" || (status && !status.taskbarAvailable)) && (
        <>
          <SettingRow label="Corner">
            <SegmentedControl label="Dot corner" value={status?.corner ?? "bottomRight"} options={CORNERS} onChange={(corner) => update({ corner })} />
          </SettingRow>
          {status && (
            <SettingRow label="Distance from the edge">
              <Slider
                label="Distance from the screen edge"
                value={status.look.edgeGap}
                min={0}
                max={48}
                step={2}
                format={(v) => `${v} px`}
                onCommit={(edgeGap) => update({ look: { ...status.look, edgeGap } })}
              />
            </SettingRow>
          )}
        </>
      )}

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
      {!inTaskbar && (
        <SettingRow label="Hide the dot in fullscreen apps" description="While a game, video or presentation fills the screen. Off: the dot stays on top of everything.">
          <Switch
            label="Hide the dot in fullscreen apps"
            checked={status?.hideInFullscreen ?? false}
            disabled={busy || !status?.enabled}
            onChange={(hideInFullscreen) => update({ hideInFullscreen })}
          />
        </SettingRow>
      )}
      <SettingRow
        label="Keep NOVA AI available when the window is closed"
        description={
          status?.enabled
            ? "Always, while the dot is shown: closing the window keeps the dot, the shortcut and “Hey NOVA” working. Quit from the tray icon or the dot's menu."
            : "Closing NOVA's window keeps the shortcut and “Hey NOVA” working; quit from the tray icon."
        }
      >
        <Switch
          label="Keep NOVA AI available when the window is closed"
          checked={(status?.background || status?.enabled) ?? false}
          disabled={busy || status?.enabled}
          onChange={(background) => update({ background })}
        />
      </SettingRow>
      <SettingRow label="Start with Windows" description="NOVA starts in the background with just the dot, so it's there after every restart.">
        <Switch
          label="Start with Windows"
          checked={autostart ?? false}
          disabled={autostart === undefined || setAutostart.isPending}
          onChange={(enabled) => setAutostart.mutate(enabled)}
        />
      </SettingRow>
      <p className="flex items-start gap-2 pt-4 text-[12.5px] leading-relaxed text-fg-muted">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-success" aria-hidden />
        The dot itself never uses your microphone or captures your screen. Only “Hey NOVA” and the double clap listen, and only while you turn them on.
      </p>
    </SettingsSection>
  );
}

interface DotLookEditorProps {
  look: DotLook;
  placement: DotPlacement;
  disabled: boolean;
  onChange: (look: DotLook) => void;
}

/** Style, size, color and behavior of the dot, with a live preview. */
export function DotLookEditor({ look, placement, disabled, onChange }: DotLookEditorProps) {
  // The preview follows every change at once; the dot itself after a short pause.
  const [draft, setDraft] = useState(look);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!timer.current) setDraft(look);
  }, [look]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const change = (patch: Partial<DotLook>, delay = 0) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      onChange(next);
    }, delay);
  };
  const customColor = draft.color.startsWith("#") && !SWATCHES.some((s) => s.value === draft.color);

  return (
    <div className={cn("mb-2 rounded-[18px] border border-line bg-white/[0.025] p-4", disabled && "pointer-events-none opacity-50")} aria-disabled={disabled}>
      <div className="flex flex-wrap items-start gap-5">
        <DotPreview look={draft} placement={placement} />
        <div className="min-w-0 flex-1 basis-64 space-y-3.5">
          <LookRow label="Style">
            <SegmentedControl label="Dot style" value={draft.style} options={STYLES} onChange={(style) => change({ style })} />
          </LookRow>
          <LookRow label="Size">
            <Slider label="Dot size" value={draft.diameter} min={16} max={56} step={2} format={(v) => `${v} px`} onInput={(diameter) => change({ diameter }, SAVE_DELAY_MS)} />
          </LookRow>
          <LookRow label="At rest">
            <Slider
              label="Opacity at rest"
              value={draft.idleOpacity}
              min={25}
              max={100}
              step={5}
              format={(v) => `${v} %`}
              onInput={(idleOpacity) => change({ idleOpacity }, SAVE_DELAY_MS)}
            />
          </LookRow>
          <LookRow label="Color">
            <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Dot color">
              {SWATCHES.map((swatch) => (
                <button
                  key={swatch.value}
                  type="button"
                  role="radio"
                  aria-checked={draft.color === swatch.value}
                  aria-label={swatch.label}
                  title={swatch.label}
                  onClick={() => change({ color: swatch.value })}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border border-white/20 transition-transform outline-none hover:scale-110 focus-visible:ring-2 focus-visible:ring-accent",
                    draft.color === swatch.value && "ring-2 ring-fg/80 ring-offset-2 ring-offset-transparent",
                  )}
                  style={{ background: swatch.css }}
                >
                  {draft.color === swatch.value && <Check size={12} className={swatch.value === "white" ? "text-black/70" : "text-white"} aria-hidden />}
                </button>
              ))}
              <label
                title="Custom color"
                className={cn(
                  "relative flex size-6 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-white/20 bg-[conic-gradient(#f87171,#fbbf24,#34d399,#60a5fa,#a78bfa,#f472b6,#f87171)] transition-transform hover:scale-110 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent",
                  customColor && "ring-2 ring-fg/80 ring-offset-2 ring-offset-transparent",
                )}
                style={customColor ? { background: draft.color } : undefined}
              >
                <input
                  type="color"
                  aria-label="Custom color"
                  value={draft.color.startsWith("#") ? draft.color : "#8b5cf6"}
                  onChange={(e) => change({ color: e.target.value }, SAVE_DELAY_MS)}
                  className="absolute inset-0 cursor-pointer opacity-0"
                />
              </label>
            </div>
          </LookRow>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-x-4 gap-y-2 pt-1">
            <Toggle label="Sparkle inside" checked={draft.icon} onChange={(icon) => change({ icon })} />
            <Toggle label="Show what NOVA is doing" checked={draft.activity} onChange={(activity) => change({ activity })} />
            <Toggle label="Glow" checked={draft.glow} onChange={(glow) => change({ glow, breathe: glow && draft.breathe })} />
            <Toggle label="Breathe now and then" checked={draft.breathe && draft.glow} disabled={!draft.glow} onChange={(breathe) => change({ breathe })} />
          </div>
          <button
            type="button"
            onClick={() => change({ ...DEFAULT_DOT_LOOK, edgeGap: draft.edgeGap })}
            className="flex items-center gap-1.5 text-[12px] font-medium text-fg-muted hover:text-fg"
          >
            <RotateCcw size={12} aria-hidden /> Back to the default look
          </button>
        </div>
      </div>
    </div>
  );
}

/** The dot as it will look, on a strip of taskbar or desktop. Hover it to see it fully. */
function DotPreview({ look, placement }: { look: DotLook; placement: DotPlacement }) {
  const [shown, setShown] = useState<PreviewState>("idle");
  const state = shown === "hover" ? "idle" : shown;
  const dot = <NovaDot look={look} open={false} state={state} level={0.5} hovered={shown === "hover"} onToggle={() => {}} onMenu={() => {}} onDragStart={() => {}} />;
  return (
    <div className="w-64 max-w-full shrink-0">
      <div
        className={cn(
          "relative flex h-36 items-end overflow-hidden rounded-[14px] border border-line",
          "bg-[radial-gradient(120%_90%_at_20%_10%,rgb(99_102_241/0.35),transparent_60%),radial-gradient(90%_80%_at_90%_30%,rgb(236_72_153/0.22),transparent_60%),#0d1020]",
        )}
        role="group"
        aria-label="Dot preview"
      >
        {placement === "taskbar" ? (
          <div className="flex h-10 w-full items-center justify-end gap-2 bg-[#1b1d26]/95 pr-2.5 pl-3">
            <span className="mr-auto flex gap-1.5" aria-hidden>
              {[0, 1, 2].map((i) => (
                <span key={i} className="size-5 rounded-[5px] bg-white/[0.12]" />
              ))}
            </span>
            {dot}
            <span className="flex items-center gap-1.5 text-[10px] text-white/60" aria-hidden>
              <span className="size-2.5 rounded-full bg-white/30" />
              <span className="size-2.5 rounded-full bg-white/30" />
              19:30
            </span>
          </div>
        ) : (
          <div className="flex w-full flex-col items-end">
            <div className="p-3">
              {dot}
            </div>
            <div className="h-6 w-full bg-[#1b1d26]/95" aria-hidden />
          </div>
        )}
      </div>
      <div className="mt-2 flex justify-center">
        <SegmentedControl
          label="Preview state"
          value={shown}
          options={PREVIEW_STATES}
          onChange={setShown}
        />
      </div>
    </div>
  );
}

type PreviewState = "idle" | "hover" | "listening" | "thinking";

const PREVIEW_STATES = [
  { value: "idle", label: "Rest" },
  { value: "hover", label: "Hover" },
  { value: "listening", label: "Listen" },
  { value: "thinking", label: "Think" },
] as const satisfies readonly { value: PreviewState; label: string }[];

function LookRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-[12.5px] text-fg-muted">{label}</span>
      {children}
    </div>
  );
}

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className={cn("flex items-center justify-between gap-3 text-[12.5px] text-fg", disabled && "opacity-50")}>
      {label}
      <Switch label={label} checked={checked} disabled={disabled} onChange={onChange} />
    </label>
  );
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  /** Every move. */
  onInput?: (value: number) => void;
  /** Once the user lets go (or after keyboard changes). */
  onCommit?: (value: number) => void;
}

/** A range slider with its value. */
export function Slider({ label, value, min, max, step, format, onInput, onCommit }: SliderProps) {
  const [current, setCurrent] = useState(value);
  useEffect(() => setCurrent(value), [value]);
  return (
    <span className="flex flex-1 items-center gap-2.5">
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={current}
        onChange={(e) => {
          const next = Number(e.target.value);
          setCurrent(next);
          onInput?.(next);
        }}
        onPointerUp={() => onCommit?.(current)}
        onKeyUp={() => onCommit?.(current)}
        className="h-1.5 min-w-28 flex-1 cursor-pointer accent-[var(--color-accent)]"
      />
      <span className="w-12 text-right text-[12px] text-fg-muted tabular-nums">{format(current)}</span>
    </span>
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
