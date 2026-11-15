# Nova Island — Plan und Umsetzung (Version 1.12)

Stand: 2026-11-09 · Basis: NOVA 1.11.2

Nova Island ist eine kleine, dynamische Fläche oben mittig auf dem Bildschirm (Vorbild: Apples Dynamic Island). Sie zeigt Musik, Benachrichtigungen und Anrufe vom Handy, den Zustand von NOVA AI und auf Wunsch die Auslastung des PCs. Sie ist eine Erweiterung des bestehenden NOVA, kein eigenes Programm.

---

## 1. Was es schon gibt und wiederverwendet wird

| Bestand | Wo | Wie die Island es nutzt |
| --- | --- | --- |
| Zweites/drittes Fenster ohne Rahmen, transparent, immer oben, platziert aus Arbeitsbereich und Skalierung jedes Monitors | `assistant.rs` (`create_dot`, `screens`, `Screen`, `Rect`, `fullscreen_in_front`) | Die Island ist ein weiteres Fenster `island` mit eigener Seite `island.html`. Rust platziert sie oben mittig auf dem gewählten Monitor. |
| NOVA-Dot (Klick = Panel, Rechtsklick = Menü, Aktivitätsanzeige) | `assistant.rs`, `NovaDot.tsx`, `PanelApp.tsx` (`assistant://activity`) | „Island Only“: der Dot-Fensterbau wird übersprungen, die Island zeigt einen eigenen Mini-Dot mit denselben Befehlen (`assistant_toggle`, `assistant_dot_menu`). Das Panel öffnet sich dann unter der Island. |
| Windows-Mediensitzung (Spotify, Browser, Media Player), Cover, Steuerung, Lyrics (LRCLIB) | `media.rs`, `features/media/api.ts` | Music Island. Kein Spotify-Konto, keine Zugangsdaten. |
| Core Audio (Standard-Ausgabegerät) | `media.rs` (`endpoint_volume`) | Echter Pegel des Ausgabegeräts (`IAudioMeterInformation`) für die Visualisierung, nur solange Musik läuft und die Island sichtbar ist. |
| Systemwerte CPU/GPU/RAM/Netz/Temperaturen (nur wenn gemeldet) | `system.rs`, `system_snapshot`, `system_temperatures` | System Island. Abfrage nur, solange das Modul an ist. |
| NOVA AI (eine Logik in Rust, Panel als Oberfläche) | `agent/`, `PanelApp.tsx` | Die Island sendet keine eigenen KI-Anfragen. Sie öffnet das Panel, startet die Spracheingabe über den vorhandenen Weckweg (`assistant::wake`) und zeigt, was das Panel ihr meldet (Zustand, kurze Antwort, laufender Schritt). |
| Handy-Verbindung (E2E-verschlüsselt, Kopplung, Geräte) | `companion/`, `packages/companion-protocol`, `mobile/` | Neue Nachrichten `phone.notification`, `phone.call` (Handy → PC) und `call.action` (PC → Handy). |
| Einstellungen in SQLite (`kv`), Seiten unter Einstellungen | `storage`, `features/settings` | Eigener Schlüssel `nova.island`, eigener Abschnitt „Nova Island“. |
| Eine Berechtigung je Befehl | `build.rs`, `capabilities/*.json`, Test in `lib.rs` | Eigene Capability `island.json` nur mit dem, was die Island braucht. |

## 2. Neue Dateien

```
island.html                                  Einstieg des Island-Fensters
src/features/island/
├─ main.tsx                                  Seite des Island-Fensters (ohne Tailwind, ohne Motion-Bibliothek)
├─ IslandApp.tsx                             Zustand, Ereignisse, Größe, Auto-Minimieren
├─ priority.ts                               Welche (höchstens zwei) Inhalte sichtbar sind; reine Funktionen
├─ modules.tsx                               Music, Notification, Call, System, AI (kompakt + erweitert)
├─ island.css                                Designs Black / White / Glass, Animationen
├─ api.ts, types.ts                          Befehle und Typen (gespiegelt aus island.rs)
├─ IslandSettings.tsx                        Einstellungen → Nova Island
└─ priority.test.ts                          Tests der Priorisierung
src-tauri/src/island.rs                      Fenster, Platzierung, Einstellungen, Pegel, Handy-Ereignisse
src-tauri/src/companion/network.rs           Netzwerk-Check (öffentlich/privat, Firewall-Regel), Freigabe per UAC
src-tauri/capabilities/island.json           Rechte des Island-Fensters
mobile/modules/nova-bridge/                  Android-Modul: Benachrichtigungszugriff, Anrufe, APK-Installation
mobile/src/phone.ts                          Weiterleitung von Benachrichtigungen und Anrufen
mobile/src/updates.ts                        App-Update von GitHub
mobile/app/settings.tsx                      Einstellungen der App
scripts/companion-release.mjs                Legt eine gebaute APK mit companion.json in releases/
```

