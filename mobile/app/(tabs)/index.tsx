import { liveApprovals } from "@nova/companion-protocol/state";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { RefreshControl, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { daySummary, greeting } from "../../src/logic";
import { useCompanion } from "../../src/store";
import { fonts, radius, space, TAB_BAR_ROOM, themed, type TintName, useTheme } from "../../src/theme";
import { toast } from "../../src/toast";
import { useUpdates } from "../../src/updates";
import { Badge, Card, Icon, IconButton, type IconName, IconTile, linkText, OfflineBanner, Orb, Press, ScreenHeader, SectionHeader, TabScene, Text, useLinkColor, useNow } from "../../src/ui";

const NOW = { kind: "now" } as const;

/** One tile in the "Schnell" grid. `note` says what to expect, e.g. that the PC will ask for an approval. */
function Action({ icon, tint, title, note, onPress, wide }: { icon: IconName; tint: TintName; title: string; note: string; onPress: () => void; wide: boolean }) {
  const styles = useStyles();
  return (
    <Press label={`${title}. ${note}`} onPress={onPress} containerStyle={wide ? styles.actionWide : styles.actionHalf} style={styles.action}>
      <IconTile name={icon} tint={tint} size={38} />
      <View style={styles.actionText}>
        <Text variant="headline">{title}</Text>
        <Text variant="footnote">{note}</Text>
      </View>
    </Press>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  const styles = useStyles();
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text variant="title">{value}</Text>
      <Text variant="footnote">{label}</Text>
    </View>
  );
}

export default function StartScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const pc = useCompanion((s) => s.pc);
  const link = useCompanion((s) => s.link);
  const status = useCompanion((s) => s.status);
  const latency = useCompanion((s) => s.latency);
  const approvals = useCompanion((s) => s.approvals);
  const offset = useCompanion((s) => s.clockOffset);
  const tasks = useCompanion((s) => s.tasks);
  const outbox = useCompanion((s) => s.outbox);
  const forwarding = useCompanion((s) => (s.settings.notifications ? 1 : 0) + (s.settings.calls ? 2 : 0));
  const send = useCompanion((s) => s.send);
  const refresh = useCompanion((s) => s.refresh);
  const update = useUpdates((s) => (s.phase === "available" || s.phase === "ready" ? s.release : null));
  const linkColor = useLinkColor(link);
  const now = useNow(5000);
  const [refreshing, setRefreshing] = useState(false);
  const today = useMemo(() => daySummary(tasks, outbox, new Date(now)), [tasks, outbox, now]);

  // The tabs only exist while a PC is paired (see _layout.tsx).
  if (!pc) return null;

  const online = link === "online";
  const approval = liveApprovals(approvals, now + offset)[0];
  // With a large system font two tiles side by side cut their text off: one per row then.
  const wide = fontScale > 1.3;
  const headline = !online ? (link === "connecting" ? "Ich suche deinen PC …" : "Dein PC ist gerade nicht erreichbar") : status?.busy ? "NOVA arbeitet gerade" : status?.inGame ? "Am PC läuft ein Spiel" : "NOVA ist bereit";

  /** A ready-made task: sent like a typed one, so it shows up in the chat with its answer. */
  const ask = (text: string, wantScreenshot = false) => {
    send(text, { schedule: NOW, wantScreenshot, voice: false });
    if (wantScreenshot) router.navigate("/chat");
    else toast(online ? "Auftrag an NOVA gesendet" : "Auftrag wartet, bis dein PC erreichbar ist", { tone: online ? "success" : "neutral", action: { label: "Chat", onPress: () => router.navigate("/chat") } });
  };

  const pull = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  return (
    <TabScene>
      <ScrollView
        contentContainerStyle={[styles.page, { paddingTop: insets.top + 18, paddingBottom: TAB_BAR_ROOM + insets.bottom }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void pull()} tintColor={colors.text} colors={[colors.accent]} progressBackgroundColor={colors.raised} />}
      >
        <ScreenHeader eyebrow={greeting(new Date(now))} title={status?.pcName ?? pc.pcName} right={<IconButton icon="settings" label="Einstellungen" onPress={() => router.push("/settings")} />} />

        <OfflineBanner />

        <Card accent style={styles.status}>
          <View style={styles.statusTop}>
            <Orb size={58} active={Boolean(online && status?.busy)} />
            <View style={styles.statusText}>
              <Badge label={linkText(link)} dot={linkColor} />
              <Text variant="title">{headline}</Text>
            </View>
          </View>
          {online && (
            <View style={styles.chips}>
              <View style={styles.secure} accessible accessibilityLabel="Ende-zu-Ende verschlüsselt">
                <Icon name="lock" size={13} color={colors.success} strokeWidth={2.2} />
                <Text variant="footnote" style={styles.secureText}>
                  Ende-zu-Ende verschlüsselt
                </Text>
              </View>
              {latency !== null && <Badge label={`${latency} ms`} />}
              {status && <Badge label={status.aiReady ? "KI bereit" : "Ohne KI"} dot={status.aiReady ? colors.success : colors.warning} />}
              {status?.inGame && <Badge label="Im Spiel" dot={colors.cyan} />}
              {status && status.activeTasks > 0 && <Badge label={status.activeTasks === 1 ? "1 Auftrag" : `${status.activeTasks} Aufträge`} dot={colors.accentText} />}
            </View>
          )}
          {online && status && !status.aiReady && <Text variant="footnote">Am PC ist kein KI-Schlüssel hinterlegt. NOVA versteht dann nur einfache Befehle wie „Öffne Spotify“.</Text>}
        </Card>

        {approval && (
          <Card danger={approval.risk === "high"} label={`Freigabe nötig: ${approval.title}`} onPress={() => router.push({ pathname: "/approval/[id]", params: { id: approval.requestId } })} style={styles.row}>
            <IconTile name="fingerprint" tint={approval.risk === "high" ? "red" : "violet"} />
            <View style={styles.rowText}>
              <Text variant="headline">Freigabe nötig</Text>
              <Text variant="footnote" numberOfLines={2}>
                {approval.title}
              </Text>
            </View>
            <Icon name="chevron" size={18} color={colors.subtle} />
          </Card>
        )}

        {update && (
          <Card label={`Version ${update.version} ist da`} onPress={() => router.push("/settings")} style={styles.row}>
            <IconTile name="download" tint="cyan" />
            <View style={styles.rowText}>
              <Text variant="headline">Version {update.version} ist da</Text>
              <Text variant="footnote">Tippe, um sie zu laden und zu installieren.</Text>
            </View>
            <Icon name="chevron" size={18} color={colors.subtle} />
          </Card>
        )}

        {online && status?.media && (
          <>
            <SectionHeader title="Läuft am PC" />
            <Card style={styles.media}>
              <View style={styles.row}>
                <IconTile name="music" tint="cyan" />
                <View style={styles.rowText}>
                  <Text variant="headline" numberOfLines={1}>
                    {status.media.title}
                  </Text>
                  <Text variant="footnote" numberOfLines={1}>
                    {status.media.artist || "Unbekannt"} · {status.media.playing ? "läuft" : "pausiert"}
                  </Text>
                </View>
              </View>
              <View style={styles.controls}>
                <IconButton icon="previous" label="Vorheriger Titel" onPress={() => ask("Spiel den vorherigen Titel.")} />
                <IconButton
                  icon={status.media.playing ? "pause" : "play"}
                  label={status.media.playing ? "Wiedergabe pausieren" : "Wiedergabe fortsetzen"}
                  tone="accent"
                  size={52}
                  onPress={() => ask(status.media?.playing ? "Pausiere die Wiedergabe." : "Setz die Wiedergabe fort.")}
                />
                <IconButton icon="next" label="Nächster Titel" onPress={() => ask("Spiel den nächsten Titel.")} />
              </View>
              <Text variant="footnote" center>
                Jede Taste schickt NOVA einen Auftrag; das dauert einen Moment.
              </Text>
            </Card>
          </>
        )}

        <SectionHeader title="Schnell" />
        <View style={styles.grid}>
          <Action wide={wide} icon="bolt" tint="violet" title="Auftrag" note="Jetzt, später oder sobald der PC an ist" onPress={() => router.push("/capture")} />
          <Action wide={wide} icon="mic" tint="cyan" title="Diktat" note="Sprich deinen Auftrag" onPress={() => router.push({ pathname: "/capture", params: { dictate: "1" } })} />
          <Action wide={wide} icon="image" tint="green" title="Bildschirm" note="Zeig mir, was am PC läuft" onPress={() => ask("Was ist gerade auf meinem Bildschirm zu sehen? Kurz zusammengefasst.", true)} />
          <Action wide={wide} icon="note" tint="amber" title="Notiz" note="Am PC speichern, mit Freigabe" onPress={() => router.push({ pathname: "/capture", params: { text: "Notiere: " } })} />
          <Action wide={wide} icon="lock" tint="slate" title="PC sperren" note="NOVA fragt nach deiner Freigabe" onPress={() => ask("Sperre meinen PC.")} />
          <Action wide={wide} icon="chat" tint="violet" title="Chat" note="Frag NOVA etwas" onPress={() => router.navigate("/chat")} />
        </View>

        <SectionHeader title="Heute" />
        <Card label="Aufgaben öffnen" onPress={() => router.navigate("/tasks")} style={styles.stats}>
          <Stat value={today.done} label="erledigt" />
          <View style={styles.divider} />
          <Stat value={today.open} label="offen" />
          <View style={styles.divider} />
          <Stat value={today.planned} label="geplant" />
        </Card>

        <SectionHeader title="Nova Island" />
        <Card label="Nova Island einrichten" onPress={() => router.push("/settings")} style={styles.row}>
          <IconTile name="island" tint="slate" />
          <View style={styles.rowText}>
            <Text variant="headline">Benachrichtigungen am PC</Text>
            <Text variant="footnote">
              {forwarding === 0
                ? "Zeig WhatsApp und Anrufe oben auf deinem PC-Bildschirm."
                : `${forwarding === 3 ? "Benachrichtigungen und Anrufe" : forwarding === 1 ? "Benachrichtigungen" : "Anrufe"} erscheinen auf Nova Island.`}
            </Text>
          </View>
          <Icon name="chevron" size={18} color={colors.subtle} />
        </Card>
      </ScrollView>
    </TabScene>
  );
}

