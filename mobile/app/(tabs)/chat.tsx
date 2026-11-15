import type { ChatEntry } from "@nova/companion-protocol/state";
import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useDictation } from "../../src/dictation";
import { haptic } from "../../src/haptics";
import { appendDictation } from "../../src/logic";
import { useCompanion } from "../../src/store";
import { radius, space, TAB_BAR_ROOM, themed, TOUCH, type, useTheme } from "../../src/theme";
import { toast } from "../../src/toast";
import { Button, Dot, GradientFill, Icon, linkText, OfflineBanner, Orb, Press, TabScene, Text, useKeyboardVisible, useLinkColor } from "../../src/ui";

const STATE_TEXT: Partial<Record<ChatEntry["state"], string>> = {
  sending: "Wartet auf deinen PC",
  queued: "Wartet, bis NOVA frei ist",
  scheduled: "Geplant",
  running: "NOVA arbeitet …",
  done: "Erledigt",
  failed: "Nicht erledigt",
  cancelled: "Abgebrochen",
  missed: "Verpasst, der PC war aus",
};

const WORKING: readonly ChatEntry["state"][] = ["running", "queued", "sending", "scheduled"];
const RETRYABLE: readonly ChatEntry["state"][] = ["failed", "cancelled", "missed"];
const SUGGESTIONS = ["Wie lange geht der Steam-Download noch?", "Wie geht es meinem PC?", "Starte Spotify", "Sag Bescheid, wenn der Download fertig ist"];
const NOW = { kind: "now" } as const;

async function copy(text: string) {
  if (!text) return;
  await Clipboard.setStringAsync(text);
  haptic("success");
  toast("Kopiert", { tone: "success", durationMs: 1800 });
}

interface RowProps {
  entry: ChatEntry;
  onRetry: (taskId: string) => void;
}

const NovaReply = memo(function NovaReply({ entry, onRetry }: RowProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const working = WORKING.includes(entry.state);
  const status = entry.state === "running" ? (entry.activity ?? STATE_TEXT.running) : STATE_TEXT[entry.state];
  return (
    <View style={styles.novaRow}>
      <Orb size={28} active={entry.state === "running"} />
      {/* A plain pressable, not Press: a bubble that shrank under every scrolling finger would be restless. */}
      <Pressable accessibilityHint={entry.text ? "Gedrückt halten zum Kopieren" : undefined} onLongPress={entry.text ? () => void copy(entry.text) : undefined} style={styles.novaBubble}>
        {entry.steps.length > 0 && (
          <View style={styles.steps}>
            {entry.steps.map((step) => (
              <View key={step.toolId} style={styles.step}>
                <View style={[styles.stepIcon, { backgroundColor: step.ok === undefined ? colors.surfaceStrong : step.ok ? colors.tints.green.bg : colors.tints.red.bg }]}>
                  <Icon name={step.ok === false ? "x" : "check"} size={11} strokeWidth={2.4} color={step.ok === undefined ? colors.subtle : step.ok ? colors.success : colors.danger} />
                </View>
                <Text variant="footnote" style={styles.stepText} numberOfLines={2}>
                  {step.title}
                  {step.tier === "approve" ? " · mit Freigabe" : ""}
                </Text>
              </View>
            ))}
          </View>
        )}
        {entry.text ? <Text>{entry.text}</Text> : null}
        {entry.screenshot && (
          <Image
            accessibilityLabel="Screenshot von deinem PC"
            source={{ uri: `data:${entry.screenshot.mime};base64,${entry.screenshot.data}` }}
            style={[styles.shot, { aspectRatio: entry.screenshot.width / entry.screenshot.height }]}
            contentFit="contain"
            transition={160}
          />
        )}
        {entry.error ? (
          <Text variant="footnote" tone="danger">
            {entry.error}
          </Text>
        ) : null}
        {/* While NOVA writes, the status stays under the text so far; afterwards only if there is nothing else to show. */}
        {(working || (!entry.text && !entry.error)) && status ? <Text variant="footnote">{status}</Text> : null}
        {RETRYABLE.includes(entry.state) && <Button label="Noch einmal senden" icon="refresh" kind="secondary" size="sm" stretch={false} onPress={() => onRetry(entry.taskId)} />}
      </Pressable>
    </View>
  );
});

