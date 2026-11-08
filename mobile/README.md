# NOVA Companion (Handy)

Die Handy-App zu NOVA: ein Auftragskanal zu NOVA AI auf deinem PC. Die KI, ihre Schlüssel und das Protokoll bleiben auf dem PC; das Handy schickt Aufträge, zeigt Antworten und gibt Änderungen mit Fingerabdruck frei. Plan und Sicherheitsmodell: [docs/mobile/PLAN.md](../docs/mobile/PLAN.md).

## Aufbau

```
app/(tabs)/index.tsx       Start: PC-Status, offene Freigabe, laufende Medien
app/(tabs)/chat.tsx        Chat mit großem Mikrofon-Button und Screenshots
app/(tabs)/tasks.tsx       Geplante und wartende Aufträge
app/(tabs)/approvals.tsx   Offene Freigaben
app/approval/[id].tsx      Freigabe: Details, Fingerabdruck, Ablehnen
app/capture.tsx            Schnell erfassen: jetzt, sobald der PC an ist, um HH:MM
app/pair.tsx               QR-Code scannen und koppeln
src/store.ts               Zustand und Verbindung (zustand)
src/storage.ts             Schlüssel im Keystore, Verlauf als Datei
src/background.ts          Abruf alle ~15 Minuten bei geschlossener App
../packages/companion-protocol   Protokoll, Verschlüsselung, Client, Zustand (mit Desktop geteilt, getestet mit Vitest)
```

## Bauen

Die App braucht einen eigenen Build (Spracherkennung, mDNS und Hintergrund-Abruf laufen nicht in Expo Go).

```bash
npm install
```

```bash
npm run typecheck
```

Android, lokal (Android Studio mit SDK und ein Gerät mit USB-Debugging oder ein Emulator):

```bash
npx expo run:android
```

Danach startet `npm start` den Entwicklungsserver für diesen Build. Für eine installierbare APK ohne Android Studio geht auch EAS (`npx eas build -p android --profile preview`, Expo-Konto nötig).

Die Tests für Protokoll, Verschlüsselung, Client und Zustand laufen im Hauptprojekt: `npm test` im Repository-Wurzelverzeichnis.

## Ausprobieren

1. Am PC: NOVA → Einstellungen → Phone → „Phone connection“ einschalten. Windows fragt einmal nach der Firewall: nur für private Netzwerke erlauben.
2. „Show code“ und den Code mit der App scannen, am PC „Pair“ klicken.
3. Im Chat: „Wie lange geht der Steam-Download noch?“ mit „Screenshot mitschicken“.

## Grenzen

- Nur im selben WLAN. Relay, Wake-on-LAN und mehrere PCs kommen später.
- Benachrichtigungen bei geschlossener App kommen über den Hintergrund-Abruf, also mit bis zu etwa 15 Minuten Verzögerung (kein Push-Dienst, so entschieden).
- Ein App-Icon fehlt noch; Expo nimmt sein Standard-Icon.
- Wird der Fingerabdruck am Handy neu eingerichtet, macht Android den Freigabe-Schlüssel ungültig. Dann einmal neu koppeln.
