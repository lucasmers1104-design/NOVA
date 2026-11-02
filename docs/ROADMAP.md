# NOVA Roadmap & Progress

Legend: ✅ done · ⬜ planned

## Milestone 1 — Foundation ✅
- ✅ Toolchain (Rust 1.99 MSVC, VS 2022 Build Tools), Tauri 2 + React 19 + TypeScript 7 + Vite 8 + Tailwind 4
- ✅ Design tokens, accent engine with WCAG validation, frameless window, sidebar, all sections navigable
- ✅ Command palette, global shortcuts, widget registry, first real-data widgets

## Milestone 2 — Premium UI ✅
- ✅ SQLite with transactional migrations; settings persisted in SQLite with one-time migration
- ✅ Editable dashboard (drag, resize, keyboard), multiple layouts, widget config schemas
- ✅ Wallpaper palette and "Match automatically" accent; customizable sidebar

## Milestone 3 — Real System Data ✅
- ✅ System page: CPU per core, memory, GPU utilization and VRAM via D3DKMT (capability-detected), network throughput with MAC deduplication
- ✅ Temperatures via WMI where exposed, otherwise an honest "not exposed" state
- ✅ Process list (sortable, filterable, pausable), adapters, storage; GPU and Network widgets

## Milestone 4 — Applications & Media ✅
- ✅ Start menu discovery (both roots), real icons via `IShellItemImageFactory`, categories, search
- ✅ Favorites (reorderable), recents, custom apps via the native picker; launch by id with ShellExecute
- ✅ Windows media session: metadata, artwork, position, per-player controls; Core Audio master volume and mute; history
- ✅ Quick launch and Now playing widgets

## Milestone 5 — Productivity ✅
- ✅ Tasks (priority, due date and time, reminders, projects), notes (Markdown, pinning, autosave), projects with colors
- ✅ Today overview, upcoming, all, completed, calendar month view, search; SQLite schema v2
- ✅ Reminders: once per due moment, in-app and as Windows notifications (opt-out)
- ✅ Today's tasks widget

## Milestone 6 — NOVA AI ✅
- ✅ Common provider interface: Anthropic, OpenAI, Google Gemini; model lists fetched from each provider
- ✅ Keys in Windows Credential Manager (never readable by the webview)
- ✅ Streaming over Tauri channels with a UTF-8-safe SSE parser; stop; history, rename, delete; Markdown and code blocks with copy
- ⚠️ End-to-end replies need your own API key; provider parsing is verified with recorded fixtures

## Milestone 7 — Advanced Features ✅
- ✅ Widget Studio: catalog, live preview with settings, add to any layout
- ✅ Workspace profiles: Gaming, Productivity, Creative, Minimal, Custom; View Transition cross-fade
- ✅ Command palette sources: apps, tasks, widgets, profiles
- ✅ Live Information: Open-Meteo weather with place search, RSS/Atom news, clocks, progress, agenda; Weather, Headlines and Progress widgets
- ✅ File Hub: standard folders, favorites, recent files, scoped browser and search

## Milestone 8 — Release ✅
- ✅ Tray icon (open/quit), opt-in close to tray, opt-in start with Windows (`--background`), single instance, window position restore
- ✅ Notification center fed by real events; app-level error boundary; graceful close (pending saves flushed)
- ✅ Accessibility: labelled controls, keyboard paths for every action, live regions, focus traps, reduced motion
- ✅ Version 1.0.0, NSIS installer, release documentation
- ✅ Liquid glass redesign: translucent layered glass, floating sidebar, capsule controls, wallpaper backdrop

## Next ideas
- Calendar sync adapters (Outlook, Google) behind explicit opt-in
- AI agent mode with permission-gated tools (see [PLUGIN_API.md](PLUGIN_API.md#agents))
- Third-party widgets through the permissioned plugin API (design in [PLUGIN_API.md](PLUGIN_API.md))
- Store (UWP) apps in the launcher via the `shell:AppsFolder` namespace
- Split widget metadata from components to shrink the startup bundle

## Known limitations
- Media controls depend on what each player exposes; some browsers don't report position or skip.
- Temperatures are unavailable on most consumer firmware without elevated drivers; NOVA reports this honestly.
- The launcher lists Start menu shortcuts; Microsoft Store apps without shortcuts are not listed yet.
- Reminders fire while NOVA is running (including in the tray).
