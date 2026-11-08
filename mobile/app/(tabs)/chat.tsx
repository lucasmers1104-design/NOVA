import type { ChatEntry } from "@nova/companion-protocol/state";
import { useRef, useState } from "react";
import { FlatList, Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useDictation } from "../../src/dictation";
import { useCompanion } from "../../src/store";
import { colors, radius, ui } from "../../src/theme";
import { Backdrop, Icon, Orb } from "../../src/ui";

const STATE_TEXT: Partial<Record<ChatEntry["state"], string>> = {
  sending: "Wartet auf deinen PC",
  queued: "Wartet, bis NOVA frei ist",
  scheduled: "Geplant",
  running: "NOVA arbeitet …",
  cancelled: "Abgebrochen",
  missed: "Verpasst, der PC war aus",
};

function NovaReply({ entry }: { entry: ChatEntry }) {
  const working = entry.state === "running" || entry.state === "queued" || entry.state === "sending" || entry.state === "scheduled";
  return (
    <View style={styles.novaRow}>
      <Orb size={28} active={entry.state === "running"} />
      <View style={[ui.glass, styles.novaBubble]}>
        {entry.steps.map((step) => (
          <View key={step.toolId} style={styles.step}>
            <Icon name={step.ok === false ? "x" : "check"} size={14} color={step.ok === undefined ? colors.subtle : step.ok ? colors.success : colors.danger} />
            <Text style={[ui.muted, { flex: 1, fontSize: 12.5 }]} numberOfLines={2}>
              {step.title}
              {step.tier === "approve" ? " · mit Freigabe" : ""}
            </Text>
          </View>
        ))}
        {entry.text ? <Text style={ui.body}>{entry.text}</Text> : null}
        {entry.screenshot && (
          <Image
            accessibilityLabel="Screenshot von deinem PC"
            source={{ uri: `data:${entry.screenshot.mime};base64,${entry.screenshot.data}` }}
            style={[styles.shot, { aspectRatio: entry.screenshot.width / entry.screenshot.height }]}
            resizeMode="contain"
          />
        )}
        {entry.error && <Text style={[ui.muted, { color: colors.danger }]}>{entry.error}</Text>}
        {working && !entry.text && <Text style={ui.muted}>{entry.activity ?? STATE_TEXT[entry.state]}</Text>}
        {!working && !entry.text && !entry.error && STATE_TEXT[entry.state] && <Text style={ui.muted}>{STATE_TEXT[entry.state]}</Text>}
      </View>
    </View>
  );
}

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const { chat, send, pc } = useCompanion();
  const [text, setText] = useState("");
  const [screenshot, setScreenshot] = useState(false);
  const spoken = useRef(false);
  const dictation = useDictation((heard, final) => {
    setText(heard);
    if (final) spoken.current = true;
  });

  const submit = () => {
    if (!text.trim()) return;
    send(text, { schedule: { kind: "now" }, wantScreenshot: screenshot, voice: spoken.current });
    setText("");
    spoken.current = false;
  };

  return (
    <KeyboardAvoidingView style={ui.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Backdrop />
      <FlatList
        data={[...chat].reverse()}
        inverted
        keyExtractor={(entry) => `${entry.taskId}:${entry.role}`}
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: insets.top + 16 }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={ui.muted}>{pc ? "Frag NOVA etwas, zum Beispiel: „Wie lange geht der Steam-Download noch?“" : "Kopple zuerst dein Handy mit deinem PC."}</Text>
          </View>
        }
        renderItem={({ item }) =>
          item.role === "user" ? (
            <View style={styles.userBubble}>
              <Text style={ui.body}>{item.text}</Text>
            </View>
          ) : (
            <NovaReply entry={item} />
          )
        }
      />
      <View style={[styles.composer, { paddingBottom: insets.bottom + 10 }]}>
        <View style={styles.options}>
          <Text style={ui.muted}>Screenshot mitschicken</Text>
          <Switch value={screenshot} onValueChange={setScreenshot} trackColor={{ true: colors.violet, false: colors.glassStrong }} accessibilityLabel="Screenshot mitschicken" />
        </View>
        {dictation.error && <Text style={[ui.muted, { color: colors.warning }]}>{dictation.error}</Text>}
        <View style={styles.inputRow}>
          <TextInput
            style={[ui.input, { flex: 1 }]}
            value={text}
            onChangeText={setText}
            placeholder={dictation.listening ? "Ich höre zu …" : "Auftrag an NOVA"}
            placeholderTextColor={colors.subtle}
            multiline
            maxLength={4000}
            editable={Boolean(pc)}
            accessibilityLabel="Auftrag an NOVA"
          />
          <Pressable accessibilityRole="button" accessibilityLabel="Senden" disabled={!text.trim() || !pc} onPress={submit} style={[styles.round, { opacity: text.trim() ? 1 : 0.4 }]}>
            <Icon name="send" size={20} />
          </Pressable>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={dictation.listening ? "Diktat beenden" : "Diktieren"}
          disabled={!pc}
          onPress={() => (dictation.listening ? dictation.stop() : void dictation.start())}
          style={[styles.mic, dictation.listening && { backgroundColor: colors.cyan }]}
        >
          <Icon name="mic" size={30} color={dictation.listening ? colors.background : colors.text} />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  empty: { padding: 24, transform: [{ scaleY: -1 }] },
  userBubble: { alignSelf: "flex-end", maxWidth: "85%", backgroundColor: "rgba(139,92,246,0.35)", borderRadius: radius.card, borderBottomRightRadius: 6, paddingHorizontal: 16, paddingVertical: 10 },
  novaRow: { flexDirection: "row", gap: 8, alignItems: "flex-start", maxWidth: "92%" },
  novaBubble: { flexShrink: 1, gap: 8, padding: 14, borderTopLeftRadius: 6 },
  step: { flexDirection: "row", gap: 6, alignItems: "center" },
  shot: { width: "100%", borderRadius: 12, backgroundColor: "#000" },
  composer: { paddingHorizontal: 16, paddingTop: 10, gap: 8, borderTopWidth: 1, borderTopColor: colors.rim, backgroundColor: "rgba(10,10,16,0.92)" },
  options: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  inputRow: { flexDirection: "row", gap: 10, alignItems: "flex-end" },
  round: { width: 46, height: 46, borderRadius: 23, backgroundColor: colors.violet, alignItems: "center", justifyContent: "center" },
  mic: { alignSelf: "center", width: 76, height: 76, borderRadius: 38, backgroundColor: colors.glassStrong, borderWidth: 1, borderColor: colors.rim, alignItems: "center", justifyContent: "center" },
});
