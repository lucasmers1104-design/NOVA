import { parseHostInput } from "@nova/companion-protocol/app";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { watchForNova } from "../src/discovery";
import { haptic } from "../src/haptics";
import { ConnectionHelp, RestrictedSettingsHint } from "../src/hints";
import { openAppSettings, usePermissions } from "../src/permissions";
import { failureText, useCompanion } from "../src/store";
import { fonts, radius, space, themed, type TintName, useTheme } from "../src/theme";
import { Badge, Button, Card, ErrorState, goBack, type IconName, IconTile, ListGroup, ListRow, Orb, Screen, Skeleton, Text, TextField } from "../src/ui";

const STEPS = ["Willkommen", "Verbinden", "Berechtigungen"] as const;
const FALLBACK_NAME = "Mein Handy";

/** Where the user is in the three steps: bars and "Schritt 2 von 3". */
function Progress({ step }: { step: number }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.progress} accessible accessibilityRole="progressbar" accessibilityLabel={`Schritt ${step + 1} von ${STEPS.length}: ${STEPS[step]}`} accessibilityValue={{ min: 1, max: STEPS.length, now: step + 1 }}>
      <View style={styles.bars}>
        {STEPS.map((name, i) => (
          <View key={name} style={[styles.bar, { backgroundColor: i <= step ? colors.accent : colors.surfaceHigh }]} />
        ))}
      </View>
      <Text variant="caption">
        Schritt {step + 1} von {STEPS.length} · {STEPS[step]}
      </Text>
    </View>
  );
}

function Point({ icon, tint, title, text }: { icon: IconName; tint: TintName; title: string; text: string }) {
  const styles = useStyles();
  return (
    <View style={styles.point}>
      <IconTile name={icon} tint={tint} size={38} />
      <View style={styles.fill}>
        <Text variant="headline">{title}</Text>
        <Text variant="footnote">{text}</Text>
      </View>
    </View>
  );
}

function Welcome({ onNext }: { onNext: () => void }) {
  const styles = useStyles();
  return (
    <>
      <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <Orb size={92} active />
          <Text variant="display" center accessibilityRole="header">
            NOVA auf dem Handy
          </Text>
          <Text variant="callout" center style={styles.lead}>
            Dein Handy wird zur Fernbedienung für NOVA auf deinem PC. Die KI und ihre Schlüssel bleiben dort.
          </Text>
        </View>
        <Card style={styles.points}>
          <Point icon="bolt" tint="violet" title="Aufträge schicken" text="Jetzt, später oder sobald dein PC an ist. NOVA antwortet im Chat, mit Screenshot, wenn du willst." />
          <Point icon="fingerprint" tint="green" title="Mit Fingerabdruck freigeben" text="Will NOVA etwas auf deinem PC ändern, fragt es hier. Ohne dich passiert nichts." />
          <Point icon="island" tint="cyan" title="Nova Island" text="Benachrichtigungen und Anrufe erscheinen oben auf deinem PC-Bildschirm, wenn du das einschaltest." />
          <Point icon="lock" tint="slate" title="Bleibt bei dir" text="Alles läuft Ende-zu-Ende verschlüsselt in deinem Heimnetz. Kein Konto, kein Server, keine Auswertung." />
        </Card>
      </ScrollView>
      <View style={styles.footer}>
        <Button label="Weiter" onPress={onNext} />
      </View>
    </>
  );
}

/** The four corners of the scan frame. */
function Corners() {
  const styles = useStyles();
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[styles.corner, { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 40 }]} />
      <View style={[styles.corner, { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 40 }]} />
      <View style={[styles.corner, { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 40 }]} />
      <View style={[styles.corner, { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 40 }]} />
      <View style={styles.scanLine} />
    </View>
  );
}

