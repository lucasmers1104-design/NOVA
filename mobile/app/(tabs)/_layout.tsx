import { Tabs } from "expo-router";
import { useEffect, useState } from "react";
import { liveApprovals } from "@nova/companion-protocol/state";
import { useCompanion } from "../../src/store";
import { colors } from "../../src/theme";
import { Icon } from "../../src/ui";

export default function TabsLayout() {
  const approvals = useCompanion((s) => s.approvals);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const open = liveApprovals(approvals, now).length;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.background },
        tabBarActiveTintColor: colors.text,
        tabBarInactiveTintColor: colors.subtle,
        tabBarStyle: { backgroundColor: "rgba(12,12,20,0.96)", borderTopColor: colors.rim, height: 64, paddingTop: 6 },
        tabBarLabelStyle: { fontSize: 11.5, fontWeight: "600" },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Start", tabBarIcon: ({ color }) => <Icon name="home" color={color} /> }} />
      <Tabs.Screen name="chat" options={{ title: "Chat", tabBarIcon: ({ color }) => <Icon name="chat" color={color} /> }} />
      <Tabs.Screen name="tasks" options={{ title: "Aufgaben", tabBarIcon: ({ color }) => <Icon name="tasks" color={color} /> }} />
      <Tabs.Screen
        name="approvals"
        options={{
          title: "Freigaben",
          tabBarIcon: ({ color }) => <Icon name="shield" color={color} />,
          tabBarBadge: open > 0 ? open : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.violet, color: colors.text },
        }}
      />
    </Tabs>
  );
}
