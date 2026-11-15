# NOVA Companion (Handy)

Die Handy-App zu NOVA: ein Auftragskanal zu NOVA AI auf deinem PC. Die KI, ihre Schlüssel und das Protokoll bleiben auf dem PC; das Handy schickt Aufträge, zeigt Antworten und gibt Änderungen mit Fingerabdruck frei. Ab Version 1.1 (NOVA 1.12) leitet es außerdem Benachrichtigungen und Anrufe an Nova Island weiter und aktualisiert sich selbst von GitHub. Plan und Sicherheitsmodell: [docs/mobile/PLAN.md](../docs/mobile/PLAN.md), Nova Island: [docs/island/PLAN.md](../docs/island/PLAN.md).

## Aufbau

```
app/_layout.tsx            Schrift laden, Store starten, Stack, Toasts
app/(tabs)/_layout.tsx     Schwebende Tab-Leiste mit Blur, federnder Pille und Haptik
app/(tabs)/index.tsx       Start: Verbindung (Latenz, Schloss), Freigabe, Update, Medien, Schnellaktionen, Heute
app/(tabs)/chat.tsx        Chat: Antwort im Fluss, Diktat, Screenshots, Kopieren per Long-Press
app/(tabs)/tasks.tsx       Aufträge: wischen zum Abbrechen oder Ausblenden, mit „Rückgängig“
app/(tabs)/approvals.tsx   Offene Freigaben
app/approval/[id].tsx      Freigabe: Gefahrenstufe, Ablauf, Fingerabdruck, Ablehnen
app/capture.tsx            Schnell erfassen: jetzt, sobald der PC an ist, um HH:MM
app/pair.tsx               Onboarding in drei Schritten: Willkommen, Verbinden, Berechtigungen
app/settings.tsx           Verbindung, Weiterleitung (je App), Anrufe, Datenschutz, Darstellung, Updates, Über
src/store.ts               Zustand und die eine Verbindung zum PC (zustand)
src/logic.ts               Die Regeln der App als reine Funktionen (getestet)
src/phone.ts               Benachrichtigungen und Anrufe an den PC, Anruf-Aktionen vom PC
src/updates.ts             Neue App-Version von GitHub laden (mit Fortschritt), prüfen, installieren
src/storage.ts             Schlüssel im Keystore, Verlauf als Datei
src/background.ts          Abruf alle ~15 Minuten bei geschlossener App, über den Store
src/notify.ts              Eigene Benachrichtigungen: Kanal, Antippen
src/permissions.ts         Was Android erlaubt hat, und wie danach gefragt wird
src/hints.tsx              Play Protect, „Eingeschränkte Einstellung“, Verbinden ohne WLAN
src/theme.ts               Design-Tokens: Farben (dunkel und hell), Abstände, Radien, Schrift, Elevation, Motion
src/ui/                    Design-System: Button, Card, ListRow, Switch, Sheet, Toast, EmptyState, Skeleton, Badge, Avatar, SegmentedControl, TextField …
modules/nova-bridge/       Eigenes Android-Modul (Kotlin): Benachrichtigungszugriff, Anrufe, APK-Prüfsumme und -Installation
scripts/apk-info.mjs       Version, Signatur und Berechtigungen einer APK lesen, zwei APKs vergleichen
../packages/companion-protocol   Protokoll, Verschlüsselung, Client, Zustand, App-Regeln (mit Desktop geteilt, getestet mit Vitest)
```

Was beim Audit für 1.2 gefunden und behoben wurde, steht in [docs/mobile/AUDIT-1.12.md](../docs/mobile/AUDIT-1.12.md); Berechtigungen, Signatur und Play Protect in Abschnitt 11 von [docs/mobile/PLAN.md](../docs/mobile/PLAN.md).

## Bauen

Die App braucht einen eigenen Build (Spracherkennung, mDNS, Hintergrund-Abruf und das Modul `nova-bridge` laufen nicht in Expo Go). Expo bindet `modules/nova-bridge` beim Build automatisch ein.

```bash
npm install
```

```bash
npm run typecheck
```

```bash
npm test
```

`npm test` prüft die Regeln der App (`src/logic.test.ts`) und den Store mit seiner Verbindung gegen Stellvertreter für das Handy (`src/store.test.ts`). Neue Abhängigkeiten immer mit `npx expo install <paket>`, damit die Version zum Expo-SDK passt.

Android, lokal (Android Studio mit SDK und ein Gerät mit USB-Debugging oder ein Emulator):

```bash
npx expo run:android
```

Installierbare APK ohne Android Studio über EAS (Expo-Konto nötig, EAS behält den Signaturschlüssel, damit Updates sich installieren lassen):

```bash
npx eas build -p android --profile preview
```

Die Tests für Protokoll, Verschlüsselung, Client, Zustand und die App-Regeln (Update-Manifest, PC-Adressen) laufen im Hauptprojekt: `npm test` im Repository-Wurzelverzeichnis.