/** Whether a PC with NOVA announces itself on this network: "searching", then found or not. */
function useNovaNearby(): "searching" | "found" | "none" {
  const [state, setState] = useState<"searching" | "found" | "none">("searching");
  useEffect(() => {
    const stop = watchForNova(() => setState("found"));
    // mDNS answers within a second or two; after eight it won't any more.
    const timer = setTimeout(() => setState((now) => (now === "searching" ? "none" : now)), 8000);
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, []);
  return state;
}

function Connect({ onPaired }: { onPaired: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const pair = useCompanion((s) => s.pair);
  const finishPairing = useCompanion((s) => s.finishPairing);
  const pending = useCompanion((s) => s.pairingPending);
  const [permission, requestPermission] = useCameraPermissions();
  const nearby = useNovaNearby();
  const [name, setName] = useState(Device.deviceName ?? FALLBACK_NAME);
  const [host, setHost] = useState("");
  const [manual, setManual] = useState(false);
  const [phase, setPhase] = useState<"scan" | "waiting" | "error">("scan");
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);
  // The PC may answer up to two and a half minutes later; by then this screen can be gone.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const shownName = name.trim() || FALLBACK_NAME;
  const hostError = host.trim() && !parseHostInput(host) ? "Das ist keine Adresse in deinem Heimnetz (z. B. 192.168.x.x oder 10.x.x.x)." : null;

  const run = async (work: () => Promise<void>) => {
    setPhase("waiting");
    setError(null);
    try {
      await work();
      if (!mounted.current) return;
      haptic("success");
      onPaired();
    } catch (problem) {
      if (!mounted.current) return;
      haptic("error");
      setError(failureText(problem));
      setPhase("error");
    }
  };

  const scanned = (data: string) => {
    if (handled.current || hostError) return;
    handled.current = true;
    haptic("select");
    void run(() => pair(data, shownName, host.trim() || undefined));
  };

  const camera = () => {
    // Refused twice, Android shows no dialog any more: the app's settings page is the way then.
    if (permission && !permission.granted && !permission.canAskAgain) openAppSettings();
    else void requestPermission();
  };

  if (phase === "waiting") {
    return (
      <View style={styles.center}>
        <Orb size={88} active />
        <Text variant="title" center>
          Bestätige am PC
        </Text>
        <Text variant="callout" center>
          NOVA fragt dort, ob „{shownName}“ gekoppelt werden soll. Danach fragt dein Handy einmal nach deinem Fingerabdruck, um den Schlüssel für Freigaben zu sichern.
        </Text>
      </View>
    );
  }

  if (phase === "error") {
    return (
      <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
        <Card>
          <ErrorState
            title="Kopplung nicht abgeschlossen"
            text={error ?? "Etwas ist schiefgegangen."}
            retryLabel="Neu scannen"
            onRetry={() => {
              handled.current = false;
              setError(null);
              setPhase("scan");
            }}
          />
          {/* The PC already said yes; only the fingerprint is missing. No new code needed. */}
          {pending && <Button label="Fingerabdruck wiederholen" icon="fingerprint" onPress={() => void run(finishPairing)} />}
        </Card>
        <Card>
          <ConnectionHelp />
        </Card>
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.fill} behavior="padding">
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={styles.titleBlock}>
          <Text variant="display" accessibilityRole="header">
            Mit dem PC verbinden
          </Text>
          <Text variant="callout">Öffne in NOVA am PC unter Plugins „NOVA Companion“, schalte auf der Seite „Phone“ „Phone connection“ ein und klicke auf „Show code“.</Text>
        </View>

        <View style={styles.nearby} accessibilityLiveRegion="polite">
          {nearby === "searching" ? <Skeleton width={90} height={26} radius={radius.pill} /> : <Badge label={nearby === "found" ? "PC im Netzwerk gefunden" : "Noch kein PC gefunden"} dot={nearby === "found" ? colors.success : colors.warning} />}
          <Text variant="footnote" style={styles.fill}>
            {nearby === "searching" ? "Ich suche NOVA in deinem Netzwerk …" : nearby === "found" ? "NOVA ist erreichbar. Scanne jetzt den Code." : "Läuft NOVA, und ist „Phone connection“ an? Der Code funktioniert oft trotzdem."}
          </Text>
        </View>

        {permission?.granted ? (
          <View style={styles.camera}>
            <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={({ data }) => scanned(data)} />
            <Corners />
          </View>
        ) : (
          <Card style={styles.cameraAsk}>
            <IconTile name="camera" tint="violet" size={52} />
            <Text variant="callout" center>
              Zum Scannen braucht die App die Kamera. Sie wird nur für den Code benutzt.
            </Text>
            <Button label={permission && !permission.canAskAgain ? "In den Einstellungen erlauben" : "Kamera erlauben"} size="sm" stretch={false} onPress={camera} />
          </Card>
        )}
        <Text variant="footnote" center>
          Der Code gilt zwei Minuten und nur einmal.
        </Text>

        <TextField label="So heißt dein Handy am PC" value={name} onChangeText={setName} maxLength={60} autoCorrect={false} />

        {manual ? (
          <TextField
            label="PC-Adresse (optional)"
            value={host}
            onChangeText={setHost}
            placeholder="192.168.178.98"
            keyboardType="numbers-and-punctuation"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={21}
            error={hostError}
            helper="Steht am PC auf der Seite „Phone“. Die App versucht sie zusätzlich zu den Adressen im Code."
          />
        ) : (
          <Button label="PC-Adresse von Hand eingeben" icon="link" kind="ghost" size="sm" onPress={() => setManual(true)} />
        )}

        <Card>
          <ConnectionHelp />
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Permissions({ onDone }: { onDone: () => void }) {
  const styles = useStyles();
  const { states, ask, openNotificationAccess, bridgeAvailable } = usePermissions();
  const settings = useCompanion((s) => s.settings);
  const setSettings = useCompanion((s) => s.setSettings);
  const pcName = useCompanion((s) => s.pc?.pcName ?? "deinem PC");
  const granted = (ok: boolean) => <Badge label={ok ? "Erteilt" : "Fehlt"} tint={ok ? "green" : "amber"} />;

  return (
    <>
      <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
        <View style={styles.titleBlock}>
          <Text variant="display" accessibilityRole="header">
            Was die App darf
          </Text>
          <Text variant="callout">Gekoppelt mit {pcName}. Jede Berechtigung ist freiwillig und lässt sich später in den Einstellungen ändern.</Text>
        </View>

        <ListGroup>
          <ListRow
            icon="bell"
            tint="violet"
            title="Benachrichtigungen"
            subtitle="Damit du von einer neuen Freigabe erfährst (sie gilt nur zwei Minuten) und wenn ein Auftrag fertig ist. Ohne Inhalt auf dem Sperrbildschirm."
            right={granted(states.notifications)}
            onPress={states.notifications ? undefined : () => void ask("notifications")}
          />
          <ListRow
            icon="mic"
            tint="cyan"
            title="Mikrofon"
            subtitle="Zum Diktieren von Aufträgen. Die Spracherkennung macht dein Handy; an den PC geht nur der Text."
            right={granted(states.microphone)}
            onPress={states.microphone ? undefined : () => void ask("microphone")}
            last
          />
        </ListGroup>

        <Text variant="caption" style={styles.sectionTitle}>
          Nova Island (optional)
        </Text>
        <ListGroup>
          <ListRow
            icon="island"
            tint="violet"
            title="Benachrichtigungen an den PC"
            subtitle="Zeigt Benachrichtigungen deiner Apps oben am PC-Bildschirm. Nichts wird gespeichert."
            toggle={{ value: settings.notifications, disabled: !bridgeAvailable, onChange: (notifications) => void setSettings({ notifications }) }}
          />
          <ListRow
            icon="phone"
            tint="green"
            title="Anrufe an den PC"
            subtitle="Zeigt, wer anruft. Annehmen und Ablehnen geht am PC nur, wenn dein Handy es zulässt."
            toggle={{ value: settings.calls, disabled: !bridgeAvailable, onChange: (calls) => void setSettings({ calls }) }}
            last={!settings.notifications && !settings.calls}
          />
          {(settings.notifications || settings.calls) && (
            <ListRow
              icon="shield"
              tint={states.notificationAccess ? "green" : "amber"}
              title="Benachrichtigungszugriff"
              subtitle="Erlaubst du in Androids Einstellungen. Wähle dort NOVA Companion."
              right={granted(states.notificationAccess)}
              onPress={openNotificationAccess}
              last
            />
          )}
        </ListGroup>
        {(settings.notifications || settings.calls) && !states.notificationAccess && (
          <Card>
            <RestrictedSettingsHint />
          </Card>
        )}
        {!bridgeAvailable && <Text variant="footnote">Nova Island braucht die installierte App (nicht Expo Go).</Text>}
      </ScrollView>
      <View style={styles.footer}>
        <Button label="Fertig" icon="check" onPress={onDone} />
      </View>
    </>
  );
}

export default function PairScreen() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  // Opened while already paired (the app was closed between pairing and the last step): straight to the permissions.
  const paired = useCompanion((s) => s.pc !== null);
  const [step, setStep] = useState(paired ? 2 : 0);

  return (
    <Screen style={{ paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.md }}>
      <View style={styles.top}>
        <View style={styles.back}>{step === 1 && <Button label="Zurück" icon="back" kind="ghost" size="sm" stretch={false} onPress={() => setStep(0)} />}</View>
        <Progress step={step} />
      </View>
      {step === 0 && <Welcome onNext={() => setStep(1)} />}
      {step === 1 && <Connect onPaired={() => setStep(2)} />}
      {/* Back to where this was opened from (the settings), or on to the start screen after the first pairing. */}
      {step === 2 && <Permissions onDone={goBack} />}
    </Screen>
  );
}

const useStyles = themed(({ colors }) => ({
  fill: { flex: 1 },
  top: { paddingHorizontal: space.page, gap: space.xs, marginBottom: space.sm },
  back: { minHeight: 44, justifyContent: "center", marginLeft: -space.md },
  progress: { gap: space.sm },
  bars: { flexDirection: "row", gap: 6 },
  bar: { flex: 1, height: 4, borderRadius: radius.pill },
  page: { paddingHorizontal: space.page, paddingBottom: space.xl, gap: space.lg },
  hero: { alignItems: "center", gap: space.md, marginTop: space.lg },
  lead: { maxWidth: 330 },
  points: { gap: space.lg },
  point: { flexDirection: "row", gap: space.md, alignItems: "flex-start" },
  titleBlock: { gap: space.sm },
  nearby: { flexDirection: "row", alignItems: "center", gap: space.md },
  camera: { aspectRatio: 1, borderRadius: 40, overflow: "hidden", backgroundColor: "#000000" },
  corner: { position: "absolute", width: 58, height: 58, borderColor: "#FFFFFF" },
  scanLine: { position: "absolute", left: 30, right: 30, top: "47%", height: 2, borderRadius: 1, backgroundColor: colors.accentText, shadowColor: colors.accent, shadowOpacity: 1, shadowRadius: 10, shadowOffset: { width: 0, height: 0 }, elevation: 4 },
  cameraAsk: { gap: space.md, alignItems: "center", paddingVertical: space.xxl },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.md, paddingHorizontal: space.xxl },
  sectionTitle: { fontFamily: fonts.semibold, paddingHorizontal: space.xs },
  footer: { paddingHorizontal: space.page, paddingTop: space.sm },
}));
