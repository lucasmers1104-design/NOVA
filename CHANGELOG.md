# Changelog

## 1.2.0 — 2026-11-02

### Added
- **NOVA AI dot**: a floating glass dot above the taskbar. Click it or press Ctrl+Alt+N anywhere to open NOVA AI, which grows out of the dot. Drag it to any display, right-click it for options. It shows what NOVA is doing: listening, thinking, searching, working, speaking, done or error.
- **Conversations**: streaming replies from Anthropic, OpenAI or Gemini (your keys), with the conversation kept for the session. New conversation, stop, retry, and per-reply token usage with cost estimates for Claude models.
- **Actions with your OK**: NOVA AI searches, opens files and apps, lists folders, opens websites and checks system load right away. Creating documents and folders, moving, renaming and looking at your screen wait for "Allow"; deleting (to the Recycle Bin) needs an explicit "Yes, do it". Every action is logged locally (Action history).
- **NOVA Finder**: indexes the folders you choose (names, dates, types and the text inside text files) in the background at low priority. Search understands follow-ups like "open the third one".
- **Documents**: NOVA AI writes PDF, TXT, Markdown and HTML documents into Documents\NOVA Workspace and only reports them as saved once they are on disk.
- **NOVA Vision**: share a screenshot of your screen or the window you were using (screen button, or when NOVA asks). NOVA's own windows are left out; screenshots are never taken silently or stored.
- **Voice**: push-to-talk with Windows speech recognition (live transcript, level meter), spoken replies with the Windows voices (choice of voice, speed, volume), interruptible.
- **Local mode**: without an AI provider, NOVA AI still finds files and opens apps in German and English.
- Settings: assistant model, thoroughness, monthly spending limit, voice, speech language, NOVA Finder folders, "hide the dot in fullscreen apps", "keep NOVA AI available when the window is closed", and clearing the action history.

- The installed version is shown in the sidebar ("Command Center · v1.2.0").
- Updates come from github.com/lucasmers1104-design/NOVA out of the box (Settings → Updates can still override it).

### Fixed
- The model picker in the NOVA AI tab was locked without an API key; it now lists the suggested models (e.g. Claude Haiku 5.5) so you can choose before adding a key. NOVA AI's assistant follows that choice unless you pick a different model in its settings.
- A minimized or tray-hidden NOVA kept rendering and polling (WebView2 still reported the page as visible), using about a third of a dual-core CPU on Home. It now tells WebView2 the page is hidden: ~0.1 % CPU while minimized.
- The "live" dots on the dashboard pulse briefly and then rest, halving the CPU load of a visible Home page on integrated graphics.
- File names with underscores (LEGO_Plan_v2.xlsx) no longer turn partly italic in Markdown.

### Security
- 89 explicitly permitted commands; the dot and panel get their own capability without file, system or settings-write access. File actions are limited to your own folders; programs and scripts are never opened from files.

## 1.1.0 — 2026-11-02

### Added
- Automatic updates: NOVA checks for a new version at every start (also when started with Windows), shows a 15-second notice, then downloads, verifies, installs and reopens by itself.
- Settings → Updates: installed version, update source (your GitHub repository), automatic updates on/off, and "Check now".
- A notice after each update confirms the new version.
- Signed releases: installers in `releases/` with a `latest.json` manifest; `npm run release` builds and publishes them.

## 1.0.0 — 2026-11-02

First complete release: all eight roadmap milestones.

### Added
- **System page**: per-core CPU, memory, GPU utilization and VRAM (capability-detected), network throughput, temperatures where exposed, processes, adapters.
- **Apps**: Start menu discovery with real icons, search, favorites, recents, custom apps, launch by id.
- **Media**: Windows media session (metadata, artwork, position, supported controls), system volume and mute, history.
- **Productivity**: tasks, projects, Markdown notes, calendar, daily overview, reminders with Windows notifications.
- **NOVA AI**: Anthropic, OpenAI and Gemini with streaming, history and secure key storage.
- **Files**: standard and favorite folders, recent items, scoped browsing and search.
- **Live Information**: Open-Meteo weather, RSS/Atom headlines, clocks, progress, agenda.
- **Widget Studio** and **workspace profiles**; 8 new widgets (15 total).
- **Notification center**, tray icon, opt-in close to tray and start with Windows, single instance, window position restore.
- **Liquid glass design**: layered translucent glass, floating sidebar, capsule controls, optional wallpaper backdrop.
- SQLite schema v2 (shortcuts, projects, tasks, notes, AI conversations and messages).

### Security
- 53 explicitly permitted commands; Rust-side validation of every input; scoped file and app access; http(s)-only links; keys in Windows Credential Manager.

## 0.2.0 — Milestone 2
- SQLite persistence, editable multi-layout dashboard, widget settings, wallpaper accents, customizable sidebar.

## 0.1.0 — Milestone 1
- Foundation: shell, design system, accent engine, command palette, first live widgets.
