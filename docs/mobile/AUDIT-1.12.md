# NOVA Companion — Audit für NOVA 1.12 (App 1.1.0 → 1.2.0)

Stand: 2026-11-11 · Grundlage: Code-Lesung aller Dateien unter `mobile/app`, `mobile/src`, `mobile/modules/nova-bridge`, `mobile/plugins`, `packages/companion-protocol/src` sowie der Gegenstelle in `src-tauri/src/companion` und `src-tauri/src/island.rs`.

**Wichtig:** Auf diesem PC gibt es kein Android-SDK und kein Gerät. Jeder Befund ist am Code belegt, keiner wurde auf einem Handy nachgestellt. Wo ein Befund vom Verhalten von Android abhängt, das sich nur am Gerät zeigt, steht das dabei („am Gerät bestätigen“).

Zeilennummern beziehen sich auf den Stand **vor** den Korrekturen (App 1.1.0).

Schwere: **kritisch** (Datenverlust, Sicherheitsloch, App unbenutzbar) · **hoch** (Kernfunktion fällt aus oder lügt) · **mittel** (Funktion eingeschränkt, Umweg nötig) · **Kosmetik**.

Ergebnis: 0 kritisch · 7 hoch · 33 mittel · 14 Kosmetik = 54 Befunde. Davon in App 1.2.0 behoben: 51, teilweise: 1 (Nr. 16), offen: 2 (Nr. 25, 34). Status je Befund steht am Ende in der Tabelle „Status“.

---

## A. Kopplung

**1 — hoch — Abgebrochener Fingerabdruck hinterlässt eine halbe Kopplung**
`mobile/src/store.ts:270-273`, `mobile/src/storage.ts:45-48`
Reproduktion: Code scannen, am PC „Pair“ klicken, am Handy den Fingerabdruck-Dialog „Schlüssel für Freigaben sichern“ abbrechen. Der PC hat das Gerät gespeichert, das Handy hat nur `nova.deviceSecret` geschrieben, aber weder Freigabe-Schlüssel noch PC. Die App zeigt einen englischen Text aus SecureStore, am PC steht ein Geistergerät. War das Handy schon mit einem PC gekoppelt, ist dessen `deviceSecret` jetzt überschrieben und die alte Kopplung tot.
Fix: Zuerst den Freigabe-Schlüssel schreiben (das ist der Schritt, der scheitern kann), danach Geräteschlüssel und PC. Das Ergebnis der Kopplung behalten, damit „Noch einmal versuchen“ nur den Fingerabdruck wiederholt und keinen neuen Code braucht. Deutscher Fehlertext.

**2 — mittel — Ablauf des Codes wird mit der Uhr des Handys geprüft**
`mobile/src/store.ts:270`, `packages/companion-protocol/src/client.ts:137`
Reproduktion: PC-Uhr geht drei Minuten nach. `exp` im QR-Code liegt dann aus Sicht des Handys in der Vergangenheit, die App meldet sofort „Der Code ist abgelaufen“, obwohl der PC ihn annehmen würde.
Fix: Der PC entscheidet (er prüft ohnehin). Das Handy lehnt lokal nicht mehr ab.

**3 — mittel — „Nicht erreichbar“ beim Koppeln ohne Ausweg**
`mobile/src/store.ts:264-277`, `mobile/app/pair.tsx:33-44`
Reproduktion: Der QR-Code nennt nur Adressen, die das Handy nicht erreicht (PC hat nach USB-Tethering eine neue Adresse, Code ist älter; oder eine Adresse fehlt). Beim Wiederverbinden sucht die App per mDNS (`store.ts:155`), beim Koppeln nicht. Eine Adresse von Hand lässt sich erst nach der Kopplung eintragen.
Fix: Beim Koppeln zusätzlich per mDNS gefundene Adressen des PCs und eine optional eingetippte Adresse versuchen.

**4 — mittel — Kopplung läuft nach Verlassen des Bildschirms weiter und schließt dann den falschen Bildschirm**
`mobile/app/pair.tsx:38-43`
Reproduktion: Scannen, während „Bestätige am PC“ auf „Abbrechen“ oder die Zurück-Taste tippen, dann am PC bestätigen. `pair()` läuft bis zu 150 s weiter; kommt die Antwort, ruft der verlassene Bildschirm `router.back()` auf und schließt, was gerade offen ist.
Fix: Nach dem Verlassen nicht mehr navigieren.

**5 — mittel — Kamera dauerhaft abgelehnt: Knopf tut nichts**
`mobile/app/pair.tsx:66-70`
Reproduktion: Kamera zweimal ablehnen. Android fragt nicht mehr, „Kamera erlauben“ bleibt ohne Wirkung und ohne Erklärung.
Fix: Bei `canAskAgain === false` in die App-Einstellungen von Android springen.

**6 — Kosmetik — Leerer Gerätename**
`mobile/app/pair.tsx:28,58,79`
Reproduktion: Namensfeld leeren und scannen. Der Wartetext lautet „… ob „“ gekoppelt werden soll“; am PC steht „Handy“.
Fix: Denselben Ersatznamen im Text zeigen.

## B. Verbindung

**7 — hoch — Tote Verbindung bleibt „Verbunden“**
`mobile/src/store.ts:190-197`
Reproduktion: PC in den Ruhezustand schicken oder das Handy aus dem WLAN nehmen, ohne dass der Socket sauber schließt. Die App schickt alle 30 s `status.get`, wartet aber nie auf die Antwort. Bis Android den Socket aufgibt (Minuten), steht „Verbunden“, Aufträge wirken gesendet.
Fix: Zeit der letzten PC-Nachricht merken. Kommt nach einem `status.get` binnen 10 s nichts, Verbindung schließen und neu verbinden; ebenso beim Zurückkehren in die App.

