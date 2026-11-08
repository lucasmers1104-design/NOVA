import type { Schedule } from "@nova/companion-protocol";
import { nextAt } from "@nova/companion-protocol/state";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useDictation } from "../src/dictation";
import { useCompanion } from "../src/store";
import { colors, radius, ui } from "../src/theme";
import { Backdrop, Button, Icon } from "../src/ui";

type When = "now" | "whenOnline" | "at";
const TIME = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/;

/** "18.30" or "7:05" → "07:05"; `null` if it isn't a time. */
export function normalizeTime(text: string): string | null {
  const match = TIME.exec(text.trim());
  return match ? `${match[1]!.padStart(2, "0")}:${match[2]}` : null;
}

export default function CaptureScreen() {
  const insets = useSafeAreaInsets();
  const send = useCompanion((s) => s.send);
  const [text, setText] = useState("");
  const [when, setWhen] = useState<When>("now");
  const [time, setTime] = useState("");
  const spoken = useRef(false);
  const dictation = useDictation((heard, final) => {
    setText(heard);
    if (final) spoken.current = true;
  });
  const at = normalizeTime(time);
  const ready = text.trim().length > 0 && (when !== "at" || at !== null);

  const submit = () => {
    const schedule: Schedule = when === "at" && at ? nextAt(at, new Date()) : { kind: when === "whenOnline" ? "whenOnline" : "now" };
    send(text, { schedule, wantScreenshot: false, voice: spoken.current });
    router.back();
  };

  const option = (value: When, label: string) => (
    <Pressable
      key={value}
      accessibilityRole="radio"
      accessibilityState={{ selected: when === value }}
      onPress={() => setWhen(value)}
      style={[styles.option, when === value && { backgroundColor: colors.violet, borderColor: colors.violet }]}
    >
      <Text style={[ui.body, { fontSize: 14 }]}>{label}</Text>
    </Pressable>
  );

  return (
    <KeyboardAvoidingView style={ui.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Backdrop />
      <View style={[styles.page, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 16 }]}>
        <Text style={ui.title}>Schnell erfassen</Text>
        <TextInput
          style={[ui.input, { minHeight: 110, textAlignVertical: "top" }]}
          value={text}
          onChangeText={setText}
          placeholder={dictation.listening ? "Ich höre zu …" : "Zum Beispiel: Öffne Fortnite, ich komme gleich."}
          placeholderTextColor={colors.subtle}
          multiline
          autoFocus
          maxLength={4000}
          accessibilityLabel="Auftrag"
        />
        {dictation.error && <Text style={[ui.muted, { color: colors.warning }]}>{dictation.error}</Text>}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={dictation.listening ? "Diktat beenden" : "Diktieren"}
          onPress={() => (dictation.listening ? dictation.stop() : void dictation.start())}
          style={[styles.mic, dictation.listening && { backgroundColor: colors.cyan }]}
        >
          <Icon name="mic" size={30} color={dictation.listening ? colors.background : colors.text} />
        </Pressable>
        <Text style={ui.heading}>Wann</Text>
        <View style={styles.options} accessibilityRole="radiogroup">
          {option("now", "Jetzt")}
          {option("whenOnline", "Sobald der PC an ist")}
          {option("at", "Um …")}
        </View>
        {when === "at" && (
          <TextInput
            style={[ui.input, { width: 120 }]}
            value={time}
            onChangeText={setTime}
            placeholder="18:30"
            placeholderTextColor={colors.subtle}
            keyboardType="numbers-and-punctuation"
            maxLength={5}
            accessibilityLabel="Uhrzeit"
          />
        )}
        {when === "at" && time.length > 0 && !at && <Text style={[ui.muted, { color: colors.warning }]}>Gib die Uhrzeit als HH:MM ein.</Text>}
        {when === "at" && <Text style={ui.muted}>Ist der PC zu dieser Zeit aus, holt NOVA den Auftrag bis zu zwei Stunden später nach.</Text>}
        <View style={{ marginTop: "auto", gap: 10 }}>
          <Button label="An NOVA senden" icon={<Icon name="send" size={18} />} disabled={!ready} onPress={submit} />
          <Button label="Abbrechen" kind="ghost" onPress={() => router.back()} />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: 20, gap: 14 },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  option: { borderRadius: radius.pill, borderWidth: 1, borderColor: colors.rim, backgroundColor: colors.glass, paddingHorizontal: 16, paddingVertical: 10 },
  mic: { alignSelf: "center", width: 76, height: 76, borderRadius: 38, backgroundColor: colors.glassStrong, borderWidth: 1, borderColor: colors.rim, alignItems: "center", justifyContent: "center" },
});