const useStyles = themed(({ colors }) => ({
  page: { paddingHorizontal: space.page, gap: space.md + 2 },
  status: { gap: space.md + 2, padding: space.xl },
  statusTop: { flexDirection: "row", alignItems: "center", gap: space.lg },
  statusText: { flex: 1, gap: 6 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" },
  secure: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: colors.tints.green.bg },
  secureText: { fontFamily: fonts.semibold, color: colors.tints.green.fg },
  row: { flexDirection: "row", alignItems: "center", gap: space.md + 2 },
  rowText: { flex: 1, gap: 2 },
  media: { gap: space.md },
  controls: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.xl },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.md },
  // Two columns: half the row minus half the gap. The basis sits on the outer
  // pressable, the look on the inner view that scales under the finger.
  actionHalf: { flexBasis: "45%", flexGrow: 1 },
  actionWide: { flexBasis: "100%" },
  action: { flexGrow: 1, minHeight: 124, gap: space.md, padding: space.lg, borderRadius: 22, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderTopColor: colors.borderTop, justifyContent: "space-between" },
  actionText: { gap: 2 },
  stats: { flexDirection: "row", alignItems: "center", paddingVertical: space.lg },
  stat: { flex: 1, alignItems: "center", gap: 2 },
  divider: { width: 1, alignSelf: "stretch", backgroundColor: colors.border },
}));
