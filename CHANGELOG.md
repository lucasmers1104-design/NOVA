# Changelog

## 1.4.0 — 2026-11-04

### Added
- **NOVA's own voice, Thorsten**: a natural-sounding German voice that runs on your PC, offline. It's downloaded once in the background (about 85 MB, checked before use); until then NOVA speaks with a Windows voice. Replies are spoken sentence by sentence, so NOVA starts talking right away. "Automatic" uses Thorsten for German and a Windows voice otherwise; Settings → Assistant model & voice can pick Thorsten or any Windows voice.

### Fixed
- Voice input could hear you (the bars moved) but understand nothing: the clap detector and "Hey NOVA" kept using the microphone while NOVA listened to your request. Both now let go of the microphone completely while NOVA talks with you, and only resume a moment after NOVA has finished speaking.
- The voice line says "Einen Moment …" until the microphone is really open, then "Ich höre zu …", so the first words aren't lost.
- Phrases Windows wasn't sure about are used when nothing else was understood, and a turn without words explains in your language whether NOVA heard nothing at all or heard you without making out words. Each turn's timings (never what you said) are kept in `voice-last-turn.txt` in NOVA's local data folder.

## 1.3.2 — 2026-11-04

### Changed
- Talking to NOVA is a real conversation turn now: after "Hey NOVA" or a double clap, NOVA greets you ("Was kann ich für dich tun?"), then listens with a voice line whose bars jump up while you speak and sink back slowly when you're quiet, with your words appearing live. Short pauses are waited out; after about 1.6 s of quiet your request is sent by itself (or press ✓; ✕ cancels).
- Once sent, NOVA says a short "one moment" ("Alles klar, ich schau mir das direkt an …") and reads the answer aloud when it's ready. Lines are German when NOVA listens in German.

### Fixed
- Voice input often ended at the first short pause or stopped with "Speech recognition stopped" and sent nothing: it now listens continuously and keeps everything said in the turn.

## 1.3.1 — 2026-11-03

### Changed
- The dot stays on the desktop when you close NOVA's window: NOVA keeps running quietly with the dot, the shortcut and "Hey NOVA". Quit from the tray icon or with "Quit NOVA" in the dot's menu. With Start with Windows, NOVA starts with just the dot.

### Added
- "Pause listening" / "Resume listening" in the dot's right-click menu turns "Hey NOVA" and the double clap off (microphone closed) and back on; Settings shows the pause with a Resume button.
- "Start with Windows" right in the dot's settings, so the dot is there after every restart.
- In NOVA AI: copy a reply, jump back to the latest message, Up recalls your last message, Ctrl+N starts a new conversation, Ctrl+Shift+C copies the last reply, dismissible error notes, a cleaner action history.
- Settings: a "Hover" state in the dot preview, a clearer live test (time left, timestamps, Clear) and a tip on how to clap.
- Clear buttons and Esc in the Apps, Files and process searches, loading placeholders and better empty messages; Ctrl+Home/End and PageUp/PageDown in the command palette.

### Fixed
- "Hey NOVA" and the double clap: dictation and the phrase recognizer can no longer overlap, ending a pause no longer lets claps from that moment through, unknown idle time no longer blocks every double clap, no restart loop after short silences, no crash right after boot.
- Minimizing all windows (Win+M or other tools) no longer moves the dot to the top-left corner.

## 1.3.0 — 2026-11-03

### Added
- **"Hey NOVA"**: say it and NOVA AI opens and listens for your request. Recognized offline by Windows from a fixed phrase list (works with online speech recognition off); similar phrases ("Hey Noah", "Nova", other assistants' names) are ignored, and "Only when clear" accepts only what Windows is confident about.
- **Double clap**: clap twice to wake NOVA. NOVA's own detector looks for two sudden, short, noise-like bursts 0.17–0.65 s apart, about equally loud, with quiet before, between and after. Speech, music, typing, knocks, clinks and beeps, single claps and applause don't count, nor do claps while you type or click, or sounds that come from the PC's speakers. "Very precise" (default) or "More forgiving".
- Settings → Hey NOVA & claps: both off until you turn them on; what happens after waking (listen or just open), a wake sound, pausing in fullscreen apps and games, and a two-minute test that shows what NOVA hears without opening anything. Listening pauses during dictation, while NOVA speaks and while the PC is locked.
- **The dot's look is yours**: glass, orb, flat or ring; size 16–56 px; color (accent, white, presets or any color); how visible it is at rest; glow, breathing, the sparkle and activity rings on or off — with a live preview.
- The dot can sit **in the taskbar**, right after your app buttons (before widgets such as News and interests), and follows it as the taskbar changes; or in a corner with an adjustable distance from the edge.

### Changed
- The dot is much quieter by default: a 24 px glass bead in the taskbar, 70 % visible until you point at it, without glow or breathing.
- NOVA AI's panel is cleaner: a slim header (status only while NOVA works), one menu for spoken replies, action history, AI provider and settings, a centered greeting with a few suggestions, one input with a single "+" for files and screenshots, no footer. Replies read as plain text, actions as one-line notes; only confirmations stand out. Token usage appears when you point at a reply.

### Security
- 93 explicitly permitted commands. The dot and panel may read the wake status and report when NOVA speaks; only the main window can change wake settings or run the test. The microphone audio for "Hey NOVA" and claps never leaves memory.

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
