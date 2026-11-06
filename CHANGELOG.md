# Changelog

## 1.7.0 — 2026-11-06

**Install this version once by hand.** Updates are signed with a new key from 1.7.0 on, so older versions can't install it by themselves and report that the update failed. Run `releases/NOVA_1.7.0_x64-setup.exe` over your installation; your data stays, and updates are automatic again afterwards.

### Added
- **NOVA AI knows what your PC is doing**: ask "was bringt mein PC gerade zum Laggen?" and it reads the same things as the Task Manager: total CPU, memory, GPU and drive space, the programs using the most CPU, memory and disk, and windows that aren't responding. It also lists installed programs by the space they take.
- **NOVA AI ends programs**: after your explicit OK it closes a program so it can save, or force-quits it if it hangs. Windows' own processes, the security software and NOVA itself are off limits.
- **NOVA AI works your other apps**: it sees the open windows, reads a window's tabs, buttons and fields, presses buttons, fills fields, and sends key combinations and text, so "schließe alle Tabs in Opera GX" works. Reading a window, keys, clicks and closing all wait for your OK. Keys go only to the chosen window and stop if another one comes to the front. Terminals and the Windows key are refused, because typing there would run commands.

### Fixed
- **Voice: "Ich habe dich gehört, aber keine Wörter verstanden."** On some PCs Windows' online recognition hears speech but never returns a word, and reports nothing as wrong. After two such turns in a row NOVA now switches to its own offline recognizer by itself and downloads it if needed (about 670 MB), telling you so.
- Closing the panel while talking sent your half-finished sentence to NOVA AI as a request. Closing and Cancel now throw it away.
- Offline recognition ended the turn after a cough or room noise, before you had said anything, and could end it before a slow PC had finished the last phrase. It could also load twice at a wake-up and stay stuck on "Einen Moment" after taking over from Windows.
- A wake-up while a reply was running cut the reply off and then didn't listen; a greeting whose audio never ended kept the microphone closed.
- Stopping speech in one window could silence the voice preview in Settings, or switch NOVA's own voice to a Windows voice until restart.
- A rejected or declined request stayed in the conversation, so every later message failed the same way. Cut-off and empty replies now say so instead of looking finished.
- Security: `open_file` could be tricked into starting a program by a trailing dot in its name; network paths were contacted before they were checked; a web page's name could point to your own network the second time it was resolved. The focus on a confirmation card now sits on "Not now", so typing can't approve an action.
- Gemini: tools without arguments could fail every request, and repeated call ids corrupted tool cards.
- Screenshots could silently ride along with the next message after a refused one.
- Deleted notes came back and pin changes got lost; a note still being typed is now saved before NOVA closes or updates.
- Task dialogs opened from a widget were cut off, with Save out of reach. Opening a task puts the cursor in its title.
- Resizing an unavailable widget, or Undo at 48 widgets, made every later save of that layout fail. Touching a resize handle in a narrow window changed the widget's width.
- Enter on a widget's Remove button opened its settings; Enter on the Apps page started the first app with an empty search; the command palette often couldn't find apps.
- Calendars stayed on the old month and day after midnight; the Today bar went past 100 % on the day the clocks change; a fast volume drag could end on the wrong value.
- Reminders set by NOVA AI without a time promised a notification that never came; it now asks for the time.
- PDF and text documents keep code indentation and characters like `3 * 4`. The NOVA AI tab no longer cuts long answers at 4096 tokens.
- News: titles escaped twice or containing markup, German umlauts as named entities and Latin-1 feeds show correctly.
- The dot: Windows moving it (a monitor unplugged, a game changing the resolution) no longer counts as you dragging it; it stays on its screen at high display scaling, hides in fullscreen apps after being dragged and when NOVA starts behind one, and Alt+F4 can't remove it.
- The panel: a wake-up or shortcut during its closing animation is no longer lost, and closing it during its first load can't leave it blank or make it listen later.
- A failed update install now shows a banner with Retry, even before the first byte arrived. The file index can't lose search entries if NOVA ends in the middle of a sweep.

## 1.6.0 — 2026-11-05

### Added
- **NOVA AI runs your Productivity page**: it lists your tasks and, after your OK, adds tasks (with due date, time, priority, project and reminder), notes and projects, and marks tasks done. The page updates right away.
- **NOVA AI knows the internet**: it searches the web with Claude and names its source (about 1 cent per search, included in the cost estimate), reads public web pages (never addresses in your own network), opens a search in your browser and finds websites for you ("find me KFC's website").
- **NOVA AI controls your music**: play, pause, next, previous, volume and what's playing, for any player. It opens searches in Spotify; pressing play stays with you for now.
- **File paths you can use**: wherever NOVA AI touches a file or folder you can open it, show it in Explorer, copy its path or copy its name, and full paths in a reply become clickable.
- Without an AI provider, NOVA understands "lauter", "nächster Titel", "spiele …", "suche im Internet nach …", "google …" and "neue Aufgabe …".
- **Clock styles**: digital, minimal, analog, flip and word clock ("Es ist halb zehn") for Welcome and World clock, a new Analog clock widget, and an optional clock in the title bar (Settings → Dashboard).

