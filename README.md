# NOVA — Your Personal Command Center

_Everything. Connected._

NOVA is a local-first Windows desktop command center with a macOS-inspired "liquid glass" interface. It combines a customizable widget dashboard, real-time system monitoring, an app launcher, media controls, tasks and notes, a multi-provider AI assistant, a file hub and live information in one app.

**Status:** Version 1.7.1. All eight roadmap milestones and the eight NOVA AI assistant milestones are complete; see [docs/ROADMAP.md](docs/ROADMAP.md) and [CHANGELOG.md](CHANGELOG.md).

## Features

| Area | What it does |
| --- | --- |
| **Home** | Drag-and-drop dashboard with resizable widgets, multiple layouts, per-widget settings, and keyboard editing. |
| **System** | Live CPU (per core), memory, GPU utilization and VRAM (when the driver reports them), network throughput, storage, temperatures (only if exposed) and processes. |
| **Apps** | Start menu discovery with real icons, search, favorites, recents, custom apps added through the native picker, and one-click launch. |
| **NOVA AI** | Anthropic, OpenAI and Google Gemini behind one interface. Streaming replies, Markdown and code blocks, conversation history. Keys are stored in Windows Credential Manager. |
| **NOVA AI assistant** | A small dot in the taskbar opens NOVA AI from anywhere: click it, press Ctrl+Alt+N, say “Hey NOVA” or clap twice (both opt-in, recognized on the PC). Its look — style, size, color, visibility, glow — is up to you. Talk or type: it finds files (NOVA Finder), opens apps and files, tells you what slows your PC down and ends programs, works your other apps (tabs, buttons, keys), writes PDF/TXT/Markdown/HTML documents, looks at your screen when you share it, and speaks its answers — sentence by sentence while they are still being written, with its own offline German voices (Piper; Kokoro experimental). Speech recognition uses Windows or, offline, NVIDIA Parakeet. Voices and recognition run on the processor or any DirectX 12 graphics card (NVIDIA, AMD, Intel), whichever was measured to be faster on your PC. Changes wait for your OK; everything it does is logged locally. Without an AI key it still finds files and opens apps. See [the assistant roadmap](docs/ROADMAP.md#nova-ai--the-desktop-assistant). |
| **Productivity** | Tasks with priorities, due dates, reminders and projects; Markdown notes; calendar; daily overview. |
| **Media** | Whatever Windows reports as playing (Spotify, browsers, Media Player…): artwork, position, the controls that player supports, system volume, and history. |
| **Files** | Standard folders, favorite folders, recent files, a scoped browser and search. Files open with their Windows associations. Read-only. |
| **Live Information** | Weather (Open-Meteo, no account needed), RSS/Atom news from feeds you add, world clocks, progress and agenda cards. |
| **Widget Studio** | Browse 15 widgets, preview them live with settings, and add them to any layout. |
| **Profiles** | Gaming, Productivity, Creative, Minimal and custom profiles switch layout, accent and appearance together. |
| **Everywhere** | Command palette (Ctrl+K) over pages, apps, tasks, widgets and profiles; notification center; adaptive accent (presets, custom, or matching your wallpaper); backgrounds (your wallpaper, gradient presets or your own gradient) behind adjustable glass; tray icon; opt-in start with Windows and close to tray. |

## Download & updates

- **Install:** download `releases/NOVA_<version>_x64-setup.exe` from this repository and run it. Windows SmartScreen asks once, because the installer is unsigned.
- **Updates:** NOVA checks the repository at every start, including starts with Windows. New versions install after a short notice, and NOVA reopens by itself. You can configure this in Settings → Updates.
- **Publishing a version:** `npm run release`; see [docs/RELEASE.md](docs/RELEASE.md).

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
| `npm run release` | Signed release build and publish into `releases/` (installer, signature, `latest.json`). See [docs/RELEASE.md](docs/RELEASE.md). |
| `npm run desktop:build` | Release build plus the NSIS installer in `src-tauri/target/release/bundle/nsis/`. |
| `npm run dev` | Browser-only preview at <http://localhost:1420>. Native features show a clear "desktop runtime required" state. |
| `npm test` | Frontend unit and UI tests (Vitest + Testing Library). |
| `npm run typecheck` | Strict TypeScript checks. |
| `npm run check:rust` | `cargo check` plus Rust tests (SQLite migrations, parsers, and native integrations on the real machine). |
| `npm run check` | All of the above. |
| `cargo run --example clap_eval -- [--normal] file.wav …` | Runs the double-clap detector over recordings (in `src-tauri/`): claps should be found, everything else ignored. `CLAP_VERBOSE=1` explains each sharp sound. |

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
│  ├─ nova-assistant         Dot and panel (own entries: dot.html, assistant.html), conversation, voice, settings
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
├─ src/updates.rs            Signed self-updates (Tauri updater, configurable source)
├─ src/assistant.rs          NOVA AI dot and panel windows, multi-monitor placement, global shortcut, fullscreen
├─ src/agent/                NOVA AI: provider streaming with tools and images, tool registry, local mode, the PC and other apps (pc.rs)
├─ src/finder.rs             NOVA Finder: incremental background index and search (SQLite FTS5)
├─ src/documents.rs          PDF / TXT / Markdown / HTML documents in DocumentsNOVA Workspace
├─ src/capture.rs, voice.rs  Screenshots (own windows excluded), spoken turns (Windows or offline recognition)
├─ src/speech/               NOVA's own voices and offline recognition on ONNX Runtime (CPU / DirectML), hardware detection, measurements, downloads
├─ src/turnlog.rs            Timings of spoken turns (voice-turns.jsonl; numbers only)
├─ src/wake/                 “Hey NOVA” (offline phrase spotting by Windows or NOVA's own recognizer) and the double-clap detector (WASAPI)
└─ capabilities/, build.rs   One explicit permission per command (106 commands)
releases/                    Signed installers + latest.json (update channel)
scripts/release.mjs          Build, sign and publish a release
scripts/build-helpers.mjs    Builds nova-phonemize before dev and release builds
scripts/mock-anthropic.mjs   Scripted stand-in for the Anthropic API (end-to-end tests)
scripts/cdp.mjs              Drives a dev build over the DevTools protocol
tools/nova-phonemize/        eSpeak NG phonemizer for NOVA's voices (separate program, GPL-3.0)
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
- **Speech that starts early and runs where it is fastest.** Replies are spoken sentence by sentence as they stream in (a sentence counts only once the next character proves it ended, so “z. B.” and “3. Mai” stay whole), German text is normalized for the voice (times, dates, amounts, units), and prompt caching plus a cache prewarm while you speak shorten the wait for the first words. NOVA's voices and recognizer run on one ONNX Runtime build for the processor and DirectML; a measurement in a separate process (so a faulty graphics driver can't take NOVA down) decides where each model runs — never the GPU brand. piper.exe stays as the fallback voice, a Windows voice as the last one.
- **The assistant lives in two tiny windows.** The dot is its own transparent window just larger than the dot, so it never blocks the desktop; the panel is a second window that animates in and out instead of resizing one. Rust places both from each monitor's work area and scale. The dot page has no Tailwind or animation library, and its glow breathes only in short bursts because any running animation makes a transparent window composite every frame.

## Security & privacy

- 106 app commands, each declared in `build.rs` and granted individually: `capabilities/default.json` for the main window, `capabilities/assistant.json` for the dot and panel (conversation, confirmations, screenshots and voice the user starts; no direct file, system or settings-write access — files are reached only through NOVA AI's validated tools in Rust). Plugin permissions are limited to `dialog:allow-open`, `notification:default` and window dragging for the dot. Strict CSP: no remote scripts, styles or connections from the webview.
- No analytics or telemetry. Network connections happen only for what you set up: weather (Open-Meteo, coordinates only), news feeds you add, AI providers when you send a message (including screenshots and files you share with NOVA AI), Windows online speech recognition while you talk to NOVA (unless you choose the offline recognizer), downloads of NOVA's voices, speech runtime and offline recognizer from Hugging Face and NuGet when you choose them, or by itself and with a notice when Windows' recognition hears you but returns no words (each file pinned to a SHA-256 hash), public web pages and web searches when NOVA AI looks something up for your request (searches run at Anthropic, about 1 cent each; pages are fetched directly and never from your own network), and update checks against your release repository at startup (can be turned off). Settings → Privacy lists the active ones live.
- Background behavior (tray on close, background assistant, start with Windows) is off until you enable it. NOVA AI uses the microphone only while you hold a conversation by voice — or, if you turn on “Hey NOVA” or the double clap, keeps it open and checks the sound on the PC without recording, storing or sending it — takes screenshots only when you share the screen or allow it, keeps conversations in memory only, and asks before creating, moving, renaming or deleting anything (deleting goes to the Recycle Bin). File actions are limited to your own folders. NOVA AI also asks before ending a program, closing a window, reading another app's window (its contents go to your AI provider) or using keys and clicks there; the list of running programs and window titles it reads without asking. Keys go only to the chosen window; terminals and the Windows key are refused, and Windows' own processes can't be ended.
- Data: `%APPDATA%\dev.nova.commandcenter\nova.db`; keys: Windows Credential Manager (`NOVA:ai:*`).
