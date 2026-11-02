import "@fontsource-variable/inter";
import "@/styles/index.css";
import "../orb.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PanelApp } from "./PanelApp";

// Entry of the NOVA AI panel window (assistant.html).
document.documentElement.dataset.surface = "overlay";

if (import.meta.env.PROD) {
  document.addEventListener("contextmenu", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest("input, textarea, [contenteditable='true'], .select-text")) event.preventDefault();
  });
}

const container = document.getElementById("root");
if (!container) throw new Error("NOVA panel: #root element is missing from assistant.html");
createRoot(container).render(
  <StrictMode>
    <PanelApp />
  </StrictMode>,
);