**8 — hoch — Hintergrund-Abruf arbeitet am laufenden Store vorbei**
`mobile/src/background.ts:16-49`
Reproduktion: Auftrag senden, App in den Hintergrund (Prozess lebt), Verbindung reißt, Auftrag wird fertig. Der Hintergrund-Abruf öffnet eine eigene Verbindung, quittiert die Meldung (`notices.ack`) und schreibt die Datei. Der Store im Speicher weiß davon nichts, zeigt den Auftrag weiter als „NOVA arbeitet …“ und überschreibt beim nächsten Speichern die Datei: Die Antwort ist weg. Steht die Verbindung der App noch, laufen zwei Verbindungen desselben Geräts; der PC schickt an beide (`mod.rs:216-223`), Benachrichtigungen kommen doppelt. `connection.send` im `onMessage`-Callback (Zeile 35) kann außerhalb des `try` werfen.
Fix: Läuft die App (Store geladen), geht der Abruf über den Store selbst; nur ohne laufende App direkt über die Datei.

**9 — mittel — `connect()` arbeitet mit einem veralteten PC**
`mobile/src/store.ts:142-189`
Reproduktion a: Während „Verbinde …“ die Kopplung aufheben. Der laufende Versuch gelingt danach, `link` wird „online“, obwohl kein PC mehr gekoppelt ist. Reproduktion b: Während eines Versuchs eine Adresse hinzufügen (`addHost`). Gelingt der Versuch über mDNS oder eine andere Adresse, schreibt `savePc({ ...pc, hosts })` (Zeilen 160, 187) den alten Stand zurück; die neue Adresse ist weg.
Fix: Nach jedem `await` gegen den aktuellen Stand prüfen und Adressen mit dem aktuellen Stand zusammenführen.

**10 — mittel — Adressen werden nacheinander probiert**
`mobile/src/store.ts:152`, `packages/companion-protocol/src/client.ts:97-106`
Reproduktion: Der PC hat eine neue Adresse, drei alte stehen davor. Jede kostet 4 s Timeout, erst danach startet die mDNS-Suche (weitere bis zu 4 s).
Fix: Alle bekannten Adressen gleichzeitig versuchen, die erste gewinnt, der Rest wird geschlossen; die Suche läuft parallel.

**11 — mittel — Nach dem Zurückkehren bleibt die lange Wartezeit**
`mobile/src/store.ts:133-140,233-235`
Reproduktion: PC lange aus (Wartezeit steht bei 60 s), App in den Hintergrund und wieder nach vorn. Der erste Versuch läuft sofort, scheitert er, kommt der nächste erst nach 60 s.
Fix: Beim Zurückkehren Wartezeit zurücksetzen.

**12 — mittel — Veralteter PC-Status nach Verbindungsverlust**
`mobile/src/store.ts:177-183`, `mobile/app/(tabs)/index.tsx:188-203`, `mobile/app/(tabs)/chat.tsx:94`
Reproduktion: Am PC läuft Musik, Verbindung reißt. Der Start-Bildschirm zeigt weiter „Läuft am PC … läuft“, der Orb im Chat pulsiert weiter, wenn zuletzt `busy` war.
Fix: `status` beim Schließen der Verbindung verwerfen.

**13 — mittel — Freigaben: alte bleiben stehen, Antworten des PCs gehen unter**
`mobile/src/store.ts:120-122,297-305`, `packages/companion-protocol/src/state.ts:113-122`, `src-tauri/src/companion/tasks.rs:335-340`
Reproduktion a: Freigabe wird am PC beendet, während das Handy getrennt ist; sie bleibt bis zum Ablauf in der Liste. Reproduktion b: „Freigeben“ auf einer solchen Freigabe: Der PC antwortet `error unknownRequest`, die App ignoriert das (nur Fehler zu Aufträgen in der Outbox werden ausgewertet), der Bildschirm schließt, als hätte es geklappt. Reproduktion c: Bei jedem Wiederverbinden schickt der PC offene Freigaben erneut; die App benachrichtigt jedes Mal („Neue Freigabe“).
Fix: Beim Verbinden die Liste leeren (der PC schickt die offenen neu), nur bei wirklich neuen benachrichtigen, Fehler zu einer Freigabe-Antwort anzeigen.

**14 — Kosmetik — Ablehnen ohne Verbindung**
`mobile/src/store.ts:307-310`
Reproduktion: Ohne Verbindung „Ablehnen“. Die Freigabe verschwindet am Handy, der PC wartet weiter bis zum Ablauf und schickt sie beim Wiederverbinden erneut.
Fix: Nur entfernen, wenn gesendet; sonst sagen, dass der PC nicht erreichbar ist.

**15 — mittel — Abbrechen ohne Verbindung tut still nichts**
`mobile/src/store.ts:287-295`, `mobile/app/(tabs)/tasks.tsx:61`
Reproduktion: Ohne Verbindung bei einem geplanten Auftrag „Abbrechen“ tippen: keine Wirkung, keine Rückmeldung.
Fix: Ergebnis zurückgeben und melden.

**16 — mittel — Auftrag bleibt für immer „NOVA arbeitet …“**
`src-tauri/src/companion/tasks.rs:459-466`, `mobile/src/store.ts:104-131`
Reproduktion: Auftrag läuft, Handy verliert das WLAN ohne sauberes Schließen. Der PC hält die Verbindung noch bis zu 75 s für offen (`server.rs:28`), `send_to` meldet „zugestellt“, es wird keine Meldung gespeichert. Das Handy bekommt das Ergebnis nie; der Chat-Eintrag bleibt im Zustand „running“. Die Aufgabenliste (`tasks`) kennt den Endzustand, wird aber nicht mit dem Chat abgeglichen.
Fix am Handy: Chat-Einträge mit der Aufgabenliste abgleichen. Der Text der Antwort lässt sich so nicht zurückholen: Dafür müsste der PC das Ergebnis erst nach einer Quittung als zugestellt werten (Desktop/Protokoll).