## Eine neue App-Version veröffentlichen

1. In `app.json` `version` erhöhen und `android.versionCode` um eins erhöhen (Android installiert ein Update nur mit höherem versionCode). `package.json` und `modules/nova-bridge/android/build.gradle` nachziehen.
2. APK bauen (siehe oben).
3. Prüfen, was gebaut wurde: Version, Berechtigungen, und dass die APK mit demselben Schlüssel signiert ist wie die veröffentlichte. Sonst lehnt jedes Handy das Update ab:

   ```bash
   npm run apk:info -- path/to/app.apk ../releases/NOVA-Companion.apk
   ```

4. Im Repository-Wurzelverzeichnis:

   ```bash
   npm run release:companion -- path/to/app.apk --notes "Was neu ist"
   ```

   Das legt `releases/NOVA-Companion.apk` und `releases/companion.json` (Version, versionCode, SHA-256, Größe) ab. Erst nach Commit und Push sehen Handys das Update; die App prüft beim Start und unter Einstellungen → App.

Die App lädt nur eine APK aus demselben GitHub-Repository über HTTPS, prüft ihre SHA-256 gegen `companion.json` und übergibt sie Androids Installer. Android fragt einmal, ob NOVA Companion Apps installieren darf, und installiert nur eine APK mit demselben Signaturschlüssel. Vor dem Installer zeigt die App, was Google Play Protect melden kann und wie man weiterkommt. Version 1.0 hat den Updater noch nicht: 1.1 einmal über den QR-Code am PC installieren.

## Ausprobieren

1. Am PC: NOVA → Plugins → bei „NOVA Companion“ auf „Install“, dann die Seite „Phone“ öffnen. Dort steht auch der QR-Code für diese App.
2. „Phone connection“ einschalten. Hängt der PC am LAN-Kabel oder meldet die Seite „Windows firewall blocks phones“: „Allow NOVA in the firewall“ klicken (Windows fragt nach Administratorrechten).
3. „Show code“ und den Code mit der App scannen, am PC „Pair“ klicken.
4. Im Chat: „Wie lange geht der Steam-Download noch?“ mit Screenshot.
5. Nova Island: App → Einstellungen → „Benachrichtigungen an den PC“ und „Anrufe an den PC“ einschalten und Androids Benachrichtigungszugriff erlauben. Ist der Schalter in Android ausgegraut („Eingeschränkte Einstellung“, Android 13+ bei Apps aus einer Datei): App-Info → drei Punkte → „Eingeschränkte Einstellungen zulassen“; die App führt dorthin. Am PC unter Einstellungen → Nova Island die Module wählen.

## Verbindung ohne WLAN

- **PC am LAN-Kabel, Handy im WLAN desselben Routers**: geht direkt. Windows stuft Kabelnetze oft als „Öffentlich“ ein und blockt dann eingehende Verbindungen; die Seite „Phone“ erkennt das und richtet auf Klick eine Firewall-Regel ein (nur NOVA, nur sein Port, nur aus dem lokalen Netz).
- **Ganz ohne WLAN**: Handy per USB-Kabel anschließen und am Handy „USB-Tethering“ einschalten. Der PC bekommt dann eine Adresse im Netz des Handys; am PC einen neuen Code zeigen lassen oder die Adresse in der App unter Einstellungen → Verbindung eintragen.

## Grenzen

- Relay über das Internet, Wake-on-LAN und mehrere PCs kommen später.
- Benachrichtigungen bei geschlossener App kommen über den Hintergrund-Abruf, also mit bis zu etwa 15 Minuten Verzögerung (kein Push-Dienst, so entschieden).
- Weiterleitung an Nova Island läuft, solange Android den Prozess der App am Leben lässt (der Benachrichtigungszugriff hält ihn meist am Leben). Räumt Android die App ganz weg oder startet das Handy neu, kommt die nächste Benachrichtigung erst wieder nach dem Öffnen an (Audit Nr. 25, offen).
- Schnellaktionen und Medientasten auf dem Start-Bildschirm sind fertige Aufträge an NOVA AI: Sie brauchen einen Moment und erscheinen im Chat. Eine direkte Fernsteuerung kennt das Protokoll nicht.
- Blur hinter der Tab-Leiste gibt es ab Android 12; darunter ist die Leiste deckend.
- Anrufe annehmen und ablehnen geht, wenn die Telefon-App sie anbietet (Android 12+ mit Anruf-Benachrichtigung im CallStyle, z. B. Google Telefon) oder wenn NOVA Companion „Anrufe verwalten“ darf. Sonst zeigt der PC den Anruf nur an.
- Wird der Fingerabdruck am Handy neu eingerichtet, macht Android den Freigabe-Schlüssel ungültig. Dann einmal neu koppeln.
