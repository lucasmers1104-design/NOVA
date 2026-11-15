import "@fontsource-variable/inter";
import "./island-window.css";
import "./island.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IslandApp } from "./IslandApp";

/** Entry of the Nova Island window (island.html). No Tailwind, no motion library: CSS does the morphing. */
const container = document.getElementById("root");
if (!container) throw new Error("Nova Island: #root element is missing from island.html");
createRoot(container).render(
  <StrictMode>
    <IslandApp />
  </StrictMode>,
);