**17 — Kosmetik — `init()` kann doppelt laufen**
`mobile/src/store.ts:224-238`
Reproduktion: Zwei Aufrufe vor dem ersten `await`-Ende (Fast Refresh, StrictMode). `ready` wird erst danach gesetzt: zwei AppState-Listener, zwei Update-Prüfungen.
Fix: Den laufenden Aufruf merken.

## C. Store und Zustand

**18 — mittel — Jede PC-Nachricht rendert alle Bildschirme neu**
`mobile/app/(tabs)/index.tsx:82`, `chat.tsx:74,104`, `tasks.tsx:28`, `mobile/app/approval/[id].tsx:15`, `mobile/app/settings.tsx:63`
Reproduktion: Lange Antwort streamen. `useCompanion()` ohne Selektor abonniert den ganzen Store; jeder Textschnipsel und jeder Herzschlag rendert alle vier Tabs. Der Chat baut dabei jedes Mal `[...chat].reverse()` neu und rendert alle Zeilen ohne `memo`.
Fix: Selektoren, stabile Daten, `memo` für Zeilen.

**19 — mittel — Screenshots bleiben als Base64 im Speicher**
`packages/companion-protocol/src/state.ts:91`, `mobile/app/(tabs)/chat.tsx:45-52`
Reproduktion: Zwanzig Aufträge mit Screenshot. Jeder hält bis zu 4 MB Base64 im Store (bis zu 200 Einträge) und wird als `data:`-URI neu dekodiert.
Fix: Nur die neuesten Screenshots behalten.

**20 — Kosmetik — Gespeicherter PC wird ungeprüft übernommen**
`mobile/src/storage.ts:26-34`
Reproduktion: Beschädigter Eintrag `nova.pc` (gültiges JSON, falsche Form) führt zu `pc.hosts.map` auf `undefined`.
Fix: Form prüfen, sonst als ungekoppelt behandeln.

**21 — Kosmetik — Letzte Änderung geht beim Wegwischen verloren**
`mobile/src/store.ts:87-90`
Reproduktion: Auftrag senden und die App binnen 500 ms wegwischen: Der Auftrag fehlt nach dem Start in Outbox und Chat.
Fix: Beim Wechsel in den Hintergrund sofort speichern.

**22 — Kosmetik — Zu langer Auftrag hängt für immer in der Outbox**
`mobile/src/store.ts:279-285`, `src-tauri/src/companion/server.rs:217-219`
Reproduktion: Diktat liefert mehr als 4000 Zeichen (das Feld begrenzt nur Tippen). Der PC lehnt mit `error` ohne `replyTo` ab; der Auftrag bleibt in der Outbox und wird bei jedem Verbinden wieder abgelehnt.
Fix: Text beim Senden auf 4000 Zeichen kürzen.

**23 — Kosmetik — Englische Fehlertexte des PCs in der deutschen App**
`packages/companion-protocol/src/state.ts:120`
Reproduktion: 51. wartender Auftrag: im Chat steht „Too many tasks are waiting“.
Fix: Fehlercodes am Handy übersetzen.

## D. Benachrichtigungen weiterleiten

**24 — hoch — „Eingeschränkte Einstellung“ blockiert den Benachrichtigungszugriff**
`mobile/app/settings.tsx:118-127`
Reproduktion: App wie vorgesehen per APK installieren (Android 13 oder neuer), „Benachrichtigungszugriff erlauben“ tippen. Android zeigt NOVA Companion ausgegraut („Eingeschränkte Einstellung“), weil die App nicht aus einem Store kommt. Die App erklärt nicht, dass man erst in der App-Info „Eingeschränkte Einstellungen zulassen“ wählen muss. (Verhalten von Android 13+, am Gerät bestätigen.)
Fix: Hinweis mit Weg und Knopf zur App-Info, im Onboarding und in den Einstellungen.

**25 — hoch — Weiterleitung endet, sobald Android die App wegräumt oder das Handy neu startet**
`mobile/modules/nova-bridge/android/src/main/java/dev/nova/bridge/NovaBridge.kt:32-36,69`
Reproduktion: Handy neu starten, App nicht öffnen. Android bindet den Listener, aber `module` ist `null` und die Schalter stehen auf `false` (sie kommen nur über `configure` aus JavaScript). Nichts wird weitergeleitet, bis die App geöffnet wird. Steht als Grenze in `mobile/README.md`, ist aber für „Anrufe am PC“ ein echter Ausfall.
Fix-Idee: Den Listener JavaScript ohne Oberfläche starten lassen (Headless-Task) oder die Verbindung nativ halten. Beides ist ohne Gerät nicht verantwortbar zu bauen.

**26 — mittel — Jede Aktualisierung einer Benachrichtigung geht erneut an den PC**
`NovaBridge.kt:53-81`
Reproduktion: Eine App aktualisiert ihre Benachrichtigung ohne neuen Inhalt (Synchronisation, Zähler, erneutes Posten). `onNotificationPosted` leitet jedes Mal weiter, Nova Island klappt jedes Mal auf.
Fix: Je Schlüssel den letzten Inhalt merken und Gleiches überspringen.

**27 — mittel — Datenschutz: geheime und stille Benachrichtigungen gehen mit, Auswahl je App fehlt**
`NovaBridge.kt:60-67`, `mobile/src/phone.ts:13-22`
Reproduktion: Eine App markiert ihre Benachrichtigung als `VISIBILITY_SECRET` (Banking, Passwort-Manager) oder postet still mit niedriger Wichtigkeit. Beides erscheint mit Text auf dem PC-Bildschirm. Abschalten lässt sich nur alles oder der Text aller Apps.
Fix: `VISIBILITY_SECRET` und Wichtigkeit unter „Standard“ überspringen; Liste stummgeschalteter Apps in den Einstellungen.

