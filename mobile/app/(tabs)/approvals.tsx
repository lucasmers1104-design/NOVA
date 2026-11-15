import type { ApprovalRequest } from "@nova/companion-protocol";
import { liveApprovals } from "@nova/companion-protocol/state";
import { router } from "expo-router";
import { FlatList, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RISK } from "../../src/risk";
import { useCompanion } from "../../src/store";
import { space, TAB_BAR_ROOM, themed, useTheme } from "../../src/theme";
import { Badge, Card, EmptyState, Icon, IconTile, OfflineBanner, ScreenHeader, TabScene, Text, useNow } from "../../src/ui";

function ApprovalCard({ request, now }: { request: ApprovalRequest; now: number }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const risk = RISK[request.risk];
  const left = Math.max(0, Math.round((request.expiresAt - now) / 1000));
  return (
    <Card
      warning={request.risk !== "high"}
      danger={request.risk === "high"}
      label={`${request.title}. ${risk.short}. Noch ${left} Sekunden.`}
      onPress={() => router.push({ pathname: "/approval/[id]", params: { id: request.requestId } })}
      style={styles.card}
    >
      <IconTile name="fingerprint" tint={risk.tint} />
      <View style={styles.body}>
        <Text variant="headline" numberOfLines={3}>
          {request.title}
        </Text>
        <View style={styles.meta}>
          <Badge label={risk.short} tint={risk.tint} />
          <Text variant="footnote" tone={left < 30 ? "warning" : "muted"}>
            noch {left} s
          </Text>
        </View>
      </View>
      <Icon name="chevron" size={18} color={colors.subtle} />
    </Card>
  );
}

export default function ApprovalsScreen() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const approvals = useCompanion((s) => s.approvals);
  const offset = useCompanion((s) => s.clockOffset);
  // The PC's clock decides when an approval expires, so the countdown runs on it too.
  const now = useNow(1000) + offset;
  const open = liveApprovals(approvals, now);

  return (
    <TabScene>
      <FlatList
        data={open}
        keyExtractor={(item) => item.requestId}
        contentContainerStyle={[styles.page, { paddingTop: insets.top + 18, paddingBottom: TAB_BAR_ROOM + insets.bottom }]}
        ListHeaderComponent={
          <View style={styles.head}>
            <ScreenHeader eyebrow="Mit Fingerabdruck" title="Freigaben" />
            <OfflineBanner />
          </View>
        }
        ListEmptyComponent={<EmptyState icon="shield" title="Nichts freizugeben" text="Wenn NOVA für einen Auftrag etwas auf deinem PC ändern will, fragt es hier. Ohne dich passiert nichts." />}
        renderItem={({ item }) => <ApprovalCard request={item} now={now} />}
      />
    </TabScene>
  );
}

const useStyles = themed(() => ({
  page: { paddingHorizontal: space.page, gap: space.md },
  head: { gap: space.md },
  card: { flexDirection: "row", gap: space.md + 2, alignItems: "center" },
  body: { flex: 1, gap: space.sm },
  meta: { flexDirection: "row", alignItems: "center", gap: space.sm + 2, flexWrap: "wrap" },
}));
