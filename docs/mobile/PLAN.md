# NOVA Companion — Plan für die mobile App

Stand: 2026-11-08 · Status: C0 bis C6 gebaut, APK-Build offen (kein Android-SDK auf diesem PC) · Basis: NOVA 1.11.1

Die App ist ein Auftragskanal zu NOVA AI auf dem PC. Das Handy ist ein dünner Client: Es schickt Aufträge und Freigaben, es zeigt Antworten, Screenshots und Benachrichtigungen. Die KI-Logik, die Schlüssel und das Protokoll bleiben auf dem PC.

---

## 1. Was es schon gibt und wiederverwendet wird

| Bestand | Wo | Wie der Companion es nutzt |
| --- | --- | --- |
| Agenten-Schleife (Anfrage → Werkzeuge → Anfrage, max. 25 Runden) mit Ereignissen `Status`, `Text`, `ToolStarted`, `ConfirmRequired`, `ToolFinished`, `Done`, `Failed` | `src-tauri/src/agent/mod.rs` (`run_turn`, `AgentEvent`) | Aufträge vom Handy laufen durch genau diese Schleife. Statt eines Webview-Kanals bekommt sie einen `tauri::ipc::Channel::new(…)` aus Rust (gibt es in Tauri 2.12), der die Ereignisse verschlüsselt ans Handy weiterreicht. |
| Schnellbefehle ohne KI (`play::quick`) und lokaler Modus ohne Schlüssel (`run_local`) | `agent/play.rs`, `agent/local.rs` | „Öffne Fortnite“ und „Clip das“ funktionieren vom Handy auch ohne KI-Schlüssel, ohne Zusatzcode. |
| 61 typisierte Werkzeuge mit Prüfung in Rust und Stufen `Safe` / `Confirm` / `High` | `agent/tools.rs` (`definitions`, `prepare`, `execute`, `Risk`) | Die Handy-Stufen (Frei, Freigabe, Nie) werden als zweite, strengere Prüfung über `prepare` gelegt. Kein Werkzeug wird neu geschrieben. |
| Bestätigungen per `oneshot` je Werkzeugaufruf | `agent/mod.rs` (`confirm`, `assistant_confirm`) | Die Freigabe vom Handy landet im selben Bestätigungs-Mechanismus. |
| Screenshot ohne NOVAs eigene Fenster, nur im Speicher, skaliert auf 1568 px | `capture.rs`, Werkzeug `look_at_screen` | Für „Wie lange geht der Download noch?“ und für den Screenshot in der Antwort. |
| Wächter ohne KI-Aufrufe: `GameReady`, `GameUpdate`, `DownloadsDone`, `ProgramEnds`, `CpuAbove` usw., alle 15 s | `agent/auto.rs` (`Condition`, `tick`, `announce`) | „Sag Bescheid, wenn der Download fertig ist“ gibt es schon, für Steam, Epic und Browser-Downloads ohne einen einzigen KI-Aufruf. Neu ist nur, dass die Meldung zusätzlich ans Handy geht. |
| Zeitplan mit Nachhol-Fenster (`is_due`, `Clock`, `PROMPT_LATE_MINUTES = 120`) | `agent/auto.rs` | Vorbild und Hintergrund-Thread für „um HH:MM“. Der Companion hängt seine Warteschlange an denselben 15-s-Takt. |
| Lokales Aktionsprotokoll (erledigt, fehlgeschlagen, abgelehnt) | `storage/actions.rs`, `log_action` | Jede Aktion vom Handy wird dort mit Herkunft „Handy: Gerätename“ eingetragen. |
| Windows Credential Manager | `credentials.rs` (`set`, `get`, `delete`), Ziele `NOVA:ai:*` | Neue Ziele `NOVA:companion:*` für den PC-Schlüssel und die Freigabe-Schlüssel der Geräte. |
| App-Katalog und Spielebibliothek | `apps.rs` (`AppCatalog`), `agent/games.rs` (`library`) | Die Allowlist verweist auf diese IDs. Der Desktop zeigt zur Auswahl die vorhandene App-Liste. |
| Medienstatus (Titel, Künstler, spielt) | `media.rs` (`state`) | „Laufende Medien“ auf dem Start-Bildschirm. |
| Eine Berechtigung je Befehl, Test schlägt bei fehlender Freigabe fehl | `build.rs`, `capabilities/*.json`, `lib.rs` Test `every_command_is_declared_and_allowed_for_a_window` | Neue Companion-Befehle nur im Hauptfenster, der Test fängt Vergessenes ab. |
| SQLite mit transaktionalen Migrationen | `storage/migrations.rs` | Zwei neue Tabellen (Geräte, Aufträge). |
| Einstellungsseiten, Routinen-Seite | `src/features/settings`, `src/features/routines` | Neuer Abschnitt „Handy“. Geplante Handy-Aufträge erscheinen zusätzlich auf der Routinen-Seite. |

