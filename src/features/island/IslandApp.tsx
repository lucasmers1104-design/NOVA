import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LyricLine } from "@/features/media/api";
import { openDotMenu, toggleAssistant } from "@/features/nova-assistant/api";
import { useAssistantAppearance } from "@/features/nova-assistant/appearance";
import { ASSISTANT_EVENTS } from "@/features/nova-assistant/types";
import { callNative } from "@/lib/native";
import { islandCallAction, islandListen, islandReady, islandResize } from "./api";
import { type IslandActions, type IslandData, layoutOf } from "./data";
import { useDemoLevel, useLevel, useMedia, useNow, useSystemLoad } from "./hooks";
import { IslandView } from "./IslandView";
import { aiBusy, currentNotice } from "./priority";
import { SCENE_MODULE, sceneById } from "./scenes";
import { type AiActivity, type AiNote, ISLAND_EVENTS, type IslandPrefs, type PhoneCall, type PhoneEvent, type PhoneNotice, type SceneId } from "./types";

/** How long NOVA AI's last reply stays on the island. */
const REPLY_MS = 12_000;
/** At most this many phone notifications wait their turn; older ones drop. */
const MOST_QUEUED = 6;
/** A scene from Island Studio ends by itself, also if the Studio never says so. */
const PREVIEW_MS = 10_000;

interface Queued {
  notice: PhoneNotice;
  shownAt: number | null;
}

/**
 * Nova Island's window: the wiring around IslandView. Rust sizes and places the
 * window; this page gathers what happens (Rust's events, the panel's notes, the
 * media session), decides when the island opens and closes, and tells Rust how big
 * the pill is, so it knows where the pointer counts as "on the island".
 */
