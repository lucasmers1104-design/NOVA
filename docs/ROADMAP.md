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

# NOVA AI — the desktop assistant

"One dot. Your entire PC. One intelligent assistant." Built milestone by milestone; each one compiles, is tested and runs on its own.

## A1 — Floating dot ✅
- ✅ Two small transparent always-on-top windows: the dot (`dot.html`, no Tailwind or motion library) and the panel (`assistant.html`), placed by Rust (`src-tauri/src/assistant.rs`)
- ✅ Glass orb in the accent color; idle breathing in short bursts (twice after settling, then once a minute: ~0.07 % CPU at rest instead of ~9 % for a constant animation); hover growth and halo; open ring; reduced motion
- ✅ Click to expand/collapse; the panel grows out of the dot's corner, opens above or below and left or right depending on where the dot is, and shrinks to fit small screens; Esc, minimize and close collapse it
- ✅ Position: four corners of the main display, or drag anywhere on any display (saved once the mouse button is released; off-screen positions fall back to the corner); three sizes; DPI-correct
- ✅ Global shortcut (default Ctrl+Alt+N), recorder in Settings, conflicts with other apps reported instead of failing silently
- ✅ Tray "Talk to NOVA", dot right-click menu (talk, open NOVA, settings, hide the dot), command palette entry
- ✅ Opt-in background assistant: closing NOVA's window keeps the dot and shortcut; otherwise closing quits everything
- ✅ Separate capability for the assistant windows: no file, system or settings-write access

## A2 — Assistant interface ✅
- ✅ Conversation with streaming Markdown replies, user bubbles with attachments, tool cards inline, error with retry, auto-scroll that respects reading
- ✅ Eleven states (idle, activating, listening, processing, thinking, searching, analyzing screen, executing, speaking, completed, error) on the header orb and the dot; dot animations run only while busy
- ✅ Input with attachments (file picker in Rust), screen sharing menu, push-to-talk, send/stop; Esc stops speech, then closes; new conversation; action history view
- ✅ Footer: provider · model, spoken replies toggle, microphone and screen indicators

## A3 — Voice ✅
- ✅ Push-to-talk through Windows speech recognition (WinRT): live transcript, end-of-speech detection, level meter, stop early; language "same as Windows" or de-DE/de-AT/de-CH/en-US/en-GB
- ✅ Clear failures with a button to the right Windows settings page (online speech recognition off, microphone blocked, language missing)
- ✅ Spoken replies with the Windows voices (choice of voice, speed, volume, test), word-driven visualization, interrupt on Esc, stop, new input or the mic; replies to spoken questions are always spoken
- ⚠️ Windows dictation needs "Online speech recognition" (Settings → Privacy → Speech); on the development PC it is off, so recognition itself is verified up to that error

## A4 — AI provider ✅
- ✅ Provider-independent conversation model (text, images, tool calls, tool results) with request builders and streaming parsers for Anthropic, OpenAI and Gemini, verified with recorded event fixtures
- ✅ Anthropic: claude-opus-5-5 by default, adaptive thinking blocks replayed unchanged, `output_config.effort` (Fast/Balanced/Thorough), eager tool-input streaming with strict JSON validation, server-side refusal fallbacks, refusal and max-tokens handling
- ✅ Session context kept append-only (thinking-safe); interrupted turns merge instead of editing history
- ✅ Token usage per reply and per month, cost estimates from Anthropic's published prices (other providers: tokens only), optional monthly limit
- ✅ End-to-end loop verified in the running app against a scripted local mock (debug builds only)

## A5 — NOVA Vision ✅
- ✅ Screenshots of a display or the window the user was in (tracked with a foreground event hook, no polling); NOVA's dot and panel are excluded from capture
- ✅ Only on request: the screen button, or the `look_at_screen` tool after "Allow"; scaled to 1568 px, kept in memory for the conversation only
- ✅ Prompting for visible facts vs. assumptions and step-by-step guidance