**28 — mittel — App-Namen und Icons fremder Apps (Paket-Sichtbarkeit ab Android 11)**
`NovaBridge.kt:167-186`, `mobile/modules/nova-bridge/android/src/main/AndroidManifest.xml:1-19`
Reproduktion: Benachrichtigung von Facebook. Ohne `<queries>` im Manifest liefert `getApplicationInfo` für fremde Pakete `NameNotFoundException`; der Code fällt auf den letzten Teil des Paketnamens zurück („Katana“), das Icon fehlt. (Am Gerät bestätigen.)
Fix: `<queries>` für startbare Apps (MAIN/LAUNCHER) im Manifest des Moduls. Kein `QUERY_ALL_PACKAGES`.

**29 — Kosmetik — Gekürzter Text kann ein halbes Emoji enthalten**
`mobile/src/phone.ts:59-61`, `NovaBridge.kt:75-76`
Reproduktion: Benachrichtigung, bei der Zeichen 200 des Titels (oder 1000 des Texts) ein Emoji ist. `slice`/`take` schneidet das Surrogat-Paar durch; `serde_json` am PC lehnt die Nachricht ab, die Benachrichtigung fehlt.
Fix: Beim Kürzen kein halbes Paar stehen lassen.

**30 — mittel — Eigene Benachrichtigungen: Frage ohne Zusammenhang, kein Kanal, Antippen führt nirgends hin**
`mobile/app/_layout.tsx:19`, `mobile/src/store.ts:81-84`
Reproduktion: Erster Start: Android fragt sofort nach Benachrichtigungen, bevor die App etwas erklärt hat. „Neue Freigabe“ landet im Kanal „Miscellaneous“; Antippen öffnet nur die App, nicht die Freigabe (120 s Frist).
Fix: Frage ins Onboarding, eigener Kanal mit deutschem Namen, Antippen öffnet die Freigaben.

## E. Anrufe

**31 — mittel — Anrufstatus wird nach Verbindungslücken nicht abgeglichen**
`mobile/src/phone.ts:83-100`, `mobile/src/store.ts:194-196`, `NovaBridge.kt:161`, `src-tauri/src/island.rs:641-648`
Reproduktion: Anruf klingelt, Verbindung reißt länger als 60 s, Anruf endet. Das „ended“ wird als zu alt verworfen; der PC räumt Anrufe beim Trennen nicht ab, Nova Island zeigt den Anruf weiter. Umgekehrt erfährt ein PC, der mitten im Anruf verbindet, nichts davon (`activeCalls()` wird nie aufgerufen).
Fix: Stand der Anrufe am Handy führen und nach jedem Verbinden schicken, „ended“ nie verwerfen.

**32 — mittel — `ANSWER_PHONE_CALLS` wird nie angefragt**
`mobile/app/settings.tsx:67-71,129-135`
Reproduktion: „Anrufe an den PC“ einschalten, Telefon-App ohne CallStyle. Die App verweist auf Android → Apps → Berechtigungen → Telefon; einen Dialog gibt es nicht.
Fix: Berechtigung per Knopf anfragen (`PermissionsAndroid`), Stand ehrlich anzeigen.

**33 — mittel — Versprechen „Annehmen und Ablehnen am PC“ ohne Vorbehalt**
`mobile/app/settings.tsx:106-108`
Reproduktion: Untertitel des Schalters lesen. Ob Annehmen geht, hängt von der Telefon-App oder der Berechtigung ab (`NovaBridge.kt:122-123`).
Fix: Ehrlicher Text und eigene Zeile, die zeigt, was dieses Handy kann.

**34 — Kosmetik — Fehlgeschlagene Anruf-Aktion bleibt am PC unbemerkt**
`mobile/src/phone.ts:103-111`
Reproduktion: Am PC „Annehmen“, die Telefon-App hat das PendingIntent verworfen. `handleCallAction` liefert `false`, niemand erfährt es.
Fix-Idee: Antwortnachricht im Protokoll (beidseitig).

## F. Updates

**35 — mittel — Prüfsumme lädt die ganze APK zweimal in den Speicher**
`mobile/src/updates.ts:75-76`
Reproduktion: Update (rund 40 MB) auf einem Handy mit wenig RAM laden. `saved.bytes()` und `Crypto.digest` halten die Datei als `Uint8Array` und als Kopie über die Brücke.
Fix: SHA-256 nativ im Strom rechnen (`nova-bridge`), der bisherige Weg bleibt als Rückfall.

**36 — mittel — Download ohne Fortschritt und ohne Abbruch**
`mobile/src/updates.ts:73`, `mobile/app/settings.tsx:51`
Reproduktion: „Herunterladen“ im langsamen Netz: nur „Lädt …“, kein Prozentwert, kein Abbrechen.
Fix: `File.createDownloadTask` mit `onProgress` und `cancel()`.

**37 — mittel — Kein Hinweis auf Play Protect vor der Installation**
`mobile/app/settings.tsx:52`, `mobile/src/updates.ts:88-104`
Reproduktion: „Installieren“. Play Protect kann „App-Scan empfohlen“ oder „Unsichere App blockiert“ zeigen; die App bereitet darauf nicht vor.
Fix: Hinweis mit Bildfolge vor dem Start des Installers.

**38 — Kosmetik — Update wird angeboten, das Android ablehnt**
`mobile/src/updates.ts:58`
Reproduktion: Manifest mit höherer Version, aber kleinerem `versionCode`. Die App bietet es an (ODER-Verknüpfung), Android verweigert nach 40 MB Download.
Fix: Nur anbieten, wenn der `versionCode` nicht kleiner ist.