## 3. Island: Verhalten

- **Form**: Kompakt eine Pille, die für Inhalte wächst und sich auf Klick öffnet (größte Form 400 × 312 px mit Songtext). Das Fenster hat eine feste Größe mit Platz für die größte Pille und lässt Klicks überall durch, außer über der Pille (ein Zeiger-Wächter in Rust schaltet das um). So wird das Fenster während einer Animation nie bewegt oder skaliert.
- **Höchstens zwei Inhalte**: ein Hauptinhalt links/mittig, ein Nebenindikator rechts. Rangfolge ab Werk: Anruf (exklusiv) › NOVA AI aktiv › Benachrichtigung (8 s) › Musik › System; im Island Studio frei sortierbar. Weitere Benachrichtigungen warten in einer kurzen Schlange.
- **Designs**: Schwarz, Weiß (dunkle Schrift), Glas (halbtransparent, Akzentlicht) und ein eigenes Material (Abschnitt 6).
- **Modi**: „Dot + Island“ (Dot bleibt) und „Island Only“ (Dot in der Island, abschaltbar).
- **Vollbild**: versteckt sich bei Spielen im Vollbild (einstellbar); bei einem eingehenden Anruf zeigt sie sich trotzdem.
- **Mehrere Monitore**: Hauptbildschirm oder ein bestimmter Monitor; Ausrichtung links/mittig/rechts; Skalierung pro Monitor (DPI).
- **Leistung**: keine Dauer-Animation im Ruhezustand. Musik-Pegel nur bei laufender Musik und sichtbarer Island, System-Abfrage nur mit eingeschaltetem Modul.

## 4. Handy → PC

| Nachricht | Richtung | Felder |
| --- | --- | --- |
| `phone.notification` | Handy → PC | `notifId`, `app` (Paket), `appName`, `title`, `text`, `icon` (PNG, base64, ≤ 12 KB, optional), `posted` |
| `phone.call` | Handy → PC | `callId`, `state` (`ringing` / `active` / `ended`), `name`, `number`, `photo` (optional), `canAnswer`, `canDecline` |
| `call.action` | PC → Handy | `callId`, `action` (`accept` / `decline`) |

- Benachrichtigungen kommen über Androids Benachrichtigungszugriff (NotificationListenerService), für jede App, also auch WhatsApp. Der Nutzer erteilt den Zugriff selbst in den Android-Einstellungen.
- Anrufe erkennt das Handy an der Anruf-Benachrichtigung der Telefon-App (`CATEGORY_CALL`). Annehmen/Ablehnen werden nur angeboten, wenn die Telefon-App die Aktionen bereitstellt (Android 12+ `CallStyle`: `EXTRA_ANSWER_INTENT`, `EXTRA_DECLINE_INTENT`) oder die App die Berechtigung `ANSWER_PHONE_CALLS` hat (`TelecomManager`). Sonst zeigt die Island den Anruf nur an.
- Datenschutz: am PC „Vorschauen ausblenden“ (Rust entfernt Text, bevor er die Webview erreicht) und „Nummer anzeigen“; am Handy „Nur App-Namen senden“ und Weiterleitung ganz aus. Nichts davon wird gespeichert.

## 5. Weitere Punkte dieser Version

- **Verbindung ohne WLAN**: Ursache bei per Kabel verbundenen PCs ist meist das als „Öffentlich“ eingestufte Ethernet-Netz, in dem die Windows-Firewall eingehende Verbindungen sperrt. Die Seite „Phone“ prüft das jetzt und richtet auf Klick (Windows fragt nach Administratorrechten) eine Regel nur für NOVA, nur TCP auf NOVAs Port und nur aus dem lokalen Subnetz ein. Zusätzlich: USB-Tethering als Weg ganz ohne WLAN und manuelle PC-Adressen in der App.
- **App-Updates von GitHub**: `releases/companion.json` (Version, versionCode, SHA-256, Größe) neben `releases/NOVA-Companion.apk`. Die App prüft beim Start, lädt die APK, prüft die SHA-256 und übergibt sie Androids Installer (Android prüft zusätzlich die Signatur).
- **Neues Design** der Handy-App und der Seite „Phone“.

## 6. Island Studio (Einstellungen → Nova Island)

Der Einstellungs-Tab ist ein Designer: oben eine Bühne mit der echten Island, darunter alles zum Anfassen. Jede Änderung wirkt sofort und wird 300 ms später gespeichert.