## A6 — NOVA Finder ✅
- ✅ User-chosen folders (native picker or the standard folders); nothing indexed by default
- ✅ Incremental background index (size + modification time) at background CPU and I/O priority, hidden/system and cache folders skipped, refreshed at startup and when stale
- ✅ SQLite FTS5 over names (split at _ - . and camelCase), folders and the beginning of text files; filters for type, extension, date, folder; any-word fallback; content excerpts only for real content matches
- ✅ Result cards (open, show in folder, copy path), numbered for follow-ups; local mode understands "öffne die dritte"

## A7 — Task execution ✅
- ✅ Typed tool registry (13 tools) with argument validation in Rust; file access limited to the user's folders; programs and scripts never opened from files
- ✅ Confirmation tiers: safe (search, open, list, apps, websites, system info), confirm (documents, folders, move, rename, screenshot), high (delete → Recycle Bin)
- ✅ Documents: PDF (own writer, Windows-1252 Helvetica, wrapping, pages), TXT, Markdown, HTML in DocumentsNOVA Workspace; never overwrites; verified on disk
- ✅ Local action history (done / failed / declined), viewable in the panel and clearable in Settings

## A8 — Final polish ✅
- ✅ Multi-monitor: dragged positions per display, fallback when a display disappears, DPI-correct placement
- ✅ Optional "hide the dot in fullscreen apps" (shell notification state, checked only while enabled)
- ✅ Accessibility: labelled controls, live status, alert dialogs for confirmations, keyboard paths, reduced motion
- ✅ Settings for model, voice, Finder, limits and history; privacy facts and external connections updated
- ✅ Version 1.2.0, signed installer

## 1.3 — Hands-free and quieter ✅
- ✅ "Hey NOVA": offline phrase spotting (Windows speech recognition, fixed phrase list with decoys, confidence threshold), pauses during dictation, speech, lock screen and fullscreen apps
- ✅ Double clap: own detector (onset, width, decay, spectrum, flatness, timing, level match, quiet around) plus live vetoes for keyboard/mouse input and speaker output; 0 false triggers on the speech, music, typing and Windows-sound test sets
- ✅ Settings with a live test of what NOVA hears
- ✅ The dot in the taskbar, a quieter default look and a full look editor with preview
- ✅ A cleaner NOVA AI panel

## 1.5 — Voice & speed ✅
- ✅ Replies spoken sentence by sentence while they stream in (tool rounds, confirmations, stop), with German text normalization
- ✅ Prompt caching, a cache prewarm while the user speaks, and lighter effort for spoken questions
- ✅ Windows recognizer prepared during the greeting; an end-of-turn pause that fits what was said
- ✅ NOVA's own voices in-process on ONNX Runtime (Piper parity verified; Kokoro experimental), piper.exe and Windows voices as fallbacks
- ✅ Offline speech recognition (Parakeet TDT + Silero VAD), also as the fallback when Windows can't listen
- ✅ Hardware detection, measurements in a separate process, CPU or DirectML (NVIDIA, AMD, Intel) by measurement, three performance modes
- ⚠️ Speaking into NOVA while it talks (barge-in) is not supported: it needs echo cancellation Windows doesn't reliably provide