Was fehlte: ein WebSocket-Server, mDNS, Verschlüsselung auf beiden Seiten, QR-Erzeugung.

---

## 2. Verzeichnisstruktur (so gebaut)

```
packages/companion-protocol/        Gemeinsames TS-Paket (Desktop + Handy), ohne Build-Schritt
├─ src/messages.ts                  Typen aller Nachrichten
├─ src/parse.ts                     Prüfende Parser: unknown → Nachricht | Fehler (kein zod)
├─ src/crypto.ts                    X25519, HKDF, AES-256-GCM, Freigabe-Beweis über @noble
├─ src/client.ts                    Kopplung und verschlüsselte Sitzung (plattformfrei, WebSocket wird übergeben)
├─ src/state.ts                     Was das Handy zeigt, als reine Funktionen über PC-Nachrichten
├─ src/*.test.ts                    Vitest: Fixtures, Krypto, Client gegen nachgebauten PC, Zustand
├─ fixtures/*.json                  Nachrichten und Krypto-Vektoren, von Rust UND Vitest geprüft
└─ scripts/make-crypto-fixture.mjs  Erzeugt fixtures/crypto.json

mobile/                             Expo-App (eigenes package.json), siehe mobile/README.md
├─ app/(tabs)/…                     Start, Chat, Aufgaben, Freigaben
├─ app/approval/[id].tsx            Freigabe mit Fingerabdruck
├─ app/capture.tsx, app/pair.tsx    Schnell erfassen, Koppeln
├─ src/store.ts, storage.ts         Zustand, Verbindung, Keystore, Verlauf
├─ src/background.ts                Abruf bei geschlossener App
├─ src/dictation.ts, discovery.ts   Diktat, mDNS
└─ plugins/local-network.js         Erlaubt ws:// im Heimnetz (Inhalte sind E2E-verschlüsselt)

src-tauri/src/companion/            Rust-Modul
├─ mod.rs                           Einstellungen, Schlüssel, Geräte, Kopplung, Status, Tauri-Befehle
├─ protocol.rs                      serde-Typen, gleiche Fixtures wie TS
├─ crypto.rs                        RustCrypto: X25519, HKDF-SHA256, AES-256-GCM, Zähler-Nonces
├─ server.rs                        WebSocket im LAN, Handshake, Kopplung
├─ mdns.rs                          Windows DNS-SD (DnsServiceRegister)
├─ policy.rs                        Stufen Frei / Freigabe / Nie je Aktion (match ohne Platzhalter)
├─ queue.rs                         Fälligkeit „um HH:MM“ (reine Funktionen)
├─ tasks.rs                         Warteschlange, Ausführung über NOVA AI, Freigaben, Meldungen, KI-Prüfung
└─ tests.rs                         Ende-zu-Ende über echte Sockets (Feature companion-e2e)

src/features/companion/CompanionSettings.tsx   Einstellungen → Phone
```

Desktop und Handy binden das Paket per Pfad ein (keine npm-Workspaces). Expo erreicht es über `watchFolders` in `metro.config.js`.

