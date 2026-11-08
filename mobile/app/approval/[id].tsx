import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCompanion } from "../../src/store";
import { colors, radius, ui } from "../../src/theme";
import { Backdrop, Button, Glass, Icon } from "../../src/ui";

const RISK = { safe: "Geringes Risiko", confirm: "Ändert etwas auf deinem PC", high: "Schwer rückgängig zu machen" } as const;

export default function ApprovalScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { approvals, approve, decline } = useCompanion();
  const request = approvals.find((a) => a.requestId === id);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const left = request ? Math.max(0, Math.round((request.expiresAt - now) / 1000)) : 0;

  return (
    <View style={[ui.screen, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 20 }]}>
      <Backdrop />
      <View style={styles.page}>
        <Icon name="shield" size={36} color={colors.violet} />
        <Text style={ui.title}>Freigabe</Text>
        {!request || left === 0 ? (
          <>
            <Text style={ui.muted}>Diese Freigabe ist nicht mehr offen. Sie wurde beantwortet oder ist abgelaufen.</Text>
            <Button label="Zurück" kind="secondary" onPress={() => router.back()} />
          </>
        ) : (
          <>
            <Glass style={{ gap: 10 }}>
              <Text style={[ui.heading, { fontSize: 19 }]}>{request.title}</Text>
              {request.detail && <Text style={ui.body}>{request.detail}</Text>}
              <View style={[styles.badge, request.risk === "high" && { backgroundColor: "rgba(248,113,113,0.16)" }]}>
                <Text style={[ui.muted, request.risk === "high" && { color: colors.danger }]}>{RISK[request.risk]}</Text>
              </View>
            </Glass>
            <Text style={ui.muted}>Läuft in {left} Sekunden ab. NOVA tut nichts, bis du freigibst.</Text>
            {error && <Text style={[ui.muted, { color: colors.warning }]}>{error}</Text>}
            <View style={{ gap: 10, marginTop: "auto" }}>
              <Button
                label="Mit Fingerabdruck freigeben"
                icon={<Icon name="fingerprint" size={20} />}
                busy={busy}
                onPress={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await approve(request);
                    router.back();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Die Freigabe hat nicht geklappt.");
                  } finally {
                    setBusy(false);
                  }
                }}
              />
              <Button
                label="Ablehnen"
                kind="danger"
                disabled={busy}
                onPress={() => {
                  decline(request);
                  router.back();
                }}
              />
            </View>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: 20, gap: 16 },
  badge: { alignSelf: "flex-start", backgroundColor: colors.glassStrong, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 4 },
});
