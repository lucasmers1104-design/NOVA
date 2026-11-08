import { liveApprovals } from "@nova/companion-protocol/state";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type Link, useCompanion } from "../../src/store";
import { colors, ui } from "../../src/theme";
import { Backdrop, Button, Dot, Glass, Icon, Orb } from "../../src/ui";

const LINK_TEXT: Record<Link, string> = {
  unpaired: "Noch nicht gekoppelt",
  connecting: "Verbinde mit deinem PC …",
  online: "Verbunden",
  offline: "Dein PC ist nicht erreichbar",
};

export default function StartScreen() {
  const insets = useSafeAreaInsets();
  const { pc, link, status, approvals, outbox, refresh, forget } = useCompanion();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const open = liveApprovals(approvals, now);

  if (!pc) {
    return (
      <View style={[ui.screen, { paddingTop: insets.top + 24 }]}>
        <Backdrop />
        <View style={styles.page}>
          <Orb size={72} />
          <Text style={[ui.title, { marginTop: 20 }]}>NOVA auf dem Handy</Text>
          <Text style={[ui.muted, { marginTop: 8, fontSize: 15, lineHeight: 22 }]}>
            Schick NOVA auf deinem PC Aufträge, frag nach dem Stand und gib Änderungen mit deinem Fingerabdruck frei. Die KI und ihre Schlüssel bleiben auf dem PC.
          </Text>
          <Glass style={{ marginTop: 28, gap: 8 }}>
            <Text style={ui.heading}>So koppelst du dein Handy</Text>
            <Text style={ui.muted}>1. Öffne NOVA auf deinem PC: Einstellungen → Phone.</Text>
            <Text style={ui.muted}>2. Schalte „Phone connection“ ein und tippe auf „Show code“.</Text>
            <Text style={ui.muted}>3. Scanne den Code und bestätige am PC.</Text>
          </Glass>
          <View style={{ marginTop: 24 }}>
            <Button label="Code scannen" icon={<Icon name="camera" size={18} />} onPress={() => router.push("/pair")} />
          </View>
        </View>
      </View>
    );
  }

  const linkColor = link === "online" ? colors.success : link === "connecting" ? colors.warning : colors.subtle;

  return (
    <View style={ui.screen}>
      <Backdrop />
      <ScrollView
        contentContainerStyle={[styles.page, { paddingTop: insets.top + 16, paddingBottom: 32 }]}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor={colors.text} />}
      >
        <View style={styles.header}>
          <Orb size={44} active={Boolean(status?.busy)} />
          <View style={{ flex: 1 }}>
            <Text style={ui.title}>{status?.pcName ?? pc.pcName}</Text>
            <View style={styles.row}>
              <Dot color={linkColor} />
              <Text style={ui.muted}>{LINK_TEXT[link]}</Text>
            </View>
          </View>
        </View>

        {link === "online" && status && (
          <Glass style={{ gap: 10 }}>
            <View style={styles.row}>
              <Icon name="monitor" size={18} color={colors.muted} />
              <Text style={ui.body}>{status.busy ? "NOVA arbeitet gerade" : status.inGame ? "Am PC läuft ein Spiel" : "NOVA ist bereit"}</Text>
            </View>
            {!status.aiReady && <Text style={ui.muted}>Am PC ist keine KI eingerichtet. NOVA öffnet trotzdem Apps und findet Dateien.</Text>}
            {status.activeTasks > 0 && <Text style={ui.muted}>{status.activeTasks === 1 ? "1 Auftrag wartet oder läuft" : `${status.activeTasks} Aufträge warten oder laufen`}</Text>}
          </Glass>
        )}
        {link !== "online" && outbox.length > 0 && (
          <Glass>
            <Text style={ui.body}>{outbox.length === 1 ? "1 Auftrag wartet, bis dein PC erreichbar ist" : `${outbox.length} Aufträge warten, bis dein PC erreichbar ist`}</Text>
          </Glass>
        )}

        {open[0] && (
          <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: "/approval/[id]", params: { id: open[0]!.requestId } })}>
            <Glass style={[styles.approval, { borderColor: colors.violet }]}>
              <Icon name="fingerprint" color={colors.violet} />
              <View style={{ flex: 1 }}>
                <Text style={ui.heading}>Freigabe nötig</Text>
                <Text style={ui.muted} numberOfLines={2}>
                  {open[0].title}
                </Text>
              </View>
            </Glass>
          </Pressable>
        )}

        {status?.media && (
          <Glass style={styles.approval}>
            <Icon name="music" color={colors.cyan} />
            <View style={{ flex: 1 }}>
              <Text style={ui.heading} numberOfLines={1}>
                {status.media.title}
              </Text>
              <Text style={ui.muted} numberOfLines={1}>
                {status.media.artist || "Unbekannt"} · {status.media.playing ? "läuft" : "pausiert"}
              </Text>
            </View>
          </Glass>
        )}

        <Button label="Schnell erfassen" icon={<Icon name="plus" size={18} />} onPress={() => router.push("/capture")} />
        <Button label="Chat öffnen" kind="secondary" icon={<Icon name="chat" size={18} />} onPress={() => router.push("/chat")} />

        <View style={{ marginTop: 24 }}>
          <Button
            label="Kopplung aufheben"
            kind="ghost"
            onPress={() =>
              Alert.alert("Kopplung aufheben?", "Dein Handy vergisst diesen PC. Am PC kannst du es unter Einstellungen → Phone ebenfalls entfernen.", [
                { text: "Abbrechen", style: "cancel" },
                { text: "Aufheben", style: "destructive", onPress: () => void forget() },
              ])
            }
          />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 20, gap: 14 },
  header: { flexDirection: "row", alignItems: "center", gap: 14, marginBottom: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 2 },
  approval: { flexDirection: "row", alignItems: "center", gap: 14 },
});