Änderungen an bestehendem Code:
- `agent/mod.rs`: `Origin`/`Phone` am Lauf, eigene Handy-Sitzung (nach 30 Minuten ohne Auftrag neu), `run_phone`, `cancel_phone`, `ai_ready`; in `handle_call` die Handy-Stufen und Freigaben übers Handy; Werkzeug-Ausführung in `finish_call` ausgelagert; Handy-Aktionen im Protokoll als „Phone (Name)“.
- `agent/auto.rs`: `Watcher.notify_device`, Bedingung `AiCheck`, `finish_check`, Aufruf von `companion::tasks::tick` im 15-s-Takt.
- `agent/tools.rs`: `watch` kennt `ai_check` (nur für Aufträge vom Handy).
- `storage/migrations.rs`: Version 5 mit `companion_devices`, `companion_jobs`, `companion_notices`. Ein älteres NOVA verweigert danach die Datenbank, wie bei jeder Migration.
- `storage/mod.rs`: `nova.companion` ist nur von Rust schreibbar.
- `lib.rs`, `build.rs`, `capabilities/default.json`: zehn neue Befehle, nur im Hauptfenster.
- `RoutinesPage.tsx`: zeigt KI-Prüfungen. `SettingsPage.tsx`: Abschnitt „Phone“.
- `vite.config.ts`, `package.json`, `src/test/setup.ts`: Vitest findet die Paket-Tests, Typecheck und `check:rust` umfassen das Paket und den Ende-zu-Ende-Test.

---

## 3. Protokoll

### 3.1 Transport und Rahmen

- WebSocket. Das Handy ist Client (React Native hat WebSocket eingebaut), der PC ist Server im LAN.
- Vor dem Handshake: Text-Rahmen mit JSON. Danach nur Binär-Rahmen: `[8 Byte Zähler, big endian][AES-256-GCM-Chiffrat inkl. 16 Byte Tag]`. Kein Base64, also auch Screenshots ohne Aufblähen.
- Klartext jeder Nachricht ist JSON mit `type`, `id` (UUID), `ts` (ms seit Epoche). Felder in camelCase wie im Rest von NOVA.
- Größen: 64 KB je Nachricht, Ausnahme `task.result` mit Screenshot bis 4 MB. Größere Rahmen beenden die Verbindung.
- Version `v: 1` im Handshake. Unbekannte `type` werden mit `error` beantwortet und verworfen, nie ausgeführt.

### 3.2 Handshake (Klartext, aber gebunden)

| Nachricht | Richtung | Felder |
| --- | --- | --- |
| `hello` | Handy → PC | `v`, `deviceId`, `ephPub` (X25519, 32 B, base64url), `nonce` (16 B) |
| `welcome` | PC → Handy | `v`, `ephPub`, `nonce`, `pcId` |

Danach leiten beide Seiten die Sitzungsschlüssel ab (Abschnitt 4.3). Die erste verschlüsselte Nachricht des Handys ist `status.get`; kann der PC sie nicht entschlüsseln, schließt er die Verbindung ohne Begründung.

### 3.3 Kopplung

| Nachricht | Richtung | Felder |
| --- | --- | --- |
| QR-Inhalt | PC-Bildschirm → Handy | `nova-companion:1?pc=<pcId>&pk=<PC-Pub>&s=<Einmal-Geheimnis>&h=<IP:Port,…>&exp=<ts>` |
| `pair.request` | Handy → PC (mit Schlüssel aus dem Einmal-Geheimnis verschlüsselt) | `deviceName`, `platform` (`android`/`ios`), `devicePub`, `approvalKey` (32 B, siehe 4.4) |
| `pair.accepted` | PC → Handy | `deviceId` |
| `pair.rejected` | PC → Handy | `reason`: `expired` / `declined` / `used` |

### 3.4 Nachrichten nach dem Handshake

**Auftrag** (Handy → PC)

