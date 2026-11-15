import type { TaskState } from "@nova/companion-protocol";
import { router } from "expo-router";
import { memo, useCallback, useMemo, useState } from "react";
import { FlatList, RefreshControl, View } from "react-native";
import ReanimatedSwipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, { FadeIn, useReducedMotion, ZoomIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { haptic } from "../../src/haptics";
import { type TaskRow, taskRows } from "../../src/logic";
import { useCompanion } from "../../src/store";
import { motion, radius, space, TAB_BAR_ROOM, themed, type TintName, useTheme } from "../../src/theme";
import { toast } from "../../src/toast";
import { Badge, Card, EmptyState, Icon, IconButton, type IconName, IconTile, OfflineBanner, ScreenHeader, SkeletonScreen, TabScene, Text, useNow } from "../../src/ui";

const STATE: Record<TaskState | "outbox", { label: string; icon: IconName; tint: TintName }> = {
  outbox: { label: "Wartet auf deinen PC", icon: "clock", tint: "amber" },
  queued: { label: "Wartet", icon: "clock", tint: "amber" },
  scheduled: { label: "Geplant", icon: "clock", tint: "violet" },
  running: { label: "Läuft", icon: "bolt", tint: "cyan" },
  done: { label: "Erledigt", icon: "check", tint: "green" },
  failed: { label: "Nicht erledigt", icon: "x", tint: "red" },
  cancelled: { label: "Abgebrochen", icon: "x", tint: "slate" },
  missed: { label: "Verpasst", icon: "x", tint: "slate" },
};

/**
 * What swiping (or the button) does to a row: cancel what is still to come or running,
 * hide what is over. Hiding is this phone's business only; the PC keeps its log.
 */
function removal(row: TaskRow): { label: string; icon: IconName } {
  return row.cancellable ? { label: "Abbrechen", icon: "x" } : { label: "Ausblenden", icon: "eyeOff" };
}

const Row = memo(function Row({ row, onRemove }: { row: TaskRow; onRemove: (row: TaskRow) => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const state = STATE[row.state];
  const action = removal(row);
  const card = (
    <Card style={styles.card}>
      {/* Keyed by state: when a task flips to "Erledigt" its check mark pops in. */}
      <Animated.View key={row.state} entering={reduced ? undefined : ZoomIn.duration(motion.base)}>
        <IconTile name={state.icon} tint={state.tint} size={36} />
      </Animated.View>
      <View style={styles.body}>
        <Text numberOfLines={4}>{row.text}</Text>
        <View style={styles.meta}>
          <Badge label={state.label} tint={state.tint} />
          {row.when ? <Text variant="footnote">{row.when}</Text> : null}
        </View>
      </View>
      <IconButton icon={action.icon} label={`${action.label}: ${row.text}`} tone="plain" onPress={() => onRemove(row)} />
    </Card>
  );
  return (
    <ReanimatedSwipeable
      friction={2}
      rightThreshold={64}
      overshootRight={false}
      onSwipeableOpen={() => onRemove(row)}
      renderRightActions={() => (
        <View style={[styles.swipe, { backgroundColor: row.cancellable ? colors.tints.red.bg : colors.surfaceStrong }]}>
          <Icon name={action.icon} size={20} color={row.cancellable ? colors.danger : colors.muted} />
          <Text variant="footnote" tone={row.cancellable ? "danger" : "muted"}>
            {action.label}
          </Text>
        </View>
      )}
    >
      {card}
    </ReanimatedSwipeable>
  );
});

export default function TasksScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const tasks = useCompanion((s) => s.tasks);
  const outbox = useCompanion((s) => s.outbox);
  const hidden = useCompanion((s) => s.hiddenTasks);
  const link = useCompanion((s) => s.link);
  const refresh = useCompanion((s) => s.refresh);
  const now = useNow(60_000);
  const [refreshing, setRefreshing] = useState(false);
  // Rows taken away while their toast still offers "Rückgängig".
  const [leaving, setLeaving] = useState<readonly string[]>([]);

  const rows = useMemo(() => taskRows(tasks, outbox, hidden, new Date(now)).filter((row) => !leaving.includes(row.taskId)), [tasks, outbox, hidden, now, leaving]);

  const remove = useCallback((row: TaskRow) => {
    const back = () => setLeaving((ids) => ids.filter((id) => id !== row.taskId));
    haptic("select");
    setLeaving((ids) => [...ids, row.taskId]);
    toast(row.cancellable ? "Auftrag abgebrochen" : "Auftrag ausgeblendet", {
      action: { label: "Rückgängig", onPress: back },
      // Only now does it become real: until the toast is gone, nothing was sent to the PC.
      onExpire: () => {
        const store = useCompanion.getState();
        if (!row.cancellable) store.hideTask(row.taskId);
        else if (!store.cancel(row.taskId)) toast("Dein PC ist nicht erreichbar. Der Auftrag bleibt bestehen.", { tone: "warning" });
        back();
      },
    });
  }, []);

  const pull = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  return (
    <TabScene>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.taskId}
        contentContainerStyle={[styles.page, { paddingTop: insets.top + 18, paddingBottom: TAB_BAR_ROOM + insets.bottom }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void pull()} tintColor={colors.text} colors={[colors.accent]} progressBackgroundColor={colors.raised} />}
        ListHeaderComponent={
          <View style={styles.head}>
            <ScreenHeader eyebrow="Von deinem Handy" title="Aufgaben" right={<IconButton icon="plus" label="Neuer Auftrag" onPress={() => router.push("/capture")} />} />
            <OfflineBanner />
          </View>
        }
        ListEmptyComponent={
          // Nothing saved and the first answer still on its way: shapes, not "Nichts geplant".
          link === "connecting" && tasks.length === 0 ? (
            <SkeletonScreen rows={3} />
          ) : (
            <EmptyState
              icon="tasks"
              title="Nichts geplant"
              text="Aufträge für später oder „sobald der PC an ist“ erscheinen hier, bis NOVA sie erledigt hat."
              action={{ label: "Neuer Auftrag", icon: "plus", onPress: () => router.push("/capture") }}
            />
          )
        }
        renderItem={({ item }) => (
          <Animated.View entering={reduced ? undefined : FadeIn.duration(motion.base)}>
            <Row row={item} onRemove={remove} />
          </Animated.View>
        )}
      />
    </TabScene>
  );
}

const useStyles = themed(() => ({
  page: { paddingHorizontal: space.page, gap: space.md },
  head: { gap: space.md },
  card: { flexDirection: "row", alignItems: "flex-start", gap: space.md, padding: space.lg, paddingRight: space.sm },
  body: { flex: 1, gap: space.sm },
  meta: { flexDirection: "row", alignItems: "center", gap: space.sm + 2, flexWrap: "wrap" },
  swipe: { width: 104, marginLeft: space.sm, borderRadius: radius.xl, alignItems: "center", justifyContent: "center", gap: 4 },
}));