## 1.7 — The whole PC ✅
- ✅ `task_manager`, `installed_programs`, `end_process`: what runs and what it costs, what takes disk space, ending programs (high-impact confirmation; Windows' own processes refused)
- ✅ `list_windows`, `window_action`, `read_window` (UI Automation), `use_element`, `send_input`: working other apps, each change confirmed; keys only reach the chosen window
- ✅ Automatic switch to the offline recognizer when Windows' dictation hears speech but returns no words
- ⚠️ Windows' dictation returning nothing was seen on one PC with online recognition on and the language installed; why Windows stays silent there isn't known. NOVA works around it rather than fixing it
- ⚠️ Per-program GPU use and sizes of programs that don't report one aren't available

## 1.10.1 — Plugins and optional statistics ✅
- ✅ Signed `.novaplugin` packages, a Plugins page, per-permission switches, pages, widgets and accent colors from plugins (see [PLUGIN_API.md](PLUGIN_API.md))
- ✅ Plugins sandboxed in iframes, every call checked in Rust; a hostile test plugin and a counting address in `scripts/e2e`
- ✅ Optional usage statistics: nothing leaves before "Akzeptieren", closed list of events, withdrawal with deletion, a view of what was sent
- ⚠️ A plugin stuck in a loop can use a CPU core until it is turned off; NOVA's window stays responsive

## 1.10.2 — A hands-on tour ✅
- ✅ Appears once on a new installation, after the consent popup: name, color, voice download, AI key, "Hey NOVA", a walk through the real app, shortcuts
- ⚠️ German only, like the consent popup, while the rest of the interface is English

## 1.11 — Games ✅
- ✅ “Clip das!”: a replay buffer while a game runs in fullscreen (ffmpeg, Desktop Duplication, NVENC/AMF or Windows' encoder, two-second pieces joined without re-encoding), with the PC's sound through WASAPI loopback
- ✅ “Schick das an die Jungs”: the latest clip to a saved Discord webhook, shrunk to fit
- ✅ “Wie lange zock ich schon?” and “Was hat da eben geruckelt?” from a per-second record kept only while a game runs
- ✅ “Nova, Stopp” starts a new chat; the dot can sit anywhere on the taskbar
- ⚠️ No frame rate or network lag: that needs a hook in the game or administrator rights

## NOVA Companion — the phone ✅
See [mobile/PLAN.md](mobile/PLAN.md).
- ✅ C0 Protocol in one shared package (types, checking parsers, fixtures Rust and TypeScript both test against), phone permission tiers (an exhaustive match: a new tool doesn't compile without a tier), schedule with a two-hour make-up window
- ✅ C1 Pairing by single-use QR code with a click on the PC, X25519 + HKDF + AES-256-GCM sessions (Noise KK pattern), WebSocket server on the LAN with mDNS, device list and revoke; end-to-end test over real sockets
- ✅ C2 Expo app (Android first): Start, Chat, Aufgaben, Freigaben, pairing, reconnect, glass look
- ✅ C3 Tasks run through NOVA AI in the phone's own conversation; the phone's tiers replace the PC's confirmations; answer and screenshot to the phone
- ✅ C4 Approvals bound to the phone's biometric-locked Keystore key, two-minute expiry, a notification on the PC
- ✅ C5 Outbox for "sobald PC an", tasks at a set time, watchers that tell the phone, AI checks with a call limit, local notifications and a background pickup every ~15 minutes
- ✅ C6 Quick capture, dictation with the phone's speech recognition, docs
- ✅ As a plugin: NOVA Companion comes from the new plugin list (Plugins → Available) and needs the `companion` permission, which only NOVA-signed plugins get; without it the phone connection doesn't run. The Android app (arm64) is in `releases/`
- ⚠️ No APK built here: this PC has no Android SDK. The app typechecks and its Android bundle builds; see [mobile/README.md](../mobile/README.md)
- ⚠️ The handshake follows the Noise KK pattern but is written by hand; have someone with cryptography experience review it before a public release
- ⚠️ Later: relay server, Wake-on-LAN, several PCs, iOS build, location triggers, live screen, widgets, file transfer

## Next ideas
- Calendar sync adapters (Outlook, Google) behind explicit opt-in
- More plugins in the plugin list, and plugins contributing tools to NOVA AI (see [PLUGIN_API.md](PLUGIN_API.md#later))
- Store (UWP) apps in the launcher via the `shell:AppsFolder` namespace
- Split widget metadata from components to shrink the startup bundle

## Known limitations
- Media controls depend on what each player exposes; some browsers don't report position or skip.
- Temperatures are unavailable on most consumer firmware without elevated drivers; NOVA reports this honestly.
- The launcher lists Start menu shortcuts; Microsoft Store apps without shortcuts are not listed yet.
- Reminders fire while NOVA is running (including in the tray).