```json
{ "type": "task.create", "id": "…", "ts": 0,
  "text": "Wie lange geht der Steam-Download noch?",
  "voice": false,
  "wantScreenshot": true,
  "schedule": { "kind": "now" } }
```
`schedule`: `{ "kind": "now" }` · `{ "kind": "whenOnline" }` (wartet in der Outbox des Handys und geht raus, sobald der PC erreichbar ist) · `{ "kind": "at", "date": "2026-11-08", "time": "18:30" }` (liegt auf dem PC in `companion_jobs`).
Dazu `task.cancel { taskId }`.

**Ereignis** (PC → Handy), Abbild von `AgentEvent` ohne Kosten- und Token-Angaben

```json
{ "type": "task.event", "id": "…", "ts": 0, "taskId": "…",
  "event": { "kind": "status", "state": "analyzingScreen", "detail": "Screenshot" } }
```
`event.kind`: `accepted` (`state`: `queued` / `scheduled` / `running`, `runAt?`) · `status` · `text` (Teilantwort) · `toolStarted` (`title`, `tier`) · `toolFinished` (`ok`, `summary`).

**Ergebnis** (PC → Handy)

```json
{ "type": "task.result", "id": "…", "ts": 0, "taskId": "…",
  "ok": true, "text": "Noch etwa 12 Minuten, 8,4 von 31 GB.",
  "screenshot": { "mime": "image/jpeg", "width": 1568, "height": 882, "data": "<base64>" },
  "error": null }
```

**Freigabe-Anfrage** (PC → Handy)

```json
{ "type": "approval.request", "id": "…", "ts": 0,
  "requestId": "…", "taskId": "…",
  "title": "Steam beenden", "detail": "Ungespeicherte Daten gehen verloren.",
  "risk": "high", "expiresAt": 0 }
```
Dazu `approval.closed { requestId, outcome: "approved" | "declined" | "expired" | "cancelled" }`, damit alle Geräte die Karte schließen.

**Freigabe-Antwort** (Handy → PC)

```json
{ "type": "approval.answer", "id": "…", "ts": 0,
  "requestId": "…", "approved": true,
  "proof": "<base64url HMAC-SHA256(approvalKey, requestId ‖ 'approve' ‖ expiresAt)>" }
```
Ablehnen braucht keinen `proof`.

**Weitere**: `status.get` → `status { pcName, busy, aiReady, inGame, media: { title, artist, playing } | null, pendingApprovals, activeTasks }` · `notices.get` → `notices { items: [{ id, kind, text, ts }] }` (Meldungen, die beim Gerät noch nicht angekommen sind) · `error { code, message }` · `device.revoked` (letzte Nachricht vor dem Schließen).

Alle Nachrichten haben ein Fixture in `packages/companion-protocol/fixtures/`. Rust (`cargo test`) und Vitest lesen dieselben Dateien, gültige müssen sich in beiden Sprachen gleich parsen lassen, ungültige müssen in beiden abgelehnt werden.

---

## 4. Sicherheitsmodell

### 4.1 Was geschützt wird, gegen wen

| Bedrohung | Gegenmaßnahme |
| --- | --- |
| Mitlesen oder Verändern im WLAN | Ende-zu-Ende-Verschlüsselung jeder Nachricht, Schlüssel nur auf PC und gekoppelten Geräten |
| Fremdes Gerät im WLAN verbindet sich | Nur gekoppelte `deviceId`s mit bekanntem öffentlichem Schlüssel kommen durch den Handshake; Handshake-Rate begrenzt |
| Wiedereinspielen alter Nachrichten | Streng steigender Zähler je Richtung und Sitzung, Freigaben einmalig per `requestId` mit Ablaufzeit |
| Abfotografierter QR-Code | Geheimnis gilt 120 s und einmal, Kopplung braucht zusätzlich einen Klick am PC |
| Entsperrtes, gestohlenes Handy | Alles außer „Frei“ braucht Biometrie; Widerruf am PC schneidet sofort ab |
| Prompt-Injection (Webseite oder Fenster sagt NOVA, was zu tun ist) | Die Stufen gelten pro Werkzeugaufruf im Rust-Code, nicht per Prompt; die vorhandene `read_outside`-Regel bleibt |
| Manipulierte Handy-App | Der PC prüft alles selbst; die Stufen-Tabelle am Handy dient nur der Anzeige |