**39 — Kosmetik — Geladene Datei wird nach Neustart vergessen, alte bleiben liegen, Fehler braucht Umweg**
`mobile/src/updates.ts:35,70-72,83-85`
Reproduktion: Laden, App schließen, öffnen: erneut 40 MB. Nach einem Download-Fehler gibt es nur „Nach Updates suchen“, nicht „Erneut laden“. Alte `NOVA-Companion-*.apk` bleiben im Cache.
Fix: Vorhandene Datei gegen die Prüfsumme prüfen und nutzen, alte löschen, nach Fehler direkt neu laden.

## G. Oberfläche

**40 — hoch — Tastatur: Eingabe und Tab-Leiste**
`mobile/app/(tabs)/chat.tsx:91,127`, `mobile/app/capture.tsx:48`, `mobile/app/(tabs)/_layout.tsx:15`
Reproduktion: Im Chat ins Feld tippen. `KeyboardAvoidingView` hat auf Android kein `behavior` und verlässt sich auf `adjustResize`; Expo SDK 58 erzwingt Edge-to-Edge (`@expo/prebuild-config/.../withEdgeToEdge.js:40`), womit Android das Fenster nicht mehr selbst verkleinert. Zusätzlich hält der Composer immer 78 px Abstand für die Tab-Leiste, und die schwebende Leiste bleibt bei offener Tastatur stehen. (Ob das Feld ganz verdeckt wird, am Gerät bestätigen; Abstand und Leiste sind am Code sicher.)
Fix: `behavior="padding"` (rechnet nur die wirkliche Überdeckung), Tab-Leiste und Abstand bei offener Tastatur weg.

**41 — mittel — „Schnell erfassen“ scrollt nicht**
`mobile/app/capture.tsx:50-117`
Reproduktion: Kleines Display, Tastatur offen, „Um …“ gewählt. Titel, Feld, drei Optionen, Uhrzeit und zwei Knöpfe passen nicht; „An NOVA senden“ ist nicht erreichbar.
Fix: Inhalt scrollbar, Knöpfe unten fest.

**42 — mittel — Start zeigt kurz das Onboarding; „Code scannen“ liegt unter der Tab-Leiste**
`mobile/app/(tabs)/index.tsx:54,91-98`
Reproduktion a: Gekoppelte App starten: Bis `init()` fertig ist, ist `pc` `null`, es blitzt „NOVA auf dem Handy“ auf. Reproduktion b: Ungekoppelt auf kleinem Display ganz nach unten scrollen: Der Abstand unten (40 px) ist kleiner als die Tab-Leiste, der Knopf liegt teils darunter.
Fix: Bis `ready` einen Ladezustand zeigen; Onboarding als eigener Bildschirm ohne Tabs.

**43 — mittel — Doppel-Tipps lösen doppelt aus**
`mobile/src/ui.tsx:65-73`, `mobile/app/(tabs)/index.tsx:180-183`, `approvals.tsx:34`, `chat.tsx:117`
Reproduktion: „Bildschirm“ doppelt tippen: zwei Aufträge mit Screenshot. Freigabe doppelt tippen: zwei Dialoge übereinander. Vorschlag im Chat doppelt: zwei Aufträge.
Fix: Zweiten Tipp binnen kurzer Zeit im Press-Baustein verwerfen.

**44 — mittel — Diktat: beide Bildschirme hören mit, Getipptes wird ersetzt**
`mobile/src/dictation.ts:9-18`, `mobile/app/(tabs)/chat.tsx:78-81`, `mobile/app/capture.tsx:34-37`
Reproduktion a: Chat einmal öffnen, dann Start → „Auftrag“ → diktieren. Die Ereignisse der Spracherkennung sind global; der (weiter eingehängte) Chat übernimmt denselben Text in sein Feld. Reproduktion b: „Öffne“ tippen, Mikrofon, sprechen: Das Getippte ist weg.
Fix: Nur die Instanz, die gestartet hat, verarbeitet Ergebnisse; Diktat wird angehängt.

**45 — mittel — Freigabe: englischer oder falscher Fehlertext**
`mobile/src/storage.ts:51-54`, `mobile/src/store.ts:301-302`, `mobile/app/approval/[id].tsx:69-70`
Reproduktion a: Fingerabdruck-Dialog abbrechen: SecureStore wirft „Could not authenticate the user: …“, die App zeigt das roh. Reproduktion b: Fingerabdruck in Android neu einrichten: SecureStore liefert `null` (Schlüssel ungültig), die App sagt „Freigabe abgebrochen“ und der Nutzer versucht es endlos.
Fix: Abbruch und ungültigen Schlüssel unterscheiden, deutsch erklären („neu koppeln“).

**46 — mittel — Freigaben hängen an der Uhr des Handys**
`packages/companion-protocol/src/state.ts:132-134`, `mobile/app/approval/[id].tsx:25`, `mobile/app/(tabs)/approvals.tsx:32`
Reproduktion: Handy-Uhr geht drei Minuten vor der PC-Uhr. `expiresAt` kommt vom PC; jede Freigabe gilt am Handy sofort als abgelaufen und erscheint nie.
Fix: Aus dem `ts` der PC-Nachrichten den Uhrenversatz schätzen und damit rechnen.

**47 — mittel — Schriftgröße 200 %**
`mobile/app/(tabs)/_layout.tsx:44,92`, `mobile/app/(tabs)/index.tsx:237-248`, `mobile/app/capture.tsx:97`
Reproduktion: Android-Schriftgröße auf das Maximum. Tab-Beschriftungen brechen um oder werden abgeschnitten, die Kacheln mit fester Breite (47,8 %) und `numberOfLines={2}` schneiden Text ab, das Uhrzeitfeld (130 px breit, 22 px Schrift) zeigt „18:30“ nicht mehr ganz.
Fix: Layouts, die mitwachsen; nur an festen Stellen (Tab-Leiste, Abzeichen) die Skalierung deckeln.

