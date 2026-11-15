import * as LocalAuthentication from "expo-local-authentication";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { haptic } from "../../src/haptics";
import { RISK } from "../../src/risk";
import { useCompanion } from "../../src/store";
import { radius, space, themed, useTheme } from "../../src/theme";
import { toast } from "../../src/toast";
import { Button, Card, EmptyState, goBack, Icon, IconButton, OfflineBanner, Screen, Text, useNow } from "../../src/ui";

/** The PC gives every approval two minutes (tasks.rs, APPROVAL_LIFETIME_MS). */
const LIFETIME_S = 120;

/** Says "Fingerabdruck" only on a phone that has a fingerprint reader. */
function useBiometricWord(): string {
  const [word, setWord] = useState("Fingerabdruck");
  useEffect(() => {
    LocalAuthentication.supportedAuthenticationTypesAsync()
      .then((types) => {
        if (!types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT) && types.length) setWord("Gesichtserkennung");
      })
      .catch(() => {});
  }, []);
  return word;
}

export default function ApprovalScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const open = useCompanion((s) => s.approvals.find((a) => a.requestId === id));
  const offset = useCompanion((s) => s.clockOffset);
  const online = useCompanion((s) => s.link === "online");
  const approve = useCompanion((s) => s.approve);
  const decline = useCompanion((s) => s.decline);
  const biometric = useBiometricWord();
  const now = useNow(1000) + offset;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The PC's confirmation removes the approval from the list a moment before this
  // screen closes. While an answer is on its way the request stays on screen, so
  // "Nicht mehr offen" doesn't flash up after a successful approval.
  const last = useRef(open);
  if (open) last.current = open;
  const request = busy ? last.current : open;

  const left = request ? Math.max(0, Math.round((request.expiresAt - now) / 1000)) : 0;

  if (!request || (left === 0 && !busy)) {
    return (
      <Screen style={{ paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.xl }}>
        <View style={styles.gone}>
          <EmptyState icon="shield" title="Nicht mehr offen" text="Diese Freigabe wurde beantwortet oder ist abgelaufen. NOVA hat nichts getan, was du nicht freigegeben hast." />
          <Button label="Schließen" kind="secondary" onPress={goBack} />
        </View>
      </Screen>
    );
  }

  const risk = RISK[request.risk];
  const tint = colors.tints[risk.tint];

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await approve(request);
      haptic("success");
      toast("Freigegeben", { tone: "success" });
      goBack();
    } catch (problem) {
      haptic("error");
      setError(problem instanceof Error ? problem.message : "Die Freigabe hat nicht geklappt.");
    } finally {
      setBusy(false);
    }
  };

  const refuse = () => {
    if (!decline(request)) {
      setError("Dein PC ist nicht erreichbar. Ohne deine Antwort verfällt die Freigabe von selbst, NOVA tut dann nichts.");
      return;
    }
    haptic("select");
    toast("Abgelehnt");
    goBack();
  };

  return (
    <Screen style={{ paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.lg }}>
      <View style={styles.bar}>
        <IconButton icon="x" label="Schließen, ohne zu antworten" onPress={goBack} />
      </View>
      <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <View style={[styles.mark, { backgroundColor: tint.bg, borderColor: tint.bg }]}>
            <Icon name="fingerprint" size={40} color={tint.fg} />
          </View>
          <Text variant="footnote" center>
            NOVA möchte auf deinem PC
          </Text>
          <Text variant="title" center accessibilityRole="header">
            {request.title}
          </Text>
        </View>

        <Card danger={request.risk === "high"} style={styles.card}>
          <View style={styles.riskTop}>
            <Icon name={risk.icon} size={20} color={tint.fg} />
            <Text variant="headline" style={[styles.fill, { color: tint.fg }]}>
              {risk.title}
            </Text>
            {/* Three bars, as many filled as the level: readable without colour. */}
            <View style={styles.meter} accessible accessibilityLabel={`Gefahrenstufe ${risk.level} von 3`}>
              {[1, 2, 3].map((step) => (
                <View key={step} style={[styles.meterBar, { backgroundColor: step <= risk.level ? tint.fg : colors.surfaceHigh }]} />
              ))}
            </View>
          </View>
          <Text variant="callout">{risk.text}</Text>
        </Card>

        {request.detail ? (
          <Card style={styles.card}>
            <Text variant="caption">Im Einzelnen</Text>
            <Text>{request.detail}</Text>
          </Card>
        ) : null}

        <View style={styles.timer}>
          <View style={styles.track}>
            <View style={[styles.fillBar, { width: `${Math.min(100, (left / LIFETIME_S) * 100)}%`, backgroundColor: left < 30 ? colors.warning : colors.accent }]} />
          </View>
          <Text variant="footnote" tone={left < 30 ? "warning" : "muted"} accessibilityLiveRegion="none">
            Läuft in {left} Sekunden ab. Bis dahin tut NOVA nichts.
          </Text>
        </View>

        {!online && <OfflineBanner />}
        {error ? (
          <Text variant="callout" tone="warning" accessibilityLiveRegion="assertive">
            {error}
          </Text>
        ) : null}
      </ScrollView>
      <View style={styles.footer}>
        <Button label={`Mit ${biometric} freigeben`} icon="fingerprint" busy={busy} disabled={!online} haptic={false} onPress={() => void confirm()} />
        <Button label="Ablehnen" kind="danger" disabled={busy} haptic={false} onPress={refuse} />
      </View>
    </Screen>
  );
}

const useStyles = themed(({ colors }) => ({
  fill: { flex: 1 },
  gone: { flex: 1, paddingHorizontal: space.page, justifyContent: "center", gap: space.lg },
  bar: { paddingHorizontal: space.page, alignItems: "flex-end" },
  page: { paddingHorizontal: space.page, paddingBottom: space.lg, gap: space.lg },
  hero: { alignItems: "center", gap: space.sm },
  mark: { width: 88, height: 88, borderRadius: 30, alignItems: "center", justifyContent: "center", borderWidth: 1, marginBottom: space.sm },
  card: { gap: space.sm + 2 },
  riskTop: { flexDirection: "row", alignItems: "center", gap: space.sm + 2 },
  meter: { flexDirection: "row", gap: 4 },
  meterBar: { width: 14, height: 6, borderRadius: radius.pill },
  timer: { gap: 6 },
  track: { height: 6, borderRadius: radius.pill, backgroundColor: colors.surfaceStrong, overflow: "hidden" },
  fillBar: { height: 6, borderRadius: radius.pill },
  footer: { paddingHorizontal: space.page, paddingTop: space.sm, gap: space.sm + 2 },
}));