### 4.2 Kopplung
- PC erzeugt einmalig ein X25519-Schlüsselpaar. Privater Schlüssel im Credential Manager unter `NOVA:companion:key`.
- „Gerät koppeln“ erzeugt ein 32-Byte-Einmal-Geheimnis, 120 s gültig, nur im Speicher, nur im Desktop-Fenster als QR sichtbar.
- Das Handy erzeugt sein eigenes X25519-Paar und einen Freigabe-Schlüssel, legt beides in `expo-secure-store` (Android Keystore) ab und schickt `pair.request`, verschlüsselt mit `HKDF(ECDH(Handy-Eph, PC-Pub) ‖ Einmal-Geheimnis)`.
- Der PC zeigt „‚Pixel 9‘ koppeln?“ mit Koppeln und Abbrechen. Erst dann wird das Gerät gespeichert: öffentlicher Schlüssel in `companion_devices`, Freigabe-Schlüssel im Credential Manager unter `NOVA:companion:device:<id>`.

### 4.3 Sitzungen
- Schlüssel je Verbindung: `HKDF-SHA256(ECDH(statisch, statisch) ‖ ECDH(eph, eph) ‖ ECDH(Handy-statisch, PC-eph) ‖ ECDH(Handy-eph, PC-statisch), salt = nonce_Handy ‖ nonce_PC, info = "nova-companion v1")` → zwei AES-256-GCM-Schlüssel, einer je Richtung. Das ist das Muster von Noise KK; die ephemeren Schlüssel geben Vorwärtssicherheit.
- Nonce = 4 Null-Bytes + 8-Byte-Zähler. Der Zähler beginnt je Sitzung bei 0 und darf nie wiederholt werden; eine Lücke oder Rückwärtsschritt beendet die Verbindung.
- Testvektoren aus RFC 7748 (X25519), RFC 5869 (HKDF) und NIST (AES-GCM) laufen in Rust und TS. Außerdem ein Test, der eine TS-verschlüsselte Nachricht in Rust entschlüsselt (gemeinsames Fixture).

### 4.4 Freigaben
- Der Freigabe-Schlüssel liegt am Handy in `expo-secure-store` mit `requireAuthentication: true`. Android gibt ihn nur nach Fingerabdruck oder Gesicht heraus. Damit ist die Freigabe kryptographisch an die Biometrie gebunden, nicht nur an einen UI-Dialog.
- `proof = HMAC-SHA256(approvalKey, requestId ‖ "approve" ‖ expiresAt)`. Der PC prüft mit seiner Kopie in konstanter Zeit.
- Ablauf: 120 s nach Anfrage. Spätere Antworten werden als `expired` verworfen. Wird der Auftrag abgebrochen oder das Gerät widerrufen, gehen offene Freigaben auf `cancelled`.
- Der Auto-Modus des Desktops gilt für Handy-Aufträge nicht.
- Löst das Handy eine Aktion mit Freigabe aus, zeigt der PC eine Windows-Benachrichtigung („Phone request: …“). Fragen und Status bleiben still.

### 4.5 Stufen für Aufträge vom Handy

Entschieden wird in `companion/policy.rs` nach `tools::prepare`, also mit geprüften Argumenten. Ein Werkzeug, das in der Tabelle fehlt, ist „Nie“. Ein Test listet `tools::definitions()` auf und schlägt fehl, sobald ein Werkzeug ohne Eintrag dazukommt.

