import "@fontsource-variable/inter";
import "./styles/index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { applyTheme } from "./design/theme";
import { useDashboard } from "./features/dashboard/store";
import { useSettings } from "./stores/settings";

if (import.meta.env.PROD) {
  // Hide the WebView's browser context menu (Reload, Inspect, ...) outside text fields.
  document.addEventListener("contextmenu", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest("input, textarea, [contenteditable='true'], .select-text")) event.preventDefault();
  });
}

async function bootstrap() {
  const container = document.getElementById("root");
  if (!container) throw new Error("NOVA: #root element is missing from index.html");

  // Persisted state lives in SQLite and loads asynchronously. Waiting a few
  // milliseconds here means the first frame already has the user's accent and
  // layout (the window background matches the canvas, so nothing flashes).
  await Promise.all([useSettings.persist.rehydrate(), useDashboard.getState().load()]);
  applyTheme(useSettings.getState());

  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
