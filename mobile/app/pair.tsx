import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { failureText, useCompanion } from "../src/store";
import { colors, radius, ui } from "../src/theme";
import { Backdrop, Button, Orb } from "../src/ui";

export default function PairScreen() {
  const insets = useSafeAreaInsets();
  const pair = useCompanion((s) => s.pair);
  const [permission, requestPermission] = useCameraPermissions();
  const [name, setName] = useState(Device.deviceName ?? "Mein Handy");
  const [phase, setPhase] = useState<"scan" | "waiting" | "error">("scan");
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  const scanned = async (data: string) => {
    if (handled.current) return;
    handled.current = true;
    setPhase("waiting");
    try {
      await pair(data, name);
      router.back();
    } catch (e) {
      setError(failureText(e));
      setPhase("error");
    }
  };

  return (
    <View style={[ui.screen, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 16 }]}>
      <Backdrop />
      <View style={styles.page}>
        <Text style={ui.title}>Mit deinem PC koppeln</Text>
        {phase === "scan" && (
          <>
            <Text style={ui.muted}>So heißt dein Handy am PC:</Text>
            <TextInput style={ui.input} value={name} onChangeText={setName} maxLength={60} accessibilityLabel="Name deines Handys" placeholderTextColor={colors.subtle} />
            {permission?.granted ? (
              <View style={styles.camera}>
                <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={({ data }) => void scanned(data)} />
              </View>
            ) : (
              <View style={{ gap: 10 }}>
                <Text style={ui.muted}>Zum Scannen des Codes braucht die App einmal die Kamera.</Text>
                <Button label="Kamera erlauben" onPress={() => void requestPermission()} />
              </View>
            )}
          </>
        )}
        {phase === "waiting" && (
          <View style={styles.center}>
            <Orb size={64} active />
            <Text style={[ui.heading, { textAlign: "center" }]}>Bestätige die Kopplung an deinem PC</Text>
            <Text style={[ui.muted, { textAlign: "center" }]}>NOVA fragt dort, ob „{name}“ gekoppelt werden soll. Danach fragt dein Handy einmal nach deinem Fingerabdruck, um den Schlüssel für Freigaben zu sichern.</Text>
          </View>
        )}
        {phase === "error" && (
          <View style={{ gap: 12 }}>
            <Text style={[ui.body, { color: colors.warning }]}>{error}</Text>
            <Button
              label="Neu scannen"
              onPress={() => {
                handled.current = false;
                setError(null);
                setPhase("scan");
              }}
            />
          </View>
        )}
        <View style={{ marginTop: "auto" }}>
          <Button label="Abbrechen" kind="ghost" onPress={() => router.back()} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: 20, gap: 14 },
  camera: { aspectRatio: 1, borderRadius: radius.card, overflow: "hidden", borderWidth: 1, borderColor: colors.rim },
  center: { alignItems: "center", gap: 14, paddingTop: 40 },
});
