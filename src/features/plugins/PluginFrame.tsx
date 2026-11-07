import { useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useAccentTokens } from "@/design/theme";
import { notify } from "@/features/notifications/store";
import { callNative } from "@/lib/native";
import { useSettings } from "@/stores/settings";
import { PLUGINS_KEY, type PluginInfo } from "./api";

const PING_MS = 15_000;
const SILENCE_MS = 45_000;
const START_MS = 30_000;
const CALLS_PER_10S = 200;

/**
 * Runs a plugin in a sandboxed frame. Without `allow-same-origin` it has no origin of
 * its own, so it can't read NOVA's storage or DOM; it talks to this host by message
 * only, and Rust checks every call against what the user allowed.
 */
export function PluginFrame({ plugin, view, title }: { plugin: PluginInfo; view: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const tokens = useAccentTokens();
  const motion = useSettings((s) => s.motion);
  const client = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const pluginId = plugin.id;
  const pluginName = plugin.name;

  const sendTheme = () => {
    frame.current?.contentWindow?.postMessage({ nova: 1, event: "theme", data: { ...tokens, reducedMotion: motion === "reduced" } }, "*");
  };
  const themeRef = useRef(sendTheme);
  themeRef.current = sendTheme;

  useEffect(() => {
    sendTheme();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens, motion]);

  useEffect(() => {
    if (failure) return;
    let ready = false;
    let heard = Date.now();
    let calls = 0;
    const started = Date.now();
    const post = (message: unknown) => frame.current?.contentWindow?.postMessage(message, "*");

    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const message = event.data as { nova?: unknown; ready?: unknown; pong?: unknown; id?: unknown; method?: unknown; params?: unknown } | null;
      if (message?.nova !== 1) return;
      heard = Date.now();
      if (message.ready) {
        ready = true;
        themeRef.current();
        return;
      }
      if (typeof message.method !== "string" || (typeof message.id !== "number" && typeof message.id !== "string")) return;
      const { id, method } = message;
      if (++calls > CALLS_PER_10S) {
        post({ nova: 1, id, error: "Too many requests" });
        return;
      }
      callNative("plugin_call", { pluginId, method, params: message.params ?? {} }).then(
        (result) => post({ nova: 1, id, result }),
        (error: unknown) => post({ nova: 1, id, error: error instanceof Error ? error.message : String(error) }),
      );
    };
    window.addEventListener("message", onMessage);

    const fail = (reason: string) => {
      setFailure(reason);
      void callNative<boolean>("plugin_report_crash", { id: pluginId }).then((off) => {
        if (off) {
          notify(`${pluginName} was turned off`, { kind: "warning", body: "It stopped responding several times." });
          void client.invalidateQueries({ queryKey: PLUGINS_KEY });
        }
      });
    };
    const resetCalls = window.setInterval(() => (calls = 0), 10_000);
    const watchdog = window.setInterval(() => {
      if (!ready) {
        if (Date.now() - started > START_MS) fail("It didn't start.");
        return;
      }
      if (Date.now() - heard > SILENCE_MS) fail("It stopped responding.");
      else post({ nova: 1, event: "ping" });
    }, PING_MS);

    return () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(resetCalls);
      window.clearInterval(watchdog);
    };
  }, [failure, attempt, pluginId, pluginName, client]);

  if (failure) {
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 p-5 text-center">
        <TriangleAlert size={18} className="text-warning" aria-hidden />
        <p className="text-[13px] font-medium text-fg">{plugin.name}: {failure}</p>
        <Button
          size="sm"
          onClick={() => {
            setFailure(null);
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  return (
    <iframe
      key={attempt}
      ref={frame}
      title={title}
      src={`${plugin.entryUrl}?view=${encodeURIComponent(view)}`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="size-full border-0 bg-transparent"
    />
  );
}

/** A dashboard widget: the frame only exists while it can be seen. */
export function PluginWidget({ plugin, widgetId, name }: { plugin: PluginInfo; widgetId: string; name: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = box.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false), { rootMargin: "120px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={box} className="glass h-full overflow-hidden rounded-widget">
      {visible && <PluginFrame plugin={plugin} view={`widget:${widgetId}`} title={name} />}
    </div>
  );
}