const UserBubble = memo(function UserBubble({ entry }: { entry: ChatEntry }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <Pressable accessibilityHint="Gedrückt halten zum Kopieren" onLongPress={() => void copy(entry.text)} style={styles.userBubble}>
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <GradientFill from={colors.accent} to={colors.accentDeep} />
      </View>
      <Text tone="onAccent">{entry.text}</Text>
    </Pressable>
  );
});

export default function ChatScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardVisible();
  const chat = useCompanion((s) => s.chat);
  const send = useCompanion((s) => s.send);
  const pcName = useCompanion((s) => s.status?.pcName ?? s.pc?.pcName ?? null);
  const busy = useCompanion((s) => Boolean(s.status?.busy));
  const link = useCompanion((s) => s.link);
  const linkColor = useLinkColor(link);
  const [text, setText] = useState("");
  const [screenshot, setScreenshot] = useState(false);
  const spoken = useRef(false);
  // What was typed before the microphone was tapped; dictation continues it.
  const typed = useRef("");
  const dictation = useDictation((heard, final) => {
    setText(appendDictation(typed.current, heard));
    if (final) spoken.current = true;
  });

  // Newest first for the inverted list, and only rebuilt when the chat really changed.
  const entries = useMemo(() => [...chat].reverse(), [chat]);

  const submit = (value = text) => {
    if (!value.trim()) return;
    send(value, { schedule: NOW, wantScreenshot: screenshot, voice: spoken.current });
    haptic("tap");
    setText("");
    spoken.current = false;
  };

  const retry = useCallback(
    (taskId: string) => {
      const asked = useCompanion.getState().chat.find((entry) => entry.taskId === taskId && entry.role === "user");
      if (asked) send(asked.text, { schedule: NOW, wantScreenshot: false, voice: false });
    },
    [send],
  );

  const renderItem = useCallback(({ item }: { item: ChatEntry }) => (item.role === "user" ? <UserBubble entry={item} /> : <NovaReply entry={item} onRetry={retry} />), [retry]);

  return (
    <TabScene>
      {/* "padding" adds only what the keyboard really covers, so it is right whether or not Android resizes the window itself. */}
      <KeyboardAvoidingView style={styles.fill} behavior="padding">
        <View style={[styles.topBar, { paddingTop: insets.top + 10 }]}>
          <Orb size={34} active={link === "online" && busy} />
          <View style={styles.fill}>
            <Text variant="headline" accessibilityRole="header">
              NOVA AI
            </Text>
            <View style={styles.link}>
              <Dot color={linkColor} size={6} />
              <Text variant="footnote" numberOfLines={1} style={styles.fill}>
                {pcName ? `${pcName} · ${linkText(link)}` : linkText(link)}
              </Text>
            </View>
          </View>
        </View>
        <FlatList
          data={entries}
          inverted
          keyExtractor={(entry) => `${entry.taskId}:${entry.role}`}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          initialNumToRender={12}
          windowSize={9}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Orb size={64} />
              <Text variant="title" center>
                Was soll NOVA tun?
              </Text>
              <Text variant="callout" center>
                NOVA arbeitet auf deinem PC und antwortet hier, mit Screenshot, wenn du willst.
              </Text>
              <View style={styles.suggestions}>
                {SUGGESTIONS.map((suggestion) => (
                  <Press key={suggestion} label={suggestion} onPress={() => submit(suggestion)} style={styles.suggestion}>
                    <Text variant="footnote" tone="text">
                      {suggestion}
                    </Text>
                  </Press>
                ))}
              </View>
            </View>
          }
        />
        <View style={[styles.composer, { marginBottom: keyboard ? space.sm : TAB_BAR_ROOM - 30 + insets.bottom }]}>
          {link !== "online" && !keyboard && <OfflineBanner />}
          {dictation.error && (
            <Text variant="footnote" tone="warning" style={styles.hint}>
              {dictation.error}
            </Text>
          )}
          <View style={styles.field}>
            <Press
              role="switch"
              state={{ checked: screenshot }}
              label="Screenshot mitschicken"
              haptic="select"
              onPress={() => setScreenshot((on) => !on)}
              style={[styles.inline, screenshot && { backgroundColor: colors.tints.cyan.bg }]}
            >
              <Icon name="image" size={19} color={screenshot ? colors.tints.cyan.fg : colors.subtle} />
            </Press>
            <TextInput
              style={[type.body, styles.input]}
              value={text}
              onChangeText={setText}
              placeholder={dictation.listening ? "Ich höre zu …" : "Auftrag an NOVA"}
              placeholderTextColor={colors.subtle}
              selectionColor={colors.accent}
              keyboardAppearance={colors.scheme}
              multiline
              maxLength={4000}
              accessibilityLabel="Auftrag an NOVA"
            />
            {text.trim() ? (
              <Press label="Senden" onPress={() => submit()} haptic={false} style={styles.send}>
                <GradientFill radius={50} from={colors.accent} to={colors.accentDeep} />
                <Icon name="send" size={19} color={colors.onAccent} />
              </Press>
            ) : (
              <Press
                label={dictation.listening ? "Diktat beenden" : "Diktieren"}
                onPress={() => {
                  if (dictation.listening) return dictation.stop();
                  typed.current = text;
                  void dictation.start();
                }}
                style={[styles.send, { backgroundColor: dictation.listening ? colors.cyan : colors.surfaceStrong }]}
              >
                <Icon name="mic" size={20} color={dictation.listening ? colors.background : colors.text} />
              </Press>
            )}
          </View>
          {screenshot && (
            <Text variant="footnote" style={styles.hint}>
              NOVA schickt einen Screenshot mit der Antwort.
            </Text>
          )}
        </View>
      </KeyboardAvoidingView>
    </TabScene>
  );
}

