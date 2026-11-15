// What Nova Island shows, one component per module, each in a compact and an
// opened form. Text from the phone only ever goes in as text, never as markup.
// Nothing here talks to Rust: what a control does comes in through IslandActions.

import { ArrowDown, ArrowUp, Bell, Cpu, Gauge, MemoryStick, Mic, Pause, Phone, PhoneOff, Play, ScrollText, SkipBack, SkipForward, Sparkles, Thermometer } from "lucide-react";
import { createContext, type CSSProperties, type MouseEvent, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { centeredScrollTop, currentLine, type LyricLine, type MediaState, sourceAppName } from "@/features/media/api";
import { Sparkle } from "@/features/nova-assistant/components/Sparkle";
import type { AssistantState } from "@/features/nova-assistant/types";
import { iconSrc, knownApp } from "./app-icons";
import type { IslandActions, IslandData } from "./data";
import type { Media, SystemLoad } from "./hooks";
import { useNow } from "./hooks";
import { aiBusy, clock, type ContentKind, effectiveSlot, rate, readableNumber } from "./priority";
import type { IslandPrefs, PhoneCall, PhoneNotice, SlotItem } from "./types";

const ActionsContext = createContext<IslandActions | null>(null);
export const IslandActionsProvider = ActionsContext.Provider;

function useActions(): IslandActions {
  const actions = useContext(ActionsContext);
  if (!actions) throw new Error("Nova Island: its modules need an IslandActionsProvider");
  return actions;
}

/** Keeps a click on a control from opening or closing the island. */
function stop(handler: () => void) {
  return (event: MouseEvent) => {
    event.stopPropagation();
    handler();
  };
}

function Control({ label, onPress, children, tone }: { label: string; onPress: () => void; children: ReactNode; tone?: "accept" | "decline" | "accent" }) {
  return (
    <button type="button" className="island-control" data-tone={tone} aria-label={label} title={label} onClick={stop(onPress)}>
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** Four bars that follow the output's real level (`--level`, set by useLevel). */
export function Bars({ playing, large = false }: { playing: boolean; large?: boolean }) {
  return (
    <span className="island-bars" data-playing={playing} data-large={large || undefined} aria-hidden>
      {[0.62, 1, 0.78, 0.5].map((weight, i) => (
        <i key={i} style={{ "--w": weight } as CSSProperties} />
      ))}
    </span>
  );
}

function Artwork({ url, size }: { url: string | null; size: number }) {
  return url ? (
    <img className="island-art" src={url} alt="" style={{ width: size, height: size }} draggable={false} />
  ) : (
    <span className="island-art island-art--empty" style={{ width: size, height: size }} aria-hidden>
      <Sparkle />
    </span>
  );
}

/** A rounded badge with a letter or a small icon, where an app has no picture. */
function Badge({ size, children }: { size: number; children: ReactNode }) {
  return (
    <span className="island-app island-app--letter" style={{ width: size, height: size, fontSize: size * 0.5 }} aria-hidden>
      {children}
    </span>
  );
}

/**
 * An app's logo: the real one where Rust or the phone sent it (only a PNG/WebP data URL
 * gets into the <img>), else a colored glyph for well-known apps, else its first letter.
 */
export function AppLogo({ icon, id, name, size }: { icon: string | null | undefined; id: string; name: string; size: number }) {
  const src = iconSrc(icon);
  const [broken, setBroken] = useState<string | null>(null);
  if (src && broken !== src) {
    return <img className="island-app" src={src} alt="" style={{ width: size, height: size }} draggable={false} onError={() => setBroken(src)} />;
  }
  const known = knownApp(id, name);
  if (known) {
    const Glyph = known.glyph;
    return (
      <span className="island-app island-app--known" data-app={known.name} style={{ width: size, height: size, background: known.color, color: known.ink }} aria-hidden>
        <Glyph size={Math.round(size * 0.58)} strokeWidth={2.2} />
      </span>
    );
  }
  return <Badge size={size}>{name.trim().charAt(0).toUpperCase() || <Bell size={size * 0.55} />}</Badge>;
}

function AppIcon({ notice, size }: { notice: PhoneNotice; size: number }) {
  return <AppLogo icon={notice.icon} id={notice.app} name={notice.appName} size={size} />;
}

function Caller({ call, size }: { call: PhoneCall; size: number }) {
  const initials = (call.name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
  // The phone sends PNG or JPEG; the browser tells them apart by their bytes.
  return call.photo ? (
    <img className="island-caller" src={`data:image/png;base64,${call.photo}`} alt="" style={{ width: size, height: size }} draggable={false} />
  ) : (
    <span className="island-caller island-caller--initials" style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden>
      {initials || <Phone size={size * 0.45} />}
    </span>
  );
}

function LiveBadge({ size = 22 }: { size?: number }) {
  return (
    <span className="island-live" style={{ width: size, height: size }} aria-hidden>
      <Phone size={size * 0.58} />
    </span>
  );
}

/** NOVA's orb: still while idle, it only moves while NOVA works. */
export function Orb({ state, level = 0, size = 22 }: { state: AssistantState; level?: number; size?: number }) {
  return <span className="island-orb" data-state={state} style={{ "--orb": `${size}px`, "--voice": level } as CSSProperties} aria-hidden />;
}

function position(state: MediaState, now: number): number | null {
  if (state.positionMs === null) return null;
  const moved = state.status === "playing" ? now - state.sampledAtMs : 0;
  return Math.min(state.durationMs ?? Number.POSITIVE_INFINITY, state.positionMs + Math.max(0, moved));
}

// ---------------------------------------------------------------------------
// The closed pill's side slots (Island Studio → slots)
// ---------------------------------------------------------------------------

interface SlotProps {
  kind: ContentKind;
  data: IslandData;
  prefs: IslandPrefs;
}

/** How far along the leading content is (0–1); `null` where that can't be said. */
function progressOf({ kind, data, prefs }: SlotProps, now: number): number | null {
  if (kind === "music") {
    const state = data.media.state;
    const at = state ? position(state, now) : null;
    return state?.durationMs && at !== null ? Math.min(1, at / state.durationMs) : null;
  }
  if (kind === "notification") return data.noticeShownAt === null ? 1 : Math.max(0, 1 - (now - data.noticeShownAt) / (prefs.notificationSeconds * 1000));
  if (kind === "system") return data.load.snapshot ? Math.min(1, data.load.snapshot.cpuUsage / 100) : null;
  return null;
}

/** Ticks only while this slot is on screen and something actually moves. */
function useSlotClock({ kind, data }: SlotProps): number {
  const moving = kind === "music" ? data.media.state?.status === "playing" : kind === "call" || kind === "notification";
  return useNow(moving);
}

function SlotRemaining(props: SlotProps) {
  const now = useSlotClock(props);
  const { kind, data, prefs } = props;
  if (kind === "call") return <span className="island-live-text">{clock(now - (data.callSince ?? now))}</span>;
  if (kind === "notification") {
    const left = data.noticeShownAt === null ? prefs.notificationSeconds : Math.max(0, Math.ceil(prefs.notificationSeconds - (now - data.noticeShownAt) / 1000));
    return <span className="island-slot-text">{left} s</span>;
  }
  const state = data.media.state;
  const at = state ? position(state, now) : null;
  if (!state?.durationMs || at === null) return null;
  return <span className="island-slot-text">-{clock(state.durationMs - at)}</span>;
}

function SlotProgress(props: SlotProps) {
  const now = useSlotClock(props);
  const { kind, data } = props;
  const busy = kind === "ai" && aiBusy(data.ai.state);
  const value = kind === "ai" ? (busy ? 0.28 : 1) : progressOf(props, now);
  if (value === null) return null;
  const radius = 8;
  const round = 2 * Math.PI * radius;
  return (
    <svg className="island-ring" data-spinning={busy || undefined} viewBox="0 0 20 20" width={20} height={20} aria-hidden>
      <circle cx="10" cy="10" r={radius} fill="none" strokeWidth="2.5" className="island-ring-track" />
      <circle cx="10" cy="10" r={radius} fill="none" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={round} strokeDashoffset={round * (1 - value)} className="island-ring-value" />
    </svg>
  );
}

function SlotClock() {
  const now = useNow(true, 15_000);
  return <span className="island-slot-text">{new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>;
}

function slotContent(item: SlotItem, props: SlotProps): ReactNode {
  const { kind, data } = props;
  switch (item) {
    case "cover":
      if (kind === "call" && data.call) return <Caller call={data.call} size={24} />;
      if (kind === "notification" && data.notice) return <AppIcon notice={data.notice} size={24} />;
      return <Artwork url={kind === "music" ? data.media.artwork : null} size={24} />;
    case "visualizer":
      return <Bars playing={data.media.state?.status === "playing"} />;
    case "appIcon":
      if (kind === "call") return <LiveBadge />;
      if (kind === "notification" && data.notice) return <AppIcon notice={data.notice} size={24} />;
      if (kind === "music") {
        const source = data.media.state?.sourceAppId ?? "";
        return <AppLogo icon={data.media.appIcon} id={source} name={sourceAppName(source)} size={24} />;
      }
      return <Badge size={24}>{kind === "system" ? <Cpu size={13} /> : <Sparkles size={13} />}</Badge>;
    case "clock":
      return <SlotClock />;
    case "remaining":
      return <SlotRemaining {...props} />;
    case "progress":
      return <SlotProgress {...props} />;
    case "aiStatus":
      return <Orb state={data.ai.state} level={data.ai.level} />;
    case "none":
      return null;
  }
}

function Slot({ side, dot, ...props }: SlotProps & { side: "left" | "right"; dot: boolean }) {
  const item = effectiveSlot(props.prefs.slots[props.kind][side], props.kind, dot);
  if (item === "none") return null;
  return (
    <span className="island-slot" data-slot={side} data-item={item}>
      {slotContent(item, props)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The closed pill
// ---------------------------------------------------------------------------

function percent(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "–" : `${Math.round(value)} %`;
}

function gpuUsage(load: SystemLoad): number | null {
  const usages = (load.snapshot?.gpus ?? []).map((g) => g.usage).filter((u): u is number => u !== null);
  return usages.length ? Math.max(...usages) : null;
}

const AI_TEXT: Partial<Record<AssistantState, string>> = {
  activating: "NOVA wacht auf …",
  listening: "Hört zu …",
  processing: "Versteht …",
  thinking: "Denkt nach …",
  searching: "Sucht …",
  analyzingScreen: "Schaut auf deinen Bildschirm …",
  executing: "Arbeitet daran …",
  speaking: "Spricht …",
  completed: "Fertig",
  error: "Etwas ist schiefgelaufen",
};

/** The one line the closed pill says for what leads. */
function CompactLine({ kind, data }: { kind: ContentKind; data: IslandData }) {
  switch (kind) {
    case "music": {
      const state = data.media.state;
      return (
        <span className="island-line">
          <b>{state?.title}</b>
          {state?.artist && <span className="island-muted"> · {state.artist}</span>}
        </span>
      );
    }
    case "notification": {
      const notice = data.notice;
      const hidden = !notice?.title && !notice?.text;
      return (
        <span className="island-line">
          <b>{notice?.title || notice?.appName}</b>
          <span className="island-muted"> {hidden ? "· Neue Benachrichtigung" : `· ${notice?.text}`}</span>
        </span>
      );
    }
    case "call":
      return (
        <span className="island-line">
          <b>{data.call?.name || readableNumber(data.call?.number ?? null) || "Anruf"}</b>
        </span>
      );
    case "ai": {
      const quiet = !aiBusy(data.ai.state);
      return (
        <span className="island-line">
          {quiet && data.aiReplyShown && data.aiNote.reply ? (
            <span>{data.aiNote.reply}</span>
          ) : (
            <>
              <b>{AI_TEXT[data.ai.state] ?? "NOVA AI"}</b>
              {data.aiNote.task && <span className="island-muted"> · {data.aiNote.task}</span>}
            </>
          )}
        </span>
      );
    }
    case "system": {
      const snap = data.load.snapshot;
      const ram = snap && snap.memoryTotal ? (snap.memoryUsed / snap.memoryTotal) * 100 : null;
      const gpu = gpuUsage(data.load);
      return (
        <span className="island-line island-system">
          <span>
            <Cpu size={13} /> {percent(snap?.cpuUsage)}
          </span>
          <span>
            <MemoryStick size={13} /> {percent(ram)}
          </span>
          {gpu !== null && (
            <span>
              <Gauge size={13} /> {percent(gpu)}
            </span>
          )}
        </span>
      );
    }
  }
}

/** The closed pill: what leads in one line, between the two side slots the user chose. */
export function Compact({ dot, ...props }: SlotProps & { dot: boolean }) {
  return (
    <div className="island-row" data-kind={props.kind} data-drop={props.kind === "notification" || undefined}>
      <Slot side="left" dot={dot} {...props} />
      <CompactLine kind={props.kind} data={props.data} />
      <Slot side="right" dot={dot} {...props} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Music, opened
// ---------------------------------------------------------------------------

export function MusicOpen({ media, lyrics, onLyrics }: { media: Media; lyrics: boolean; onLyrics: () => void }) {
  const actions = useActions();
  const state = media.state;
  const now = useNow(Boolean(state && state.status === "playing"), 500);
  if (!state) return null;
  const at = position(state, now);
  const progress = at !== null && state.durationMs ? Math.min(1, at / state.durationMs) : null;
  const playing = state.status === "playing";
  return (
    <div className="island-open">
      <div className="island-row island-row--top">
        <Artwork url={media.artwork} size={64} />
        <div className="island-stack">
          <b className="island-title">{state.title}</b>
          <span className="island-muted island-ellipsis">{state.artist || state.album || "Unbekannter Interpret"}</span>
          <span className="island-subtle island-ellipsis">{sourceAppName(state.sourceAppId)}</span>
        </div>
        <Bars playing={playing} large />
      </div>
      {progress !== null && (
        <div className="island-progress" aria-label="Position">
          <span className="island-subtle">{clock(at ?? 0)}</span>
          <span className="island-track">
            <i style={{ width: `${progress * 100}%` }} />
          </span>
          <span className="island-subtle">{clock(state.durationMs ?? 0)}</span>
        </div>
      )}
      <div className="island-controls">
        <Control label="Songtext" onPress={onLyrics} tone={lyrics ? "accent" : undefined}>
          <ScrollText size={16} />
        </Control>
        <Control label="Zurück" onPress={() => actions.mediaControl("previous")}>
          <SkipBack size={18} fill="currentColor" />
        </Control>
        <Control label={playing ? "Pause" : "Wiedergabe"} onPress={() => actions.mediaControl("toggle")} tone="accent">
          {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
        </Control>
        <Control label="Weiter" onPress={() => actions.mediaControl("next")}>
          <SkipForward size={18} fill="currentColor" />
        </Control>
        <span className="island-control-spacer" />
      </div>
      {lyrics && <Lyrics state={state} at={at} />}
    </div>
  );
}

/** Asked only when opened: in the window the song's name goes to the public LRCLIB database (as on the Media page). */
function Lyrics({ state, at }: { state: MediaState; at: number | null }) {
  const actions = useActions();
  const [lines, setLines] = useState<LyricLine[] | null | "error">(null);
  const list = useRef<HTMLDivElement>(null);
  // The latest state without asking again each time its position ticks.
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => {
    let alive = true;
    setLines(null);
    actions.lyrics(latest.current).then(
      (found) => alive && setLines(found),
      () => alive && setLines("error"),
    );
    return () => {
      alive = false;
    };
  }, [actions, state.title, state.artist, state.durationMs]);
  const current = Array.isArray(lines) && at !== null ? currentLine(lines, at) : -1;
  // Scrolls only the list. scrollIntoView would also scroll the island itself (overflow
  // hidden still scrolls), pushing cover and controls out of sight for good.
  useEffect(() => {
    const box = list.current;
    const line = box?.querySelector<HTMLElement>("[data-current=true]");
    if (!box || !line) return;
    box.scrollTo({ top: centeredScrollTop(box, line), behavior: "smooth" });
  }, [current]);
  if (lines === null) return <p className="island-lyrics island-subtle">Suche Songtext …</p>;
  if (lines === "error" || lines.length === 0) return <p className="island-lyrics island-subtle">Kein Songtext für dieses Lied gefunden.</p>;
  return (
    <div className="island-lyrics" ref={list} onClick={(event) => event.stopPropagation()}>
      {lines.map((line, i) => (
        <p key={i} data-current={i === current} data-past={i < current}>
          {line.text || "♪"}
        </p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phone notifications, opened
// ---------------------------------------------------------------------------

export function NoticeOpen({ notice }: { notice: PhoneNotice }) {
  const now = useNow(true, 30_000);
  const hidden = !notice.title && !notice.text;
  const minutes = Math.round((now - notice.posted) / 60_000);
  return (
    <div className="island-open">
      <div className="island-row island-row--top">
        <AppIcon notice={notice} size={36} />
        <div className="island-stack">
          <span className="island-subtle">
            {notice.appName} · {minutes < 1 ? "gerade eben" : `vor ${minutes} Min.`}
          </span>
          {hidden ? (
            <span className="island-muted">Vorschau ausgeblendet. Einschalten im Tab NOVA Island.</span>
          ) : (
            <>
              {notice.title && <b className="island-title">{notice.title}</b>}
              <span className="island-body">{notice.text}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** A ringing call: big, with the actions the phone really offers. */
export function CallRinging({ call, error }: { call: PhoneCall; error: string | null }) {
  const actions = useActions();
  const number = readableNumber(call.number);
  return (
    <div className="island-call" data-drop>
      <Caller call={call} size={48} />
      <div className="island-stack">
        <span className="island-subtle island-ellipsis">{error ?? "Anruf auf deinem Handy"}</span>
        <b className="island-title">{call.name || number || "Unbekannter Anrufer"}</b>
        {call.name && number && <span className="island-muted">{number}</span>}
      </div>
      <div className="island-call-actions">
        {call.canDecline && (
          <Control label="Ablehnen" tone="decline" onPress={() => actions.callAction(call.callId, "decline")}>
            <PhoneOff size={18} />
          </Control>
        )}
        {call.canAnswer && (
          <Control label="Annehmen" tone="accept" onPress={() => actions.callAction(call.callId, "accept")}>
            <Phone size={18} />
          </Control>
        )}
        {!call.canAnswer && !call.canDecline && <span className="island-subtle island-hint">Am Handy annehmen</span>}
      </div>
    </div>
  );
}

export function CallOpen({ call, since }: { call: PhoneCall; since: number | null }) {
  const actions = useActions();
  const now = useNow(true);
  return (
    <div className="island-call">
      <Caller call={call} size={44} />
      <div className="island-stack">
        <span className="island-subtle">Im Gespräch · {clock(now - (since ?? now))}</span>
        <b className="island-title">{call.name || readableNumber(call.number) || "Unbekannter Anrufer"}</b>
      </div>
      <div className="island-call-actions">
        {call.canDecline && (
          <Control label="Auflegen" tone="decline" onPress={() => actions.callAction(call.callId, "decline")}>
            <PhoneOff size={18} />
          </Control>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// System, opened
// ---------------------------------------------------------------------------

function Meter({ icon, label, value, detail }: { icon: ReactNode; label: string; value: number | null; detail: string }) {
  return (
    <div className="island-meter">
      <span className="island-meter-label">
        {icon} {label}
      </span>
      <span className="island-track">
        <i style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%` }} data-high={(value ?? 0) >= 85 || undefined} />
      </span>
      <span className="island-meter-value">{detail}</span>
    </div>
  );
}

export function SystemOpen({ load }: { load: SystemLoad }) {
  const snap = load.snapshot;
  if (!snap) return <p className="island-open island-subtle">Lese die Auslastung …</p>;
  const ram = snap.memoryTotal ? (snap.memoryUsed / snap.memoryTotal) * 100 : null;
  const gpu = gpuUsage(load);
  return (
    <div className="island-open island-meters">
      <Meter icon={<Cpu size={13} />} label="CPU" value={snap.cpuUsage} detail={percent(snap.cpuUsage)} />
      <Meter icon={<MemoryStick size={13} />} label="RAM" value={ram} detail={`${(snap.memoryUsed / 1024 ** 3).toFixed(1)} GB`} />
      {gpu !== null && <Meter icon={<Gauge size={13} />} label="GPU" value={gpu} detail={percent(gpu)} />}
      <div className="island-meter-foot">
        {load.hottest && (
          <span>
            <Thermometer size={13} /> {Math.round(load.hottest.celsius)} °C
          </span>
        )}
        {snap.network && (
          <>
            <span>
              <ArrowDown size={13} /> {rate(snap.network.rxPerSec)}
            </span>
            <span>
              <ArrowUp size={13} /> {rate(snap.network.txPerSec)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NOVA AI, opened
// ---------------------------------------------------------------------------

export function AiOpen({ state, level, task, reply }: { state: AssistantState; level: number; task: string | null; reply: string }) {
  const actions = useActions();
  return (
    <div className="island-open">
      <div className="island-row island-row--top">
        <Orb state={state} level={level} size={34} />
        <div className="island-stack">
          <b className="island-title">{AI_TEXT[state] ?? "NOVA AI"}</b>
          {task && <span className="island-muted island-ellipsis">{task}</span>}
          {reply && <span className="island-body island-clamp">{reply}</span>}
        </div>
      </div>
      <div className="island-controls island-controls--start">
        <button type="button" className="island-pill-button" data-tone="accent" onClick={stop(actions.talk)}>
          <Mic size={14} /> Sprechen
        </button>
        <button type="button" className="island-pill-button" onClick={stop(actions.openAssistant)}>
          <Sparkles size={14} /> NOVA AI öffnen
        </button>
      </div>
    </div>
  );
}

/** The smallest hint of each module, beside the leading one. */
export function Indicator({ kind, data }: { kind: ContentKind; data: IslandData }) {
  switch (kind) {
    case "music":
      return data.media.artwork ? <Artwork url={data.media.artwork} size={20} /> : <Bars playing={data.media.state?.status === "playing"} />;
    case "notification":
      return data.notice ? <AppIcon notice={data.notice} size={20} /> : null;
    case "ai":
      return <Orb state={data.ai.state} size={18} />;
    case "system":
      return <span className="island-indicator-text">{percent(data.load.snapshot?.cpuUsage)}</span>;
    case "call":
      return <LiveBadge size={20} />;
  }
}