| Stufe | Werkzeuge |
| --- | --- |
| **Frei** | `media_control`, `timer`, `open_website`, `search_files`, `list_folder`, `system_info`, `look_at_screen`, `list_tasks`, `now_playing`, `task_manager`, `game_time`, `recent_load`, `installed_programs`, `list_windows`, `weather`, `find_junk`, `pc_check`, `game_settings` (nur lesen), `internet_speed`, `read_webpage`, Websuche, `youtube` mit `about`/`search`/`channel`, `watch` ohne Routine; `open_app` und `start_game` **nur** mit Ziel in der Allowlist |
| **Mit Freigabe** | `open_app`/`start_game` außerhalb der Allowlist, `open_file`, `show_in_folder`, `search_web_in_browser`, `create_document`, `create_folder`, `move_item`, `rename_item`, `delete_item`, `add_task`, `complete_task`, `add_note`, `add_project`, `search_on_spotify`, `spotify_play`, `spotify_library`, `youtube` mit `play`, `app_volume`, `audio_output`, `clip`, `send_clip`, `end_process`, `window_action`, `read_window`, `use_element`, `send_input`, `change_game_settings`, `virus_scan`, `clean_up`, `uninstall_program`, `power`, `clipboard`, `tidy_folder`, `read_file`, `browser_read`, `memory` |
| **Nie vom Handy** | `routine` (dauerhafte Automatik = Einstellung), `watch` mit Routine, `spotify_control` (ändert die Bibliothek im Konto), `browser_use` (Kaufen, Anmelden und Absenden lassen sich im Code nicht sicher ausschließen); außerdem alle NOVA-Einstellungen, Schlüssel und Tauri-Befehle, die nicht über Werkzeuge laufen, da der Companion nur `task.create` kennt |

Die Ablehnung einer „Nie“-Aktion geht als Werkzeugfehler zurück an das Modell („Vom Handy aus nicht erlaubt, das geht nur am PC“), damit NOVA das in der Antwort sagt.

### 4.6 Daten
- Screenshots: nur im Speicher, verschlüsselt ans Handy, danach verworfen. Ein Schalter in den Desktop-Einstellungen („Keep phone screenshots“, aus) speichert sie in `%APPDATA%\dev.nova.commandcenter\companion\shots`; was älter als 7 Tage ist, wird beim Start und stündlich gelöscht.
- Protokoll: Aufträge (`companion_jobs`) und Freigaben (`actions` mit Herkunft) bleiben lokal, sichtbar und löschbar in den Desktop-Einstellungen. Der Companion meldet nichts an die Telemetrie.
- Benachrichtigungen sind lokal am Handy, kein Push-Dienst. Texte sind fest: „Neue Freigabe“, „Auftrag fertig“, „NOVA meldet sich“. Details holt die App über die verschlüsselte Verbindung.
- Widerruf: Gerätezeile und Credential-Eintrag löschen, offene Verbindung sofort schließen (`device.revoked`), wartende Aufträge des Geräts abbrechen.

---

## 5. Meilensteine

Nach jedem Meilenstein: `npm run typecheck`, `npm test`, `npm run check:rust` (enthält `cargo check` und `cargo test`), dazu im Handy `npx tsc --noEmit` und `npx jest`. Commits nur auf deine Anforderung.

**C0 — Protokoll und Stufen (nur Code und Tests, keine Verbindung)**
- `packages/companion-protocol`: Typen, Parser, Fixtures.
- `companion/protocol.rs`, `companion/policy.rs`, `companion/queue.rs` (Fälligkeit als reine Funktion).
- Tests: Fixtures in TS und Rust gleich; jedes Werkzeug hat eine Stufe; Allowlist-Fall für `open_app`; Fälligkeit „um HH:MM“ inklusive Nachhol-Fenster, Tageswechsel, PC war aus.

**C1 — Kopplung und Verbindung am PC**
- `crypto.rs` (RustCrypto) mit Testvektoren, `pairing.rs`, `server.rs` (WebSocket, mDNS `_nova-companion._tcp`), Tabellen, Befehle.
- Desktop: Abschnitt „Handy“ mit QR, Bestätigung, Geräteliste, Widerruf, Allowlist.
- Test: ein Rust-Testclient koppelt, verbindet, wird widerrufen und fliegt raus; abgelaufenes und doppelt benutztes QR-Geheimnis wird abgelehnt.

