import { liveApprovals } from "@nova/companion-protocol/state";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { RefreshControl, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { daySummary, greeting } from "../../src/logic";
import { useCompanion } from "../../src/store";
import { CHROME_FONT_SCALE, fonts, radius, space, TAB_BAR_ROOM, themed, type TintName, TOUCH, useTheme } from "../../src/theme";
import { toast } from "../../src/toast";
import { useUpdates } from "../../src/updates";
import { Card, GlassSheen, Icon, IconButton, type IconName, IconTile, linkText, OfflineBanner, Orb, Press, ScreenHeader, SectionHeader, TabScene, Text, useLinkColor, useNow } from "../../src/ui";

const NOW = { kind: "now" } as const;

/** "Sonntag, 15. November" in German. */
function dateLine(date: Date): string {
  try {
    return date.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
  } catch {
    return "";
  }
}

/** One tile in the "Schnell" grid. `note` says what to expect, e.g. that the PC will ask for an approval. */
function Action({ icon, tint, title, note, onPress, wide }: { icon: IconName; tint: TintName; title: string; note: string; onPress: () => void; wide: boolean }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <Press label={`${title}. ${note}`} onPress={onPress} containerStyle={wide ? styles.actionWide : styles.actionHalf} style={styles.action}>
      <GlassSheen />
      <Icon name={icon} size={23} color={colors.tints[tint].fg} />
      <View style={styles.actionText}>
        <Text variant="headline">{title}</Text>
        <Text variant="footnote">{note}</Text>
      </View>
    </Press>
  );
}

/** A small figure in the PC card: "KI · bereit". */
function Fact({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return (
    <View style={styles.fact} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text variant="footnote" maxFontSizeMultiplier={CHROME_FONT_SCALE}>
        {label}
      </Text>
      <Text variant="bodyStrong" numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

/** How long an approval still stands, ticking each second: "1:42". */
function Countdown({ until }: { until: number }) {
  const offset = useCompanion((s) => s.clockOffset);
  const now = useNow(1000);
  const left = Math.max(0, Math.round((until - (now + offset)) / 1000));
  return <>{`${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}</>;
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
        <ScreenHeader eyebrow={dateLine(new Date(now))} title={greeting(new Date(now))} right={<IconButton icon="settings" label="Einstellungen" onPress={() => router.push("/settings")} />} />

        <OfflineBanner />

        <Card style={styles.status}>
          <View style={styles.statusTop}>
            <Orb size={50} active={Boolean(online && status?.busy)} />
            <View style={styles.statusText}>
              <Text variant="headline" style={styles.statusHeadline}>
                {headline}
              </Text>
              <View style={styles.statusLine}>
                <View style={[styles.liveDot, { backgroundColor: linkColor, shadowColor: linkColor }]} />
                <Text variant="footnote" numberOfLines={1} style={styles.statusLineText}>
                  {status?.pcName ?? pc.pcName} · {online && latency !== null ? `${latency} ms` : linkText(link)}
                </Text>
              </View>
            </View>
          </View>
          {online && status && (
            <View style={styles.facts}>
              <Fact label="Aufträge" value={status.activeTasks > 0 ? String(status.activeTasks) : "keine"} />
              <Fact label="KI" value={status.aiReady ? "bereit" : "aus"} />
              <Fact label="Läuft" value={status.inGame ? "ein Spiel" : status.media ? status.media.title : "nichts"} />
            </View>
          )}
          {online && (
            <View style={styles.secure} accessible accessibilityLabel="Ende-zu-Ende verschlüsselt">
              <Icon name="lock" size={13} color={colors.tints.green.fg} strokeWidth={2.2} />
              <Text variant="footnote" style={styles.secureText}>
                Ende-zu-Ende verschlüsselt
              </Text>
            </View>
          )}
          {online && status && !status.aiReady && <Text variant="footnote">Am PC ist kein KI-Schlüssel hinterlegt. NOVA versteht dann nur einfache Befehle wie „Öffne Spotify“.</Text>}
        </Card>

        {approval && (
          <Card
            warning={approval.risk !== "high"}
            danger={approval.risk === "high"}
            label={`Freigabe nötig: ${approval.title}`}
            onPress={() => router.push({ pathname: "/approval/[id]", params: { id: approval.requestId } })}
            style={styles.row}
          >
            <IconTile name="shield" tint={approval.risk === "high" ? "red" : "amber"} />
            <View style={styles.rowText}>
              <Text variant="footnote" style={[styles.approvalLabel, { color: colors.tints[approval.risk === "high" ? "red" : "amber"].fg }]}>
                Freigabe · noch <Countdown until={approval.expiresAt} />
              </Text>
              <Text variant="bodyStrong" numberOfLines={2}>
                {approval.title}
              </Text>
            </View>
            <View style={styles.approvalButton} pointerEvents="none">
              <Text variant="callout" style={styles.approvalButtonText}>
                Ansehen
              </Text>
            </View>
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
  status: { gap: space.lg, padding: space.xl },
  statusTop: { flexDirection: "row", alignItems: "center", gap: space.md + 2 },
  statusText: { flex: 1, gap: 3 },
  statusHeadline: { fontSize: 19, lineHeight: 24 },
  statusLine: { flexDirection: "row", alignItems: "center", gap: 7 },
  statusLineText: { flexShrink: 1 },
  liveDot: { width: 7, height: 7, borderRadius: 4, shadowOpacity: 0.9, shadowRadius: 6, shadowOffset: { width: 0, height: 0 }, elevation: 2 },
  facts: { flexDirection: "row", gap: space.sm },
  fact: { flex: 1, gap: 1, borderRadius: 16, paddingHorizontal: space.md, paddingVertical: 10, backgroundColor: colors.surfaceStrong },
  secure: { flexDirection: "row", alignItems: "center", gap: 6 },
  secureText: { color: colors.tints.green.fg },
  approvalLabel: { fontFamily: fonts.semibold },
  approvalButton: { minHeight: TOUCH, paddingHorizontal: space.lg, borderRadius: radius.pill, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  approvalButtonText: { fontFamily: fonts.semibold, color: colors.onPrimary },
  row: { flexDirection: "row", alignItems: "center", gap: space.md + 2 },
  rowText: { flex: 1, gap: 2 },
  media: { gap: space.md },
  controls: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.xl },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.md },
  // Two columns: half the row minus half the gap. The basis sits on the outer
  // pressable, the look on the inner view that scales under the finger.
  actionHalf: { flexBasis: "45%", flexGrow: 1 },
  actionWide: { flexBasis: "100%" },
  action: { flexGrow: 1, minHeight: 120, gap: space.lg, padding: space.lg, borderRadius: 24, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderTopColor: colors.borderTop, justifyContent: "space-between", overflow: "hidden" },
  actionText: { gap: 2 },
  stats: { flexDirection: "row", alignItems: "center", paddingVertical: space.lg },
  stat: { flex: 1, alignItems: "center", gap: 2 },
  divider: { width: 1, alignSelf: "stretch", backgroundColor: colors.border },
}));