const useStyles = themed(({ colors }) => ({
  fill: { flex: 1 },
  topBar: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg + 2, paddingBottom: space.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  link: { flexDirection: "row", alignItems: "center", gap: 6 },
  list: { padding: space.lg, gap: space.md, flexGrow: 1 },
  // The list is upside down; its empty state has to be turned back.
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm + 2, padding: space.xl, transform: [{ scaleY: -1 }] },
  suggestions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: space.sm, marginTop: space.sm + 2 },
  suggestion: { minHeight: TOUCH, justifyContent: "center", paddingHorizontal: 14, paddingVertical: space.sm, borderRadius: radius.pill, backgroundColor: colors.surfaceStrong, borderWidth: 1, borderColor: colors.border },
  userBubble: { alignSelf: "flex-end", maxWidth: "84%", borderRadius: radius.xl, borderBottomRightRadius: 8, paddingHorizontal: space.lg, paddingVertical: 11, overflow: "hidden" },
  novaRow: { flexDirection: "row", gap: space.sm, alignItems: "flex-start", maxWidth: "94%" },
  novaBubble: { flexShrink: 1, gap: space.sm + 2, padding: 14, borderRadius: radius.xl, borderTopLeftRadius: 8, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: colors.border, borderTopColor: colors.borderTop },
  steps: { gap: 6, paddingBottom: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  step: { flexDirection: "row", gap: space.sm, alignItems: "center" },
  stepIcon: { width: 18, height: 18, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  stepText: { flex: 1 },
  shot: { width: "100%", borderRadius: radius.md, backgroundColor: "#000000" },
  composer: { paddingHorizontal: 14, paddingTop: space.sm, gap: 6 },
  hint: { paddingHorizontal: space.sm },
  field: { flexDirection: "row", alignItems: "flex-end", gap: 4, padding: 5, borderRadius: 28, backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border, borderTopColor: colors.borderTop },
  inline: { width: TOUCH, height: TOUCH, borderRadius: TOUCH / 2, alignItems: "center", justifyContent: "center" },
  input: { flex: 1, color: colors.text, maxHeight: 130, minHeight: TOUCH, paddingVertical: 10, paddingHorizontal: 4 },
  send: { width: TOUCH, height: TOUCH, borderRadius: TOUCH / 2, alignItems: "center", justifyContent: "center", overflow: "hidden" },
}));