```
src/features/island/
├─ IslandView.tsx            Reine Darstellung: Props → Pille. Fenster und Bühne zeichnen dasselbe.
├─ IslandApp.tsx             Nur noch das Fenster: Ereignisse, Größe, Hover, Auto-Minimieren, Vorschau-Szenen
├─ data.ts                   IslandData (ein Moment), IslandActions (was Knöpfe tun), layoutOf()
├─ look.ts                   Prefs → CSS-Variablen auf .island-stage; Bewegungsstile und Tempo
├─ scenes.ts                 Die neun Demo-Szenen (auch für island_preview)
├─ presets.ts                Kuratierte Vorlagen, Export/Import-Code „NI1.…“
├─ default-prefs.json        Defaults, gegen die Rust und TS testen
├─ island.css                Die Pille (geteilt); island-window.css nur für das Island-Fenster
└─ studio/
   ├─ IslandStudio.tsx       Die Seite
   ├─ Stage.tsx              Bühne: Ziehen entlang des Rands, Punkt hinein/heraus, Szenen, Auto-Demo
   ├─ LookPanels.tsx         Form, Material, Bewegung, Verhalten (mit Monitor-Karte)
   ├─ ContentPanels.tsx      Seitenslots, Module und Priorität
   ├─ Presets.tsx            Vorlagen, eigene Vorlagen, Import
   ├─ useStudioPrefs.ts      Arbeitskopie, entprelltes Speichern, Strg+Z / Strg+Y
   ├─ history.ts, position.ts  Verlauf und Einrast-Geometrie als reine Funktionen
   └─ MiniPill.tsx           Ein Look in klein, vom echten CSS gezeichnet
src-tauri/src/island/prefs.rs   Typen, Grenzen, Migration, Tests
```

- **Datenmodell** (`IslandPrefs`): `look { scale, radius, closedHeight, background, opacity, frost, border, shadow, accent }`, `motion { style, speed }`, `slots { music | call | ai | notification | system: { left, right } }`, `order`, `callsFirst`, `offset`, `presets`; dazu `theme: custom`. Nur ganze Zahlen, damit Rust exakt klemmt und vergleicht.
- **Migration**: `size` (small / medium / large) wird `look.scale` 88 / 100 / 114. Unbekannte Felder werden ignoriert; ein unlesbarer Wert fällt allein auf seinen Standard zurück.
- **Fenster**: Platz für die größte Pille (460 × 320) bei 130 %. Look-Änderungen fassen das Fenster nicht an. `offset` verschiebt es entlang des Rands, begrenzt auf den Arbeitsbereich des Monitors.
- **`island_preview(scene | null)`**: „Auch auf dem Desktop zeigen“. Rust reicht nur den Szenennamen an das Island-Fenster; die Seite beendet die Szene nach 10 s selbst, und ein echter klingelnder Anruf beendet sie sofort. Knöpfe einer Szene tun nichts (kein Pausieren echter Musik, kein Annehmen).
- **Milchglas statt Unschärfe**: Windows kann hinter einem runden, transparenten Fenster nicht weichzeichnen. `frost` ist deshalb ein matter Schleier mit Körnung, der auf der Bühne und auf dem Desktop gleich aussieht; `backdrop-filter` ist entfernt, weil er nur auf der Bühne gewirkt hätte.
- **Seitenslots**: Cover, Visualizer, App-Icon, Uhrzeit, Restzeit, Fortschrittsring, KI-Status, nichts. Was in einem Zustand keinen Sinn ergibt (Restzeit beim System, Fortschritt beim Anruf), wird dort nicht angeboten und bleibt leer. Trägt die Island den Punkt, bleibt der KI-Status-Slot leer.
- **Punkt-Fenster**: Sitzt der Punkt in der Island („In der Island“) oder ist er aus, gibt es `dot.html` gar nicht (`island::replaces_dot`, das spart einen WebView2-Renderer). Steht er „Neben der Island“, behält er sein eigenes Fenster: Das ist die Wahl des Nutzers und bleibt so, auch wenn `dotInIsland` aus früheren Versionen noch auf an steht.
- **Getrenntes Handy**: Schließt die letzte Verbindung eines Handys, räumt die Island dessen Anrufe ab (`island::phone_gone`), statt für ein Handy zu klingeln, das nicht mehr antworten kann. Beim Wiederverbinden meldet das Handy seinen Anrufstand neu.
- **Tastatur**: Griff-Knopf für die Position (Leertaste, Pfeile, Esc), Segment-Schalter für die Anker; Slots über „erst Seite, dann Inhalt“; Reihenfolge mit Leertaste und Pfeilen; Ansagen über `aria-live`.

## 7. Was offen bleibt

Siehe Abschlussbericht und CHANGELOG. Die echte Island im Fenster (Ziehen des Versatzes über mehrere Monitore, `island_preview`) ist erst nach der lokalen Installation geprüft; in der Web-Vorschau läuft nur die Bühne.