**48 — mittel — Kein helles Design**
`mobile/app.json:8`, `mobile/src/theme.ts:5-24`, `mobile/app/_layout.tsx:25`
Reproduktion: Android auf „Hell“. Die App bleibt dunkel (`userInterfaceStyle: "dark"`), es gibt nur eine Palette.
Fix: Helle Palette, Umschalter System / Dunkel / Hell.

**49 — Kosmetik — Touch-Ziele unter 44 px**
`mobile/app/(tabs)/chat.tsx:177,187,189`, `mobile/src/ui.tsx:355`
Reproduktion: Screenshot-Schalter, Senden und Mikrofon im Chat sind 40 × 40, Vorschläge rund 36 px hoch, kompakte Knöpfe 40 px.
Fix: Mindestens 44 px, sonst `hitSlop`.

**50 — Kosmetik — Ziehen zum Aktualisieren zeigt nichts**
`mobile/app/(tabs)/index.tsx:109`, `mobile/app/(tabs)/tasks.tsx:44`
Reproduktion: Liste herunterziehen: `refreshing={false}`, der Kreis verschwindet sofort.
Fix: Kurzer echter Ladezustand, bis der PC geantwortet hat.

**51 — Kosmetik — `router.back()` ohne Verlauf**
`mobile/app/settings.tsx:80`, `mobile/app/capture.tsx:44,115`, `mobile/app/pair.tsx:100`, `mobile/app/approval/[id].tsx:35`
Reproduktion: Bildschirm über `novacompanion://settings` öffnen und „Schließen“ tippen: nichts passiert.
Fix: Ohne Verlauf zum Start wechseln.

## H. Kotlin und Android 14/15

**52 — hoch — Listener ohne Fangnetz**
`mobile/modules/nova-bridge/android/src/main/java/dev/nova/bridge/NovaNotificationListener.kt:12-18`, `NovaBridge.kt:53-126`
Reproduktion: Eine App legt eigene `Parcelable`-Klassen in die Extras ihrer Benachrichtigung. Beim ersten Zugriff auf die Extras (`getCharSequence`, `getParcelable`) wirft Android bis Version 12 `BadParcelableException`; ohne `try` stürzt der Prozess der App ab, bei jeder weiteren Benachrichtigung dieser App wieder. (Am Gerät bestätigen; das Muster ist bei Benachrichtigungs-Listenern bekannt.)
Fix: `posted`/`removed` im Listener absichern.

Dazu ohne eigene Nummer, weil ohne sichtbaren Fehler: Der Listener bittet nach `onListenerDisconnected` nicht um erneutes Binden (`requestRebind`), und `Bitmap.createScaledBitmap` in `NovaBridge.kt:202` wird nicht freigegeben. Beides wird mit Befund 52 mitkorrigiert.

## I. Build und Repository

Diese beiden Befunde kamen erst bei der Prüfung von Signatur und Berechtigungen dazu (Auftrag 5.3), nach der ersten Fassung dieser Liste.

**53 — mittel — Die fertige APK fordert 21 Berechtigungen an, die keine Funktion trägt**
`mobile/app.json:26-29`, gemessen an `releases/NOVA-Companion.apk` (Build 1.0.0)
Reproduktion: `node mobile/scripts/apk-info.mjs releases/NOVA-Companion.apk`. Das zusammengeführte Manifest enthält 35 `uses-permission`, darunter `SYSTEM_ALERT_WINDOW` („über anderen Apps einblenden“, aus React Native), `READ_/WRITE_EXTERNAL_STORAGE`, `com.google.android.c2dm.permission.RECEIVE` (Firebase-Push, obwohl kein Push-Dienst genutzt wird), den Install-Referrer und 16 Badge-Berechtigungen fremder Launcher. `blockedPermissions` nannte nur die beiden Standort-Berechtigungen. Für Play Protect und für jeden, der die App-Info öffnet, sieht die App neugieriger aus, als sie ist.
Fix: alle 21 in `blockedPermissions`.

**54 — mittel — `mobile/.gitignore` blendet den Kotlin-Code des eigenen Moduls aus**
`mobile/.gitignore:5-6`
Reproduktion: `android/` und `ios/` stehen ohne führenden Schrägstrich und treffen damit auch `mobile/modules/nova-bridge/android/`. Ein `git add mobile` nimmt Manifest, Gradle-Datei und alle Kotlin-Quellen des Moduls nicht auf; im öffentlichen Repository fehlte es. (`expo-doctor` meldet genau das. Der EAS-Build ist nicht betroffen: Er nutzt die `.easignore` im Wurzelverzeichnis, die nur `/mobile/android/` ausnimmt.)
Fix: `/android/` und `/ios/`.

Ohne Nummer, weil es kein Fehler im Code der App ist, aber für jedes Update zählt: Die `releases/NOVA-Companion.apk` in diesem Ordner ist **Build 1.0.0 (versionCode 1)**. Sie enthält weder `nova-bridge` noch den Updater, und `releases/companion.json` fehlt hier. Näheres in [PLAN.md](PLAN.md), Abschnitt 11.3.

---

## Geprüft, ohne Befund

