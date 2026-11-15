import { PROTOCOL_VERSION } from "@nova/companion-protocol";
import { router } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Appearance } from "../src/appearance";
import { haptic } from "../src/haptics";
import { ConnectionHelp, PlayProtectSteps, RestrictedSettingsHint } from "../src/hints";
import { updateOffered } from "../src/logic";
import { usePermissions } from "../src/permissions";
import { useCompanion } from "../src/store";
import { radius, space, themed, useTheme } from "../src/theme";
import { toast } from "../src/toast";
import { installedVersion, REPOSITORY, useUpdates } from "../src/updates";
import { Avatar, Badge, Button, Card, goBack, IconButton, IconTile, linkText, ListGroup, ListRow, Screen, ScreenHeader, SectionHeader, type Segment, SegmentedControl, Sheet, Switch, Text, TextField, useLinkColor } from "../src/ui";

const APPEARANCE: readonly Segment<Appearance>[] = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dunkel" },
  { value: "light", label: "Hell" },
];

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

/** Version, what is new, download with progress, and the Play Protect note before Android's installer opens. */
function Updates() {
  const styles = useStyles();
  const { colors } = useTheme();
  const update = useUpdates();
  const installed = installedVersion();
  const release = update.release;
  const [explain, setExplain] = useState(false);
  const checked = update.checkedAt ? new Date(update.checkedAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : null;
  const offered = release !== null && updateOffered(release, installed);
  const percent = update.progress === null ? null : Math.round(update.progress * 100);

  const status =
    update.phase === "checking"
      ? "Sucht auf GitHub …"
      : update.phase === "downloading"
        ? percent === null
          ? "Lädt herunter …"
          : `Lädt herunter … ${percent} %`
        : update.phase === "verifying"
          ? "Prüft die Datei gegen die Prüfsumme von GitHub …"
          : update.phase === "ready" && release
            ? `Version ${release.version} ist geladen und geprüft.`
            : update.phase === "available" && release
              ? `Version ${release.version} ist verfügbar (${megabytes(release.size)}).`
              : update.phase === "current"
                ? `Aktuell${checked ? `, geprüft um ${checked}` : ""}.`
                : "Updates kommen von GitHub, wie bei NOVA am PC.";

  const start = () => {
    setExplain(false);
    const result = update.install();
    if (result === "permission") toast("Erlaube NOVA Companion, Apps zu installieren, und tippe dann noch einmal auf „Installieren“.", { durationMs: 6000 });
  };

  return (
    <Card style={styles.block}>
      <View style={styles.row}>
        <IconTile name="download" tint="cyan" />
        <View style={styles.fill}>
          <Text variant="headline">NOVA Companion {installed.version}</Text>
          <Text variant="footnote" accessibilityLiveRegion="polite">
            {status}
          </Text>
        </View>
      </View>

      {release?.notes && offered ? (
        <View style={styles.notes}>
          <Text variant="caption">Neu in {release.version}</Text>
          <Text variant="callout">{release.notes}</Text>
        </View>
      ) : null}

      {(update.phase === "downloading" || update.phase === "verifying") && (
        <View style={styles.track} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: percent ?? 0 }}>
          <View style={[styles.trackFill, { width: `${percent ?? 4}%`, backgroundColor: colors.accent }]} />
        </View>
      )}

      {update.error ? (
        <Text variant="footnote" tone="warning" accessibilityLiveRegion="polite">
          {update.error}
        </Text>
      ) : null}

      {update.phase === "available" && <Button label="Herunterladen" icon="download" onPress={() => void update.download()} />}
      {update.phase === "downloading" && <Button label="Abbrechen" kind="secondary" onPress={update.cancelDownload} />}
      {update.phase === "ready" && <Button label="Installieren" icon="check" onPress={() => setExplain(true)} />}
      {update.phase === "error" && offered && <Button label="Erneut laden" icon="refresh" onPress={() => void update.download()} />}
      {(update.phase === "idle" || update.phase === "current" || update.phase === "error" || update.phase === "checking") && (
        <Button label="Nach Updates suchen" kind="secondary" busy={update.phase === "checking"} icon="refresh" onPress={() => void update.check()} />
      )}

      <Sheet
        visible={explain}
        onClose={() => setExplain(false)}
        title="Gleich fragt Android"
        footer={
          <>
            <Button label="Verstanden, installieren" icon="check" onPress={start} />
            <Button label="Später" kind="ghost" onPress={() => setExplain(false)} />
          </>
        }
      >
        <PlayProtectSteps />
      </Sheet>
    </Card>
  );
}