export function IslandApp() {
  useAssistantAppearance();
  const [prefs, setPrefs] = useState<IslandPrefs | null>(null);
  const [calls, setCalls] = useState<PhoneCall[]>([]);
  const [callSince, setCallSince] = useState<Record<string, number>>({});
  const [callError, setCallError] = useState<string | null>(null);
  const [queue, setQueue] = useState<Queued[]>([]);
  const [activity, setActivity] = useState<AiActivity>({ state: "idle", level: 0 });
  const [note, setNote] = useState<AiNote & { at: number }>({ reply: "", task: null, at: 0 });
  const [expanded, setExpanded] = useState(false);
  const [lyrics, setLyrics] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [preview, setPreview] = useState<{ scene: SceneId; startedAt: number } | null>(null);
  const pill = useRef<HTMLDivElement>(null);

  // Preferences, calls already ringing, and everything Rust and the panel send.
  useEffect(() => {
    let alive = true;
    const subscriptions = [
      listen<IslandPrefs>(ISLAND_EVENTS.prefs, ({ payload }) => setPrefs(payload)),
      listen<PhoneEvent>(ISLAND_EVENTS.phone, ({ payload }) => {
        if (payload.kind === "notification") {
          const notice: PhoneNotice = payload;
          // An update of the same notification replaces it where it waits.
          setQueue((now) => [...now.filter((q) => q.notice.notifId !== notice.notifId), { notice, shownAt: null }].slice(-MOST_QUEUED));
        } else {
          const call: PhoneCall = payload;
          setCalls((now) => (call.state === "ended" ? now.filter((c) => c.callId !== call.callId) : [...now.filter((c) => c.callId !== call.callId), call]));
          if (call.state === "active") setCallSince((since) => ({ ...since, [call.callId]: since[call.callId] ?? Date.now() }));
          setCallError(null);
        }
      }),
      listen<AiActivity>(ASSISTANT_EVENTS.activity, ({ payload }) => setActivity(payload)),
      // Rust watches the pointer: the window gets no mouse events while it is elsewhere.
      listen<boolean>(ISLAND_EVENTS.hover, ({ payload }) => setHovered(payload)),
      listen<AiNote>(ISLAND_EVENTS.ai, ({ payload }) => setNote((was) => ({ ...payload, at: payload.reply && payload.reply !== was.reply ? Date.now() : was.at }))),
      listen<SceneId | null>(ISLAND_EVENTS.preview, ({ payload }) => setPreview(payload ? { scene: payload, startedAt: Date.now() } : null)),
    ];
    islandReady().then(
      (boot) => {
        if (!alive) return;
        setPrefs(boot.prefs);
        setCalls(boot.calls);
      },
      (error: unknown) => console.error("Nova Island:", error),
    );
    return () => {
      alive = false;
      for (const subscription of subscriptions) void subscription.then((stop) => stop());
    };
  }, []);

  const modules = prefs?.modules ?? { music: false, notifications: false, calls: false, system: false, ai: false };
  const media = useMedia(modules.music);
  const load = useSystemLoad(modules.system);
  const ticking = queue.length > 0 || (note.reply !== "" && Date.now() - note.at < REPLY_MS);
  const now = useNow(ticking);

  const notice = prefs ? currentNotice(queue, now, prefs.notificationSeconds) : null;
  // The first moment a notification is on screen starts its time.
  useEffect(() => {
    if (notice && notice.shownAt === null) setQueue((q) => q.map((item) => (item === notice ? { ...item, shownAt: Date.now() } : item)));
  }, [notice]);
  // Shown ones go.
  useEffect(() => {
    if (!prefs || queue.length === 0) return;
    const done = (q: Queued) => q.shownAt !== null && now - q.shownAt >= prefs.notificationSeconds * 1000;
    if (queue.some(done) && !(expanded && notice && done(notice))) setQueue((q) => q.filter((item) => !done(item)));
  }, [now, queue, prefs, expanded, notice]);

  const call = calls.find((c) => c.state === "ringing") ?? calls.find((c) => c.state === "active") ?? null;
  const real: IslandData = useMemo(
    () => ({
      media,
      load,
      call,
      callSince: call ? (callSince[call.callId] ?? null) : null,
      callError,
      notice: notice?.notice ?? null,
      noticeShownAt: notice?.shownAt ?? null,
      ai: activity,
      aiNote: note,
      aiReplyShown: note.reply !== "" && now - note.at < REPLY_MS && !aiBusy(activity.state),
    }),
    [media, load, call, callSince, callError, notice, activity, note, now],
  );

  // A scene from Island Studio replaces what really happens for a moment. A ringing
  // call ends it at once: the Studio must never cover a call.
  const ringingForReal = call?.state === "ringing" && modules.calls;
  const scene = preview && !ringingForReal ? sceneById(preview.scene) : null;
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(() => setPreview(null), PREVIEW_MS);
    return () => clearTimeout(timer);
  }, [preview]);
  const data = useMemo(() => (scene && preview ? scene.data(preview.startedAt) : real), [scene, preview, real]);
  // The scene's module shows even while it is switched off, so every scene can be seen.
  const shownPrefs = useMemo(() => {
    const needed = scene ? SCENE_MODULE[scene.id] : null;
    return prefs && needed && !prefs.modules[needed] ? { ...prefs, modules: { ...prefs.modules, [needed]: true } } : prefs;
  }, [prefs, scene]);

  const layout = shownPrefs ? layoutOf(shownPrefs, data) : null;
  const primary = layout?.arrangement.primary ?? null;
  const ringing = layout?.ringing ?? false;

  // Nothing left to open: close.
  useEffect(() => {
    if (!primary) setExpanded(false);
  }, [primary]);
  useEffect(() => {
    if (!expanded || primary !== "music") setLyrics(false);
  }, [expanded, primary]);

  // Auto-minimize: an opened island closes after a while without the pointer on it.
  useEffect(() => {
    if (!prefs?.autoMinimize || !expanded || hovered || ringing || scene) return;
    const timer = setTimeout(() => setExpanded(false), prefs.minimizeAfter * 1000);
    return () => clearTimeout(timer);
  }, [prefs?.autoMinimize, prefs?.minimizeAfter, expanded, hovered, ringing, scene]);

  // The real level drives the bars while music is on screen and really playing.
  useLevel(Boolean(layout?.musicOnScreen) && !scene && media.state?.status === "playing", pill);
  useDemoLevel(Boolean(layout?.musicOnScreen) && scene !== null, pill);

  // Rust only needs the size to know where the pointer counts as "on the island".
  const onSize = useCallback(({ width, height }: { width: number; height: number }) => void islandResize(width, height).catch(() => {}), []);

  const actions: IslandActions = useMemo(
    () => ({
      mediaControl: (action) => void callNative<void>("media_control", { action }).catch(() => {}),
      lyrics: (state) => callNative<LyricLine[]>("media_lyrics", { title: state.title, artist: state.artist, durationMs: state.durationMs }),
      callAction: (callId, action) => {
        islandCallAction(callId, action).then(
          () => setCallError(null),
          (error: unknown) => setCallError(error instanceof Error ? error.message : String(error)),
        );
      },
      talk: () => void islandListen().catch(() => {}),
      openAssistant: () => void toggleAssistant().catch(() => {}),
      menu: () => void openDotMenu().catch(() => {}),
    }),
    [],
  );
  // A scene is only a picture: its buttons must not pause the real music or answer nobody.
  const sceneActions: IslandActions = useMemo(
    () => ({ ...actions, mediaControl: () => {}, callAction: () => {}, lyrics: async () => [] }),
    [actions],
  );

  if (!shownPrefs) return null;
  return (
    <IslandView
      prefs={shownPrefs}
      data={data}
      actions={scene ? sceneActions : actions}
      expanded={scene ? scene.expanded : expanded}
      lyrics={scene ? scene.lyrics : lyrics}
      hovered={hovered}
      onExpanded={scene ? () => {} : setExpanded}
      onLyrics={scene ? () => {} : setLyrics}
      onHovered={setHovered}
      pillRef={pill}
      onSize={onSize}
    />
  );
}
