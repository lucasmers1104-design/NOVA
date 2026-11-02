import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

const host = process.env.TAURI_DEV_HOST;
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // Tauri expects a fixed port and prints its own Rust errors.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  // The app version (package.json is also Tauri's version source), shown in the sidebar.
  define: { __NOVA_VERSION__: JSON.stringify(version) },
  build: {
    rolldownOptions: {
      // One page per window: the dashboard, the floating NOVA AI dot, and its panel.
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        dot: fileURLToPath(new URL("./dot.html", import.meta.url)),
        assistant: fileURLToPath(new URL("./assistant.html", import.meta.url)),
      },
    },
  },
  test: {
    environment: "jsdom",
    // One jsdom per worker with per-file VM isolation; far faster than a fresh environment per file.
    pool: "vmThreads",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    restoreMocks: true,
  },
});
