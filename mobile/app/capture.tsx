import type { Schedule } from "@nova/companion-protocol";
import { nextAt } from "@nova/companion-protocol/state";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useDictation } from "../src/dictation";
import { haptic } from "../src/haptics";
import { appendDictation, normalizeTime } from "../src/logic";
import { useCompanion } from "../src/store";
import { radius, space, themed, TOUCH, type, useTheme } from "../src/theme";
import { toast } from "../src/toast";
import { Button, goBack, Icon, IconButton, Press, Screen, ScreenHeader, type Segment, SegmentedControl, Text, TextField } from "../src/ui";

type When = "now" | "whenOnline" | "at";

const WHEN: readonly Segment<When>[] = [
  { value: "now", label: "Jetzt", icon: "bolt" },
  { value: "whenOnline", label: "Wenn der PC an ist", icon: "monitor" },
  { value: "at", label: "Um …", icon: "clock" },
];

const WHEN_TEXT: Record<When, string> = {
  now: "Geht sofort los. Ist dein PC gerade nicht erreichbar, wartet der Auftrag auf dem Handy.",
  whenOnline: "Wartet auf dem Handy und geht los, sobald dein PC erreichbar ist.",
  at: "Ist der PC zu dieser Zeit aus, holt NOVA den Auftrag bis zu zwei Stunden später nach.",
};

export default function CaptureScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  // The start screen opens this with a text to begin with ("Notiere: ") or with the microphone on.
  const params = useLocalSearchParams<{ text?: string; dictate?: string }>();
  const send = useCompanion((s) => s.send);
  const online = useCompanion((s) => s.link === "online");
  const [text, setText] = useState(params.text ?? "");
  const [when, setWhen] = useState<When>("now");
  const [time, setTime] = useState("");
  const spoken = useRef(false);
  const typed = useRef("");
  const dictation = useDictation((heard, final) => {
    setText(appendDictation(typed.current, heard));
    if (final) spoken.current = true;
  });
  const at = normalizeTime(time);
  const ready = text.trim().length > 0 && (when !== "at" || at !== null);

  const dictate = () => {
    if (dictation.listening) return dictation.stop();
    typed.current = text;
    void dictation.start();
  };

  const startDictation = dictation.start;
  useEffect(() => {
    if (params.dictate !== "1") return;
    typed.current = params.text ?? "";
    void startDictation();
  }, [params.dictate, params.text, startDictation]);

  const submit = () => {
    const schedule: Schedule = when === "at" && at ? nextAt(at, new Date()) : { kind: when === "whenOnline" ? "whenOnline" : "now" };
    send(text, { schedule, wantScreenshot: false, voice: spoken.current });
    haptic("success");
    toast(schedule.kind === "at" ? `Geplant für ${schedule.time} Uhr` : online ? "Auftrag an NOVA gesendet" : "Auftrag wartet, bis dein PC erreichbar ist", { tone: "success" });
    goBack();
  };

  return (
    <Screen>
      <KeyboardAvoidingView style={styles.fill} behavior="padding">
        {/* The content scrolls and the buttons stay: on a small screen with the keyboard up, "Senden" is still in reach. */}
        <ScrollView contentContainerStyle={[styles.page, { paddingTop: insets.top + space.lg }]} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <ScreenHeader eyebrow="Neuer Auftrag" title="Schnell erfassen" right={<IconButton icon="x" label="Schließen" onPress={goBack} />} />
          <View style={styles.editor}>
            <TextInput
              style={[type.body, styles.input]}
              value={text}
              onChangeText={setText}
              placeholder={dictation.listening ? "Ich höre zu …" : "Zum Beispiel: Öffne Fortnite, ich komme gleich."}
              placeholderTextColor={colors.subtle}
              selectionColor={colors.accent}
              keyboardAppearance={colors.scheme}
              multiline
              autoFocus={params.dictate !== "1"}
              maxLength={4000}
              accessibilityLabel="Auftrag"
            />
            <Press label={dictation.listening ? "Diktat beenden" : "Diktieren"} onPress={dictate} containerStyle={styles.micWrap} style={[styles.mic, dictation.listening && { backgroundColor: colors.cyan }]}>
              <Icon name="mic" size={20} color={dictation.listening ? colors.background : colors.text} />
            </Press>
          </View>
          {dictation.error && (
            <Text variant="footnote" tone="warning">
              {dictation.error}
            </Text>
          )}
          <Text variant="caption">Wann</Text>
          <SegmentedControl label="Wann" options={WHEN} value={when} onChange={setWhen} />
          {when === "at" && (
            <View style={styles.time}>
              <TextField
                label="Uhrzeit"
                value={time}
                onChangeText={setTime}
                placeholder="18:30"
                keyboardType="numbers-and-punctuation"
                maxLength={5}
                error={time.length > 0 && !at ? "Gib die Uhrzeit als HH:MM ein." : null}
                // Large enough to read at a glance, but not scaled further: five characters have to fit.
                maxFontSizeMultiplier={1.4}
                style={styles.timeInput}
              />
            </View>
          )}
          <Text variant="footnote">{WHEN_TEXT[when]}</Text>
        </ScrollView>
        <View style={[styles.footer, { paddingBottom: insets.bottom + space.md }]}>
          <Button label="An NOVA senden" icon="send" disabled={!ready} haptic={false} onPress={submit} />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const useStyles = themed(({ colors }) => ({
  fill: { flex: 1 },
  page: { paddingHorizontal: space.page, paddingBottom: space.lg, gap: space.md + 2 },
  editor: { borderRadius: radius.xl, backgroundColor: colors.field, borderWidth: 1, borderColor: colors.border, padding: 6 },
  input: { color: colors.text, fontSize: 17, lineHeight: 24, minHeight: 120, textAlignVertical: "top", padding: space.md },
  micWrap: { alignSelf: "flex-end", margin: 4 },
  mic: { width: TOUCH, height: TOUCH, borderRadius: TOUCH / 2, backgroundColor: colors.surfaceStrong, alignItems: "center", justifyContent: "center" },
  time: { maxWidth: 200 },
  timeInput: { fontSize: 20, lineHeight: 26, letterSpacing: 1 },
  footer: { paddingHorizontal: space.page, paddingTop: space.sm },
}));