**C2 — Handy-Grundgerüst**
- Expo-App, vier Tabs, Glas-Theme, QR-Scan, Kopplung, Verbindung mit Reconnect, Start-Bildschirm mit `status`.
- Test: Client-Handshake gegen das gemeinsame Krypto-Fixture.

**C3 — Chat-Aufträge**
- Agenten-Anbindung mit Herkunft und eigener Handy-Sitzung, Stufen in `handle_call`, Ereignisse und Ergebnis mit Screenshot.
- Handy: Chat mit Verlauf, großer Mikrofon-Button (Spracherkennung des Handys), Antwort mit Bild.
- Test: Auftrag mit „Nie“-Werkzeug wird abgelehnt und protokolliert; Auftrag läuft mit dem vorhandenen Mock (`scripts/mock-anthropic.mjs`) durch.

**C4 — Freigaben**
- Freigabe-Anfrage, Biometrie-gebundener Beweis, Ablauf, `approval.closed`, Freigabe-Bildschirm und Liste.
- Tests: falscher Beweis, abgelaufene Anfrage, wiederverwendete `requestId`, Ablehnen ohne Beweis.

**C5 — Warteschlange, Zeitplan, Benachrichtigungen**
- Outbox „sobald PC an“, PC-Warteschlange „um HH:MM“ im vorhandenen 15-s-Takt, Aufgaben-Tab zeigt Wartendes.
- Wächter vom Handy melden an das Gerät (die Meldung wartet auf dem PC, bis das Handy sie abholt). Für Fälle ohne festen Wächter eine neue Bedingung `aiCheck { question, everyMinutes, maxCalls }`, Standard alle 10 Minuten und höchstens 12 Aufrufe, danach „Ich habe aufgehört zu prüfen“; das Monatslimit gilt zusätzlich.
- Lokale Benachrichtigungen bei „Auftrag fertig“, „Neue Freigabe“ und Wächter-Meldungen. Solange die App zu ist, holt ein Hintergrund-Task (Android WorkManager, frühestens alle 15 Minuten) wartende Meldungen ab.

**C6 — Feinschliff und Doku**
- Schnell-erfassen-Bildschirm, Barrierefreiheit (Beschriftungen, Schriftgröße), leere Zustände, Fehlertexte.
- README (Sicherheit und Netzwerkverbindungen), CHANGELOG, ROADMAP, Android-Build-Anleitung.

---

## 6. Neue Abhängigkeiten (Begründung)

| Wo | Paket | Warum, und was ich nicht nehme |
| --- | --- | --- |
| Rust | `tungstenite` (ohne TLS-Feature) | WebSocket-Rahmen, Maskierung, Fragmentierung nach RFC 6455 sind fehleranfällig. Synchron, kein Tokio-Netz nötig, TLS unnötig wegen E2E. Später für den Relay auch als Client nutzbar. Kein `tokio-tungstenite`, kein `axum`. |
| Rust | `qrcodegen` | Kleine, abhängigkeitsfreie Referenz-Implementierung, erzeugt das QR als SVG in Rust. |
| Rust | `x25519-dalek`, `aes-gcm`, `hkdf`, `hmac` (RustCrypto, passend zum vorhandenen `sha2`) | Geprüfte Implementierungen statt eigener CNG-FFI; dieselben Algorithmen wie `@noble` am Handy. |
| Rust | nur neue `windows`-Features: `Win32_NetworkManagement_Dns` (mDNS-Anmeldung über `DnsServiceRegister`) | Keine mDNS-Crate. |
| Handy | `expo`, `expo-router`, `react-native` | Gesetzt durch die Entscheidung für Expo. |
| Handy | `expo-camera` | QR scannen. |
| Handy | `expo-secure-store` | Schlüssel im Android Keystore, Biometrie-Bindung (4.4). |
| Handy | `expo-local-authentication` | Biometrie-Abfrage und Prüfung, ob sie eingerichtet ist. |
| Handy | `expo-notifications` | Lokale Benachrichtigungen (kein Push-Dienst). |
| Handy | `expo-background-task` | Holt Meldungen ab, während die App zu ist; ohne ihn kämen sie erst beim Öffnen. |
| Handy | `expo-speech-recognition` | Großer Mikrofon-Button mit der Spracherkennung des Handys. Ohne ihn bliebe nur das Diktat der Tastatur. |
| Handy | `react-native-zeroconf` | mDNS-Suche; Expo hat nichts Eigenes. |
| Handy + Paket | `@noble/curves`, `@noble/hashes`, `@noble/ciphers` | Expo bietet weder ECDH noch AES-GCM. Reines JS, geprüft (Audits), ohne weitere Abhängigkeiten. |
| Handy | `zustand` | Wie am Desktop. Kein react-query: die Daten kommen über den Socket. |
| Handy | `react-native-svg` | Icons und der Hintergrund; Expo SDK 58 bringt keine Icon-Bibliothek mehr mit. |
| Handy | `expo-crypto`, `expo-device`, `expo-file-system`, `expo-task-manager` | Zufallszahlen für Schlüssel (Hermes hat kein `crypto`), Gerätename, Verlauf als Datei, Hintergrund-Task. Alle von Expo selbst. |
| Rust (nur Tests) | Feature `tauri/test` hinter `companion-e2e` | Mock-Runtime für den Ende-zu-Ende-Test; keine neue Crate. |