- **Foreground-Service-Typen (Android 14):** Die App und `nova-bridge` deklarieren keinen Foreground-Service; Hintergrundarbeit läuft über WorkManager (`expo-background-task`). Kein Typ nötig.
- **`POST_NOTIFICATIONS` (Android 13+):** deklariert (`app.json`, `expo-notifications`) und zur Laufzeit angefragt.
- **Listener-Dienst:** `exported="true"` mit `BIND_NOTIFICATION_LISTENER_SERVICE`, wie Android es verlangt.
- **Update-Manifest:** nur HTTPS aus demselben Repository, SHA-256 und Größe werden vor der Installation geprüft (`app.ts:35-48`, `updates.ts:77`), `installApk` nimmt nur `content://`.
- **Kopplungscodes:** fremde QR-Codes, abgelaufene, benutzte und abgelehnte Codes liefern eigene deutsche Texte (`store.ts:58-79`); Doppel-Scan ist gesperrt (`pair.tsx:34-35`).
- **Outbox:** doppelt gesendete Aufträge beantwortet der PC mit dem Stand (`tasks.rs:208-212`), kein doppelter Lauf.
- **Sitzung:** gefälschte oder wiederholte Rahmen beenden die Verbindung (`client.ts:222-227`).
- **Gruppen:** Gruppen-Zusammenfassungen, laufende und Foreground-Service-Benachrichtigungen werden nicht weitergeleitet (`NovaBridge.kt:62-63`).
- **Eigene Benachrichtigungen** tragen keinen Inhalt (`state.ts:140-155`).

---

## Status

Stand nach den Korrekturen für App 1.2.0 (2026-11-11). „Behoben“ heißt: im Code geändert, `npx tsc --noEmit` grün, wo es Logik ist mit Test in `mobile/src/logic.test.ts` oder `mobile/src/store.test.ts`. **Nichts davon lief auf einem Gerät.** Änderungen in Kotlin sind zusätzlich **nicht kompiliert** (kein Android-SDK auf diesem PC); sie sind mit „Kotlin“ markiert und müssen sich im nächsten EAS-Build erst beweisen.

