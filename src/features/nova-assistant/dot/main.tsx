import "./dot.css";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { dotReady, openDotMenu, toggleAssistant } from "../api";
import { useAssistantAppearance } from "../appearance";
import { NovaDot } from "../components/NovaDot";
import { ASSISTANT_EVENTS, type AssistantState, type DotView } from "../types";

/** Entry of the floating dot window (dot.html). Deliberately small: no Tailwind, no motion library. */
function DotApp() {
  useAssistantAppearance();
  const [view, setView] = useState<DotView | null>(null);
  const [activity, setActivity] = useState<{ state: AssistantState; level: number }>({ state: "idle", level: 0 });

  useEffect(() => {
    let alive = true;
    const subscriptions = [
      listen<{ open: boolean }>(ASSISTANT_EVENTS.panel, (event) => setView((v) => v && { ...v, panelOpen: event.payload.open })),
      listen<DotView>(ASSISTANT_EVENTS.dot, (event) => setView(event.payload)),
      listen<{ state: AssistantState; level: number }>(ASSISTANT_EVENTS.activity, (event) => setActivity(event.payload)),
    ];
    // Shows the window: it stays hidden until there is something to draw.
    dotReady().then(
      (initial) => alive && setView(initial),
      (error: unknown) => console.error("NOVA dot:", error),
    );
    return () => {
      alive = false;
      for (const subscription of subscriptions) void subscription.then((stop) => stop());
    };
  }, []);

  if (!view) return null;
  return (
    <NovaDot
      look={view.look}
      open={view.panelOpen}
      state={activity.state}
      level={activity.level}
      onToggle={() => void toggleAssistant()}
      onMenu={() => void openDotMenu()}
      onDragStart={() => void getCurrentWindow().startDragging()}
    />
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("NOVA dot: #root element is missing from dot.html");
createRoot(container).render(
  <StrictMode>
    <DotApp />
  </StrictMode>,
);
