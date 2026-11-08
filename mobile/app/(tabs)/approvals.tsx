import { liveApprovals } from "@nova/companion-protocol/state";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useCompanion } from "../../src/store";
import { colors, ui } from "../../src/theme";
import { Backdrop, Glass, Icon } from "../../src/ui";

export default function ApprovalsScreen() {
  const insets = useSafeAreaInsets();
  const approvals = useCompanion((s) => s.approvals);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const open = liveApprovals(approvals, now);

  return (
    <View style={ui.screen}>
      <Backdrop />
      <FlatList
        data={open}
        keyExtractor={(item) => item.requestId}
        contentContainerStyle={{ padding: 20, paddingTop: insets.top + 16, gap: 12 }}
        ListHeaderComponent={<Text style={[ui.title, { marginBottom: 6 }]}>Freigaben</Text>}
        ListEmptyComponent={<Text style={ui.muted}>Keine offenen Freigaben. Wenn NOVA für einen Auftrag etwas auf deinem PC ändern will, fragt es hier.</Text>}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: "/approval/[id]", params: { id: item.requestId } })}>
            <Glass style={{ flexDirection: "row", gap: 14, alignItems: "center" }}>
              <Icon name="fingerprint" color={item.risk === "high" ? colors.danger : colors.violet} />
              <View style={{ flex: 1 }}>
                <Text style={ui.heading} numberOfLines={2}>
                  {item.title}
                </Text>
                <Text style={ui.muted}>Noch {Math.max(0, Math.round((item.expiresAt - now) / 1000))} Sekunden</Text>
              </View>
            </Glass>
          </Pressable>
        )}
      />
    </View>
  );
}