| Nr. | Schwere | Status | Wie |
| --- | --- | --- | --- |
| 1 | hoch | behoben | `storage.ts` schreibt zuerst den Freigabe-Schlüssel; `store.ts` behält das Ergebnis (`pairingPending`, `finishPairing`), der Kopplungs-Bildschirm bietet „Fingerabdruck wiederholen“. Test: „keeps the pairing when the fingerprint was cancelled“. |
| 2 | mittel | behoben | `store.ts` übergibt `pairWithPc` nie eine Zeit nach `expiresAt`; der PC entscheidet. Test: „lets the PC decide whether the code is still good“. |
| 3 | mittel | behoben | Bei „unreachable“ sucht `pair()` per mDNS; optionales Adressfeld im Schritt „Verbinden“. Test: „tries an address typed by hand“. |
| 4 | mittel | behoben | `pair.tsx` navigiert nach dem Verlassen nicht mehr (`mounted`). |
| 5 | mittel | behoben | `pair.tsx` öffnet bei `canAskAgain === false` die App-Einstellungen. |
| 6 | Kosmetik | behoben | Ersatzname „Mein Handy“ auch im Wartetext. |
| 7 | hoch | behoben | `probe()` in `store.ts`: 10 s ohne jede Nachricht nach `status.get` schließt die Verbindung; auch beim Zurückkehren in die App. Tests: „a line that went dead“ (3). |
| 8 | hoch | behoben | `background.ts` ruft nur noch `store.sync()`; eine Verbindung, ein Zustand. Test: „background sync“. |
| 9 | mittel | behoben | `attempt()` prüft nach dem Verbinden gegen den aktuellen PC und führt Adressen mit dem aktuellen Stand zusammen. Tests: „races with pairing“ (2). |
| 10 | mittel | behoben | `openFirst()` versucht alle Adressen gleichzeitig. Test: „tries every known address at once“. |
| 11 | mittel | behoben | Beim Zurückkehren `failures = 0`. Test: „starts over at once when the app comes back“. |
| 12 | mittel | behoben | `onClose` setzt `status` und `latency` auf `null`. Test: „closes when the PC doesn't answer“. |
| 13 | mittel | behoben | Liste wird beim Verbinden geleert, Benachrichtigung je `requestId` einmal, `approve()` wartet auf die Bestätigung des PCs und meldet dessen Ablehnung. Tests: „approvals“ (4). |
| 14 | Kosmetik | behoben | `decline()` entfernt nur, wenn gesendet; der Bildschirm erklärt den Rest. Test: „keeps an approval that couldn't be declined“. |
| 15 | mittel | behoben | `cancel()` liefert `false`; die Aufgabenliste meldet es. Test: „takes back a task … and reports when the PC can't be told“. |
| 16 | mittel | **teilweise** | Handy: `reconcileChat` beendet hängende Einträge aus der Aufgabenliste. **Offen am Desktop:** Der Antworttext bleibt verloren, solange `tasks.rs:459` ein Ergebnis schon beim Einreihen als zugestellt wertet. Das braucht eine Quittung im Protokoll (beide Seiten) und liegt außerhalb des Handy-Auftrags. |
| 17 | Kosmetik | behoben | `init()` merkt sich den laufenden Aufruf (`starting`). |
| 18 | mittel | behoben | Alle Bildschirme lesen den Store über Selektoren; Chat-Zeilen sind `memo`, die Liste ist `useMemo`. |
| 19 | mittel | behoben | `trimScreenshots`: nur die vier neuesten bleiben im Speicher. Test in `logic.test.ts`. |
| 20 | Kosmetik | behoben | `loadPc` prüft die Form. |
| 21 | Kosmetik | behoben | Beim Wechsel in den Hintergrund wird sofort gespeichert (`flush`). |
| 22 | Kosmetik | behoben | `taskText` kürzt auf 4000 Zeichen. Test: „cuts an over-long task“. |
| 23 | Kosmetik | behoben | `errorText` übersetzt die Fehlercodes. Freie Fehlertexte aus `task.result` (von NOVA AI am PC) bleiben, wie der PC sie schreibt. Test: „puts a refused task into the chat in German“. |
| 24 | hoch | behoben | `RestrictedSettingsHint` (Weg und Knopf zur App-Info) im Onboarding und in den Einstellungen. Wortlaut von Android am Gerät gegenprüfen. |
| 25 | hoch | **offen** | Braucht einen Headless-Start von JavaScript aus dem Listener oder eine native Verbindung. Ohne Gerät und ohne Kompilieren nicht verantwortbar. Der Hintergrund-Abruf (alle ~15 min) startet die App-Logik jetzt über denselben Store; ob das die Weiterleitung nach einem Neustart früher wieder in Gang bringt, ist **nicht geprüft**. |
| 26 | mittel | behoben (Kotlin) | `NovaBridge.kt`: gleicher Inhalt je Schlüssel wird nicht erneut gesendet, Anrufzustände ebenso. |
| 27 | mittel | behoben (Kotlin + JS) | `VISIBILITY_SECRET` wird nie gesendet, stille Benachrichtigungen per Schalter nicht (Standard: an); Liste je App in den Einstellungen (Filter in `phone.ts`). |
| 28 | mittel | behoben (Kotlin/Manifest) | `<queries>` für MAIN/LAUNCHER im Manifest des Moduls. Wirkung am Gerät bestätigen. |
| 29 | Kosmetik | behoben | `safeSlice` in `phone.ts`. Test: „never leaves half an emoji at the cut“. |
| 30 | mittel | behoben | Frage im Onboarding (Schritt 3), Kanal „Aufträge und Freigaben“, Antippen öffnet Freigaben oder Chat (`notify.ts`). |
| 31 | mittel | behoben | `callSnapshot()` nach jedem Verbinden (gegen Androids Liste abgeglichen), „ended“ verfällt nie. Tests: „Nova Island“ (2), „forwarding queue“ (4). Rest am Desktop: `island.rs` räumt Anrufe eines getrennten Handys weiterhin nicht selbst ab. |
| 32 | mittel | behoben | Zeile „Am PC annehmen und auflegen“ fragt per `PermissionsAndroid`. |
| 33 | mittel | behoben | Text sagt, wann Annehmen geht und wann nicht. |
| 34 | Kosmetik | **offen** | Braucht eine neue Nachricht im Protokoll (Handy → PC) samt Anzeige auf Nova Island; für diese Version bewusst kein Protokolleingriff. |
| 35 | mittel | behoben (Kotlin) | `fileSha256` im Modul liest in Stücken; der bisherige Weg bleibt Rückfall. |
| 36 | mittel | behoben | `File.createDownloadTask` mit Fortschritt und „Abbrechen“. |
| 37 | mittel | behoben | Vor dem Installer erklärt ein Blatt Play Protect in drei Bildern (`PlayProtectSteps`). |
| 38 | Kosmetik | behoben | `updateOffered`. Test: „never offers what Android would refuse“. |
| 39 | Kosmetik | behoben | Geprüfte Datei wird wiederverwendet, alte APKs gelöscht, „Erneut laden“ nach Fehler. |
| 40 | hoch | behoben | `behavior="padding"`, Tab-Leiste und Abstand weichen der Tastatur. **Am Gerät prüfen**: Das ist der Befund, bei dem ein Blick aufs Handy am meisten zählt. |
| 41 | mittel | behoben | Inhalt scrollt, „An NOVA senden“ bleibt unten. |
| 42 | mittel | behoben | Ladezustand bis `ready`; Onboarding ist ein eigener Bildschirm ohne Tabs. |
| 43 | mittel | behoben | `Press` verwirft einen zweiten Tipp binnen 400 ms. |
| 44 | mittel | behoben | Nur die startende Instanz verarbeitet Diktat; Diktat wird angehängt (`appendDictation`). |
| 45 | mittel | behoben | `approvalKey()` unterscheidet „cancelled“ und „lost“. Test: „tells a cancelled fingerprint from a key Android threw away“. |
| 46 | mittel | behoben | `clockOffset` aus dem `ts` der Statusantwort; alle Fristen rechnen damit. Test: „judges expiry by the PC's clock“. |
| 47 | mittel | behoben | Kacheln einspaltig ab Schriftfaktor 1,3; Tab-Beschriftung und Abzeichen gedeckelt; Knöpfe und Zeilen mit Mindest- statt Festhöhe. **Am Gerät bei 200 % prüfen.** |
| 48 | mittel | behoben | Helle Palette in `theme.ts`, Umschalter System / Dunkel / Hell. |
| 49 | Kosmetik | behoben | Alle Ziele mindestens 44 px (`TOUCH`), Schalter mit `hitSlop`. |
| 50 | Kosmetik | behoben | `refresh()` endet mit der Antwort des PCs (höchstens 2,5 s). |
| 51 | Kosmetik | behoben | `goBack()` wechselt ohne Verlauf zum Start. |
| 52 | hoch | behoben (Kotlin) | Alle Listener-Callbacks sind abgesichert; `requestRebind` nach Trennung; skalierte Bitmap wird freigegeben. |
| 53 | mittel | behoben | 21 Berechtigungen aus Bibliotheken in `blockedPermissions`; `npx expo config --type introspect` zeigt die 23 Entfernungen. Ob Gradle sie entfernt und nichts fehlt, zeigt erst der nächste Build (`npm run apk:info`). |
| 54 | mittel | behoben | `/android/` und `/ios/` in `mobile/.gitignore`. |

Zusammen: hoch 6 von 7 behoben (offen: 25) · mittel 32 von 33 behoben, 1 teilweise (16) · Kosmetik 13 von 14 behoben (offen: 34).