export default function SettingsScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const pc = useCompanion((s) => s.pc);
  const pcName = useCompanion((s) => s.status?.pcName ?? s.pc?.pcName ?? "");
  const link = useCompanion((s) => s.link);
  const latency = useCompanion((s) => s.latency);
  const settings = useCompanion((s) => s.settings);
  const setSettings = useCompanion((s) => s.setSettings);
  const addHost = useCompanion((s) => s.addHost);
  const removeHost = useCompanion((s) => s.removeHost);
  const forget = useCompanion((s) => s.forget);
  const linkColor = useLinkColor(link);
  const { states, ask, openNotificationAccess, bridgeAvailable } = usePermissions();
  const [host, setHost] = useState("");
  const [hostError, setHostError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [unpairing, setUnpairing] = useState(false);
  const installed = installedVersion();

  const forwarding = settings.notifications || settings.calls;

  const add = async () => {
    if (await addHost(host)) {
      setHost("");
      haptic("success");
      toast("Adresse gespeichert", { tone: "success" });
    } else {
      setHostError("Das ist keine Adresse in deinem Heimnetz (z. B. 192.168.x.x oder 10.x.x.x).");
    }
  };

  const toggleApp = (app: string, on: boolean) => {
    const mutedApps = on ? settings.mutedApps.filter((each) => each !== app) : [...settings.mutedApps, app];
    void setSettings({ mutedApps });
  };

  return (
    <Screen>
      <KeyboardAvoidingView style={styles.fill} behavior="padding">
        <ScrollView contentContainerStyle={[styles.page, { paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.xxl }]} keyboardShouldPersistTaps="handled">
          <ScreenHeader title="Einstellungen" left={<IconButton icon="back" label="Zurück" onPress={goBack} />} />

          <SectionHeader title="Verbindung" />
          {pc ? (
            <>
              <Card style={styles.row}>
                <Avatar name={pcName} tint="cyan" size={44} />
                <View style={styles.fill}>
                  <Text variant="headline" numberOfLines={2}>
                    {pcName}
                  </Text>
                  <Text variant="footnote">Gekoppelter PC · Ende-zu-Ende verschlüsselt</Text>
                </View>
                <Badge label={link === "online" && latency !== null ? `${linkText(link)} · ${latency} ms` : linkText(link)} dot={linkColor} />
              </Card>
              <ListGroup>
                {pc.hosts.map((address, i) => (
                  <ListRow
                    key={address}
                    icon="link"
                    tint="slate"
                    title={address}
                    subtitle={i === 0 ? "Zuletzt erreicht" : "Weitere Adresse"}
                    onPress={pc.hosts.length > 1 ? () => setRemoving(address) : undefined}
                    last={i === pc.hosts.length - 1}
                  />
                ))}
              </ListGroup>
              <Card style={styles.block}>
                <TextField
                  label="PC-Adresse hinzufügen"
                  value={host}
                  onChangeText={(value) => {
                    setHost(value);
                    setHostError(null);
                  }}
                  placeholder="192.168.178.98"
                  keyboardType="numbers-and-punctuation"
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={21}
                  error={hostError}
                  helper="Steht am PC auf der Seite „Phone“. Nötig nur, wenn dein Handy den PC nicht von selbst findet."
                  onSubmitEditing={() => void add()}
                />
                <Button label="Hinzufügen" kind="secondary" size="sm" stretch={false} disabled={!host.trim()} onPress={() => void add()} />
              </Card>
            </>
          ) : (
            <Card>
              <Text variant="callout">Noch kein PC gekoppelt.</Text>
            </Card>
          )}
          <Card style={styles.block}>
            <Text variant="headline">Ohne WLAN verbinden</Text>
            <ConnectionHelp />
          </Card>

          <SectionHeader title="Weiterleitung" />
          <ListGroup>
            <ListRow
              icon="bell"
              tint="violet"
              title="Benachrichtigungen an den PC"
              subtitle="Erscheinen auf Nova Island, solange die Verbindung steht. Nichts wird gespeichert, weder hier noch am PC."
              toggle={{ value: settings.notifications, disabled: !bridgeAvailable, onChange: (notifications) => void setSettings({ notifications }) }}
              last={!forwarding}
            />
            {forwarding && (
              <ListRow
                icon="shield"
                tint={states.notificationAccess ? "green" : "amber"}
                title="Benachrichtigungszugriff"
                subtitle={states.notificationAccess ? "Erlaubt. Du kannst ihn in Android jederzeit entziehen." : "Fehlt. Öffnet Androids Einstellungen; wähle dort NOVA Companion."}
                right={<Badge label={states.notificationAccess ? "Erteilt" : "Fehlt"} tint={states.notificationAccess ? "green" : "amber"} />}
                onPress={openNotificationAccess}
                last
              />
            )}
          </ListGroup>
          {forwarding && !states.notificationAccess && (
            <Card>
              <RestrictedSettingsHint />
            </Card>
          )}
          {!bridgeAvailable && <Text variant="footnote">Nova Island braucht die installierte App ab Version 1.1 (nicht Expo Go).</Text>}
          {settings.notifications && (
            <Card style={styles.block}>
              <Text variant="headline">Je App</Text>
              {settings.seenApps.length === 0 ? (
                <Text variant="footnote">Apps erscheinen hier, sobald sie eine Benachrichtigung geschickt haben. Dann kannst du jede einzeln ausnehmen.</Text>
              ) : (
                settings.seenApps.map((app) => (
                  <View key={app.app} style={styles.app}>
                    <Avatar name={app.name} size={32} tint="slate" />
                    <Text style={styles.fill} numberOfLines={2}>
                      {app.name}
                    </Text>
                    <Switch label={`${app.name} an den PC weiterleiten`} value={!settings.mutedApps.includes(app.app)} onChange={(on) => toggleApp(app.app, on)} />
                  </View>
                ))
              )}
            </Card>
          )}

          <SectionHeader title="Anrufe" />
          <ListGroup>
            <ListRow
              icon="phone"
              tint="green"
              title="Anrufe an den PC"
              subtitle="Nova Island zeigt, wer anruft, mit Name und Bild aus der Anruf-Benachrichtigung."
              toggle={{ value: settings.calls, disabled: !bridgeAvailable, onChange: (calls) => void setSettings({ calls }) }}
            />
            <ListRow
              icon="check"
              tint={states.answerCalls ? "green" : "slate"}
              title="Am PC annehmen und auflegen"
              subtitle={
                states.answerCalls
                  ? "Erlaubt: NOVA Companion darf Anrufe selbst annehmen und beenden."
                  : "Geht ohne weitere Erlaubnis nur, wenn deine Telefon-App die Tasten selbst anbietet (Android 12 oder neuer, z. B. Google Telefon). Sonst zeigt der PC den Anruf nur an. Mit der Berechtigung „Anrufe verwalten“ geht es auf jedem Handy."
              }
              right={states.answerCalls ? <Badge label="Erteilt" tint="green" /> : undefined}
              onPress={states.answerCalls || !settings.calls ? undefined : () => void ask("answerCalls")}
              disabled={!settings.calls}
              last
            />
          </ListGroup>

          <SectionHeader title="Datenschutz" />
          <ListGroup>
            <ListRow
              icon="eyeOff"
              tint="slate"
              title="Nur App-Namen senden"
              subtitle="Der PC erfährt, dass WhatsApp etwas hat, aber nicht was."
              toggle={{ value: settings.onlyAppNames, disabled: !bridgeAvailable, onChange: (onlyAppNames) => void setSettings({ onlyAppNames }) }}
            />
            <ListRow
              icon="volumeOff"
              tint="slate"
              title="Stille Benachrichtigungen auslassen"
              subtitle="Was Android ohne Ton und Einblendung zeigt, bleibt auf dem Handy. Als geheim markierte Benachrichtigungen gehen nie an den PC."
              toggle={{ value: settings.skipSilent, disabled: !bridgeAvailable, onChange: (skipSilent) => void setSettings({ skipSilent }) }}
            />
            <ListRow
              icon="bell"
              tint="violet"
              title="Benachrichtigungen der App"
              subtitle="„Neue Freigabe“ und „Auftrag fertig“, immer ohne Inhalt."
              right={<Badge label={states.notifications ? "Erteilt" : "Fehlt"} tint={states.notifications ? "green" : "amber"} />}
              onPress={states.notifications ? undefined : () => void ask("notifications")}
            />
            <ListRow icon="lock" tint="green" title="Bleibt in deinem Heimnetz" subtitle="Jede Nachricht ist Ende-zu-Ende verschlüsselt. Die App hat kein Konto, keinen Server und sammelt keine Nutzungsdaten." last />
          </ListGroup>

          <SectionHeader title="Darstellung" />
          <Card style={styles.block}>
            <SegmentedControl label="Darstellung" options={APPEARANCE} value={settings.appearance} onChange={(appearance) => void setSettings({ appearance })} />
            <Text variant="footnote">„System“ folgt der Einstellung deines Handys.</Text>
          </Card>
          <ListGroup>
            <ListRow icon="vibrate" tint="slate" title="Haptik" subtitle="Kurzes Tippen unter dem Finger bei wichtigen Aktionen." toggle={{ value: settings.haptics, onChange: (haptics) => void setSettings({ haptics }) }} last />
          </ListGroup>

          <SectionHeader title="Updates" />
          <Updates />
          <ListGroup>
            <ListRow
              icon="refresh"
              tint="slate"
              title="Beim Start nach Updates suchen"
              subtitle="Fragt GitHub, ob es eine neue Version gibt. Sonst geht nichts dorthin."
              toggle={{ value: settings.checkUpdates, onChange: (checkUpdates) => void setSettings({ checkUpdates }) }}
              last
            />
          </ListGroup>

          <SectionHeader title="Über" />
          <ListGroup>
            <ListRow icon="sparkles" tint="violet" title="NOVA Companion" value={`${installed.version} (${installed.code})`} />
            <ListRow icon="link" tint="slate" title="Protokoll" value={`Version ${PROTOCOL_VERSION}`} />
            <ListRow icon="download" tint="slate" title="Quelle" subtitle={`github.com/${REPOSITORY}`} />
            <ListRow icon="shield" tint="cyan" title="Berechtigungen ansehen" subtitle="Was die App darf und wofür." onPress={() => router.push("/pair")} last={!pc} />
            {pc && <ListRow icon="trash" danger title="Kopplung aufheben" subtitle="Dein Handy vergisst diesen PC." onPress={() => setUnpairing(true)} last />}
          </ListGroup>
        </ScrollView>
      </KeyboardAvoidingView>

      <Sheet
        visible={removing !== null}
        onClose={() => setRemoving(null)}
        title="Adresse entfernen?"
        footer={
          <>
            <Button
              label="Entfernen"
              kind="danger"
              onPress={() => {
                if (removing) void removeHost(removing);
                setRemoving(null);
              }}
            />
            <Button label="Abbrechen" kind="ghost" onPress={() => setRemoving(null)} />
          </>
        }
      >
        <Text variant="callout">{removing} wird nicht mehr versucht. Findet dein Handy den PC unter dieser Adresse wieder, merkt es sie sich von selbst.</Text>
      </Sheet>

      <Sheet
        visible={unpairing}
        onClose={() => setUnpairing(false)}
        title="Kopplung aufheben?"
        footer={
          <>
            <Button
              label="Aufheben"
              kind="danger"
              onPress={() => {
                setUnpairing(false);
                void forget().then(() => router.replace("/pair"));
              }}
            />
            <Button label="Abbrechen" kind="ghost" onPress={() => setUnpairing(false)} />
          </>
        }
      >
        <Text variant="callout">Dein Handy vergisst diesen PC, den Chat und alle wartenden Aufträge. Entferne das Handy auch am PC auf der Seite „Phone“, damit es dort nicht gekoppelt bleibt.</Text>
        <View style={[styles.warn, { backgroundColor: colors.tints.amber.bg }]}>
          <Text variant="footnote">Zum Wiederverbinden brauchst du einen neuen Code vom PC.</Text>
        </View>
      </Sheet>
    </Screen>
  );
}

const useStyles = themed(({ colors }) => ({
  fill: { flex: 1 },
  page: { paddingHorizontal: space.page, gap: space.md },
  row: { flexDirection: "row", gap: space.md + 2, alignItems: "center" },
  block: { gap: space.md },
  notes: { gap: space.xs },
  track: { height: 6, borderRadius: radius.pill, backgroundColor: colors.surfaceStrong, overflow: "hidden" },
  trackFill: { height: 6, borderRadius: radius.pill },
  app: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 44 },
  warn: { borderRadius: radius.md, padding: space.md },
}));