### Changed
- Calmer page titles, widget headers and sidebar; the Welcome card makes room for its clock on narrow layouts.

### Fixed
- Links in NOVA AI's replies now open from the panel.
- An allowed action could keep spinning after it had finished.

## 1.5.0 — 2026-11-05

### Added
- **NOVA speaks while it writes.** Spoken replies start with the first finished sentence instead of after the whole answer, also around the tools NOVA uses. A sentence counts as finished only once the next character proves it, so "z. B.", "3. Mai", "2,5 GB" and "v1.4" stay whole, and the first piece is kept short so NOVA starts talking early. A short "one moment" plays only when the answer takes a while, and NOVA asks out loud when something needs your OK in the window.
- **German that sounds right**: times, dates, amounts, percentages, units, numbers, abbreviations and symbols are read the way people say them ("14:30 Uhr" → "vierzehn Uhr dreißig", "12,50 €" → "zwölf Euro fünfzig", "z. B." → "zum Beispiel").
- **Nine German voices of NOVA's own**: Thorsten (medium and high), Thorsten emotional, Kerstin, Ramona, Eva, Karlsson, Pavoque and Martin (Kokoro, experimental). Each is downloaded on demand in Settings → Local AI & performance, checked against a pinned SHA-256 hash, and can be listened to and picked there; the measured speed on your PC is shown next to it.
- **Voices run inside NOVA** on ONNX Runtime 1.24 with the same sound as piper.exe (identical phonemes for all 62 test sentences, identical length and waveform without noise) and about 20 % faster on the development PC. piper.exe remains the fallback and covers the first sentences while a voice loads; a Windows voice remains the last resort. Phonemes come from `nova-phonemize`, a small separate program under GPL-3.0, like the eSpeak NG it uses.
- **Offline speech recognition** (optional, about 670 MB): NVIDIA Parakeet TDT 0.6B v3 with Silero VAD transcribes each phrase as soon as you pause, so when you stop only the last phrase is left. Pick Windows, Offline or Automatic; Offline also steps in when Windows can't listen (online recognition off, no connection, no recognizer).
- **Any PC, any graphics card**: one runtime runs voices and recognition on the processor or, through DirectML, on any DirectX 12 graphics card — NVIDIA, AMD or Intel. NOVA never decides by brand: it measures each model on each device in a separate process (a crashing graphics driver can't take NOVA down) and uses the graphics card only where it is clearly faster. CUDA, ROCm and Vulkan are detected and shown but not needed.
- **Performance modes**: Auto, Max performance (fastest measured setup, models stay loaded) and Low resource (processor with one thread, models unloaded soon). Settings show the processor, memory, graphics cards with drivers, what each model runs on and why, and the measurements.
- Downloads continue where they stopped after a restart or a dropped connection, and from NuGet packages NOVA takes only the files it needs (35 MB instead of 214 MB).
- Each spoken turn's timings — never what was said — are kept in `voice-turns.jsonl` and `voice-last-reply.txt` in NOVA's local data folder.

### Changed
- **Answers come sooner**: the AI provider's prompt cache holds the system prompt, tools and conversation, and is warmed when NOVA opens or wakes. Spoken questions ask for a short spoken answer. Cost estimates count cached tokens at their real price.
- **Listening starts and ends sooner**: the recognizer gets ready while NOVA greets you, and a turn ends after a pause that fits what you said — shorter after a complete phrase, longer after "und", "weil" or "ähm".
- Stopping a reply also stops what NOVA was about to say (a stopped reply used to be read out anyway).
- Settings → Assistant model & voice lists the downloaded voices; testing a voice there now pauses "Hey NOVA" as it should.

### Measured on the development PC (Intel Core i3-6006U, HD Graphics 520, 8 GB)
- First spoken words after sending (scripted replies with one tool round): 1.9 s instead of 5.3 s.
- First words from Claude Haiku 5.5: 0.57–0.77 s, with 2,800–3,900 prompt tokens read from the cache on every request.
- Windows recognizer ready 0.12–0.14 s after the greeting instead of 1.0 s; offline recognition finished 0.5–1.0 s after the end of speech.
- Thorsten: 0.18 s of work per second of speech in NOVA (piper.exe: 0.20). The HD 520 was slower than the processor for every model, so Auto uses the processor; Thorsten (high) and Martin are too slow for real time on this PC.
- Round trip voice → Parakeet over 60 sentences: 7.2–8.0 % word errors, mostly numbers written as digits.

## 1.4.1 — 2026-11-04

### Changed
- NOVA answers a wake-up right away: its greetings and "one moment" lines are made ahead of time, and its voice stays ready for 20 minutes after it last spoke (instead of 5), so there's no pause of several seconds after a double clap or "Hey NOVA".
- Your request is sent sooner: NOVA treats a 1.1-second pause (was 1.6) as the end of what you said and no longer waits up to 3 seconds for Windows' final wording when it already has your words.
- Quieter voices are understood: while NOVA listens to a request, the microphone is turned all the way up, and set back to your level afterwards.

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
