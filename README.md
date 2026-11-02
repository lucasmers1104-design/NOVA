# NOVA — Your Personal Command Center

_Everything. Connected._

NOVA is a local-first Windows desktop command center with a macOS-inspired "liquid glass" interface. It combines a customizable widget dashboard, real-time system monitoring, an app launcher, media controls, tasks and notes, a multi-provider AI assistant, a file hub and live information in one app.

**Status:** Version 1.0.0. All eight roadmap milestones are complete; see [docs/ROADMAP.md](docs/ROADMAP.md) and [CHANGELOG.md](CHANGELOG.md).

## Features

| Area | What it does |
| --- | --- |
| **Home** | Drag-and-drop dashboard with resizable widgets, multiple layouts, per-widget settings, and keyboard editing. |
| **System** | Live CPU (per core), memory, GPU utilization and VRAM (when the driver reports them), network throughput, storage, temperatures (only if exposed) and processes. |
| **Apps** | Start menu discovery with real icons, search, favorites, recents, custom apps added through the native picker, and one-click launch. |
| **NOVA AI** | Anthropic, OpenAI and Google Gemini behind one interface. Streaming replies, Markdown and code blocks, conversation history. Keys are stored in Windows Credential Manager. |
| **Productivity** | Tasks with priorities, due dates, reminders and projects; Markdown notes; calendar; daily overview. |
| **Media** | Whatever Windows reports as playing (Spotify, browsers, Media Player…): artwork, position, the controls that player supports, system volume, and history. |
| **Files** | Standard folders, favorite folders, recent files, a scoped browser and search. Files open with their Windows associations. Read-only. |
| **Live Information** | Weather (Open-Meteo, no account needed), RSS/Atom news from feeds you add, world clocks, progress and agenda cards. |
| **Widget Studio** | Browse 15 widgets, preview them live with settings, and add them to any layout. |
| **Profiles** | Gaming, Productivity, Creative, Minimal and custom profiles switch layout, accent and appearance together. |
| **Everywhere** | Command palette (Ctrl+K) over pages, apps, tasks, widgets and profiles; notification center; adaptive accent (presets, custom, or matching your wallpaper); tray icon; opt-in start with Windows and close to tray. |

## Run it

### Prerequisites (Windows 10/11)

| Tool | Version used | Install |
| --- | --- | --- |
| Node.js | 24.x | <https://nodejs.org> |
| Rust (MSVC toolchain) | 1.99 stable | `winget install Rustlang.Rustup` |
| VS 2022 Build Tools, "Desktop development with C++" | 17.x + Windows SDK | `winget install Microsoft.VisualStudio.2022.BuildTools` (then add the C++ workload) |
| WebView2 Runtime | preinstalled on Windows 10/11 | — |

### Commands

```bash
npm install
npm run desktop
```

| Command | What it does |
| --- | --- |
| `npm run desktop` | Desktop app in development mode with hot reload. |
| `npm run desktop:build` | Release build plus the NSIS installer in `src-tauri/target/release/bundle/nsis/`. See [docs/RELEASE.md](docs/RELEASE.md). |
| `npm run dev` | Browser-only preview at <http://localhost:1420>. Native features show a clear "desktop runtime required" state. |
| `npm test` | Frontend unit and UI tests (Vitest + Testing Library). |
| `npm run typecheck` | Strict TypeScript checks. |
| `npm run check:rust` | `cargo check` plus Rust tests (SQLite migrations, parsers, and native integrations on the real machine). |
| `npm run check` | All of the above. |

## Project structure

```
src/                         React + TypeScript frontend
├─ app/                      Shell, routes, navigation, shortcuts, query client, error boundary
├─ components/ui|layout|brand Primitives (Button, Dialog, Menu, Markdown, Meter…), sidebar, title bar, backdrop
├─ design/                   Color math, accent engine, wallpaper palette and backdrop, theme sync
├─ features/                 One folder per product area:
│  ├─ home, dashboard        Grid, edit mode, layouts store and repository
│  ├─ system, apps, media    Native data hooks and pages
│  ├─ productivity, ai       Stores, models and pages
│  ├─ files, live, studio    Pages and helpers
│  ├─ profiles, settings     Workspace profiles; settings sections
│  └─ notifications, desktop Notification center, toasts; tray/startup sync
├─ widgets/                  Registry (15 widgets), config schemas, frame, boundary
├─ stores/                   Persisted settings, session UI state
└─ lib/                      Native bridge, persistence adapter, formatting, time, calendar
src-tauri/                   Rust / Tauri 2 host
├─ src/system.rs             CPU, memory, GPU, network, processes, temperatures (sysinfo)
├─ src/storage/              SQLite: migrations, settings, layouts, productivity, AI history, shortcuts
├─ src/apps.rs, shell.rs     Start menu scan, icons (IShellItemImageFactory), ShellExecute
├─ src/media.rs              Windows media session (WinRT) and Core Audio volume
├─ src/ai.rs, credentials.rs Provider streaming (SSE) and Windows Credential Manager
├─ src/live.rs, http.rs      Open-Meteo weather, RSS/Atom parsing, the single HTTP client
├─ src/files.rs              Scoped folder listing, search, recent items
├─ src/desktop.rs            Tray, close to tray, start with Windows
└─ capabilities/, build.rs   One explicit permission per command (53 commands)
docs/                        Roadmap, release guide, plugin & agent API design
```

## Architecture decisions

- **Feature modules and single registries.** Navigation, routes, commands and widgets each have one source of truth. `ROUTES` is exhaustive by type.
- **Native boundary in Rust, validated twice.** Commands return camelCase structs mirrored in TypeScript. Rust validates every input (ids, sizes, dates, URLs, paths), and the frontend sanitizes everything it loads from storage.
- **Local SQLite with transactional migrations** (`PRAGMA user_version`, schema v2). A database from a newer version is refused, never modified. If storage fails, NOVA keeps working and explains why.
- **Honest data.** Hardware values are `Option`s. GPU utilization, temperatures, media positions and controls appear only when the system reports them. There is no demo or fake data anywhere.
- **Secrets never reach the webview.** AI keys are written to Windows Credential Manager and read only by Rust. Requests, streaming and SSE parsing all happen natively.
- **Scoped OS access.** Apps launch only by id (scanned or user-added). Files open only inside standard folders, favorites or Recent. Links open only over http(s). No shell is ever spawned with user input.
- **Liquid glass on modest hardware.** The backdrop (optionally your wallpaper, pre-scaled to 960 px) is static. Glass uses `backdrop-filter`, a light-from-above rim and inner highlights, with no per-frame effects. Transparency can be turned off for opaque, faster surfaces.
- **Efficient polling.** TanStack Query intervals pause when the window is hidden or the data isn't on screen. Processes, sensors and weather each poll at their own slower rates.

## Security & privacy

- 53 app commands, each declared in `build.rs` and granted individually in `capabilities/default.json`; plugin permissions are limited to `dialog:allow-open` and `notification:default`. Strict CSP: no remote scripts, styles or connections from the webview.
- No analytics or telemetry. Network connections happen only for what you set up: weather (Open-Meteo, coordinates only), news feeds you add, and AI providers when you send a message. Settings → Privacy lists the active ones live.
- Background behavior (tray on close, start with Windows) is off until you enable it.
- Data: `%APPDATA%\dev.nova.commandcenter\nova.db`; keys: Windows Credential Manager (`NOVA:ai:*`).
