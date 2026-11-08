import { scheduleText } from "@nova/companion-protocol/state";
import type { TaskState } from "@nova/companion-protocol";
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCompanion } from "../../src/store";
import { colors, ui } from "../../src/theme";
import { Backdrop, Button, Glass } from "../../src/ui";

const STATE: Record<TaskState, string> = {
  queued: "Wartet",
  scheduled: "Geplant",
  running: "Läuft",
  done: "Erledigt",
  failed: "Nicht erledigt",
  cancelled: "Abgebrochen",
  missed: "Verpasst",
};

function day(offset: number) {
  const date = new Date(Date.now() + offset * 86_400_000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export default function TasksScreen() {
  const insets = useSafeAreaInsets();
  const { tasks, outbox, cancel, refresh } = useCompanion();
  const waiting = outbox.map((task) => ({ taskId: task.id, text: task.text, label: "Wartet auf deinen PC", when: scheduleText(task.schedule, day(0), day(1)), cancellable: true }));
  const known = tasks.map((task) => {
    const at = task.runAt?.split(" ");
    const when = at?.[0] && at[1] ? scheduleText({ kind: "at", date: at[0], time: at[1] }, day(0), day(1)) : null;
    return { taskId: task.taskId, text: task.text, label: STATE[task.state], when, cancellable: task.state === "queued" || task.state === "scheduled" };
  });
  const items = [...waiting, ...known.filter((k) => !waiting.some((w) => w.taskId === k.taskId))];

  return (
    <View style={ui.screen}>
      <Backdrop />
      <FlatList
        data={items}
        keyExtractor={(item) => item.taskId}
        contentContainerStyle={{ padding: 20, paddingTop: insets.top + 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor={colors.text} />}
        ListHeaderComponent={<Text style={[ui.title, { marginBottom: 6 }]}>Aufgaben</Text>}
        ListEmptyComponent={<Text style={ui.muted}>Hier siehst du geplante und wartende Aufträge, sobald du welche hast.</Text>}
        renderItem={({ item }) => (
          <Glass style={{ gap: 6 }}>
            <Text style={ui.body} numberOfLines={3}>
              {item.text}
            </Text>
            <View style={styles.row}>
              <Text style={ui.muted}>{[item.label, item.when].filter(Boolean).join(" · ")}</Text>
              {item.cancellable && <Button label="Abbrechen" kind="ghost" onPress={() => cancel(item.taskId)} />}
            </View>
          </Glass>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
});
