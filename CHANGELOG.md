# Changelog

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