Bewusst weggelassen: Blur-Bibliothek (Glas auf Android über halbtransparente Flächen und Ränder), zod, Navigation-Bibliotheken neben expo-router, eine Datenbank am Handy (Verlauf in `expo-secure-store`/Dateisystem reicht für das MVP).

---

## 7. UI

- Dunkel, Glasflächen (halbtransparent, heller Rand oben), Akzente Violett `#8B5CF6` und Cyan `#22D3EE`, Icon aus `assets/brand/nova-icon.svg`.
- **Start**: PC-Status (verbunden, beschäftigt, im Spiel), offene Freigabe als Karte oben, laufende Medien, Knopf „Schnell erfassen“.
- **Chat**: Verlauf mit Antworten und Screenshots, Werkzeugschritte als kleine Zeilen, großer Mikrofon-Button unten mittig.
- **Freigabe**: Titel, Details, Risiko, Ablaufzeit, „Mit Fingerabdruck freigeben“, „Ablehnen“.
- **Schnell erfassen**: ein Feld, Mikrofon, Wahl „Jetzt“, „Sobald der PC an ist“, „Um …“.
- Texte: Deutsch, Satzschreibung, Du-Form, keine Ausrufezeichen. Beispiele: „Dein PC ist nicht erreichbar“, „Freigabe abgelaufen“, „Auftrag wartet, bis dein PC an ist“.

---

## 8. Entscheidungen (geklärt am 2026-11-08)

1. Verbindung: Der PC lauscht im LAN (Firewall-Regel nur für private Netzwerke). Der Server ist so gekapselt, dass mit dem Relay später nur die Richtung wechselt.
2. Benachrichtigungen: nur lokal am Handy, kein Firebase und kein Expo-Push-Dienst.
3. Eigene Handy-Sitzung; immer nur ein Lauf gleichzeitig.
4. Frei sind zusätzlich `media_control`, `timer` und `open_website`.
5. Der Auto-Modus gilt nicht für Handy-Aufträge.
6. Windows-Benachrichtigung am PC bei Aktionen mit Freigabe.
7. Krypto am PC über RustCrypto-Crates.
8. Build: Auf diesem PC ist kein Android-SDK installiert. Der App-Code wird mit Typecheck und Tests gebaut; der APK-Build steht in `mobile/README.md`.
9. Aufbewahrte Screenshots: 7 Tage.
10. KI-Prüfung: alle 10 Minuten, höchstens 12 Aufrufe.
11. Keine Telemetrie für den Companion.
12. Desktop-Abschnitt auf Englisch, Handy-App auf Deutsch.
13. „Um HH:MM“ bei ausgeschaltetem PC: bis 2 Stunden nachholen, sonst verwerfen und melden.
14. `mobile/` und `packages/companion-protocol/` in diesem Repository.
