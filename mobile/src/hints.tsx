// Explanations several screens share: how to get past Android's hurdles for an app
// that doesn't come from a store, and how to reach a PC without Wi-Fi.
import { View } from "react-native";
import { openAppSettings } from "./permissions";
import { fonts, radius, space, themed, useTheme } from "./theme";
import { Button, IconTile, Text } from "./ui";

/** One drawn step of a dialog: two lines of "text" and the button to tap, highlighted. */
function Frame({ step, lines, tap, caption }: { step: number; lines: readonly number[]; tap: string; caption: string }) {
  const styles = useStyles();
  return (
    <View style={styles.frame} accessible accessibilityLabel={`Schritt ${step}: ${caption}`}>
      <View style={styles.dialog}>
        <View style={styles.number}>
          <Text allowFontScaling={false} tone="onAccent" style={styles.numberText}>
            {step}
          </Text>
        </View>
        {lines.map((width, i) => (
          <View key={i} style={[styles.line, { width: `${width}%` }]} />
        ))}
        <View style={styles.tap}>
          <Text variant="footnote" tone="accent" style={styles.tapText} maxFontSizeMultiplier={1.2} numberOfLines={2}>
            {tap}
          </Text>
        </View>
      </View>
      <Text variant="footnote" center>
        {caption}
      </Text>
    </View>
  );
}

/**
 * What Google Play Protect may show when an app from outside the Play Store is
 * installed, as three small pictures. The wording on the phone differs a little
 * between Android versions; the order is the same.
 */
export function PlayProtectSteps() {
  const styles = useStyles();
  return (
    <View style={styles.steps}>
      <Text variant="callout">
        Falls Google Play Protect warnt: Die App kommt von GitHub und nicht aus dem Play Store, deshalb kennt Google sie nicht. Sie ist dieselbe, die du schon installiert hast, mit demselben Schlüssel signiert.
      </Text>
      <View style={styles.frames}>
        <Frame step={1} lines={[80, 60]} tap="Weitere Details" caption="Tippe auf „Weitere Details“" />
        <Frame step={2} lines={[70, 85]} tap="Trotzdem installieren" caption="Dann „Trotzdem installieren“" />
        <Frame step={3} lines={[60, 40]} tap="Aktualisieren" caption="Android fragt: „Aktualisieren“" />
      </View>
      <Text variant="footnote">Bietet Play Protect an, die App zum Prüfen an Google zu senden, kannst du das tun: Danach kommt die Warnung seltener.</Text>
    </View>
  );
}

/**
 * Android 13 and newer grey out notification access for apps installed from a file
 * ("Eingeschränkte Einstellung"). The switch works once the user allowed restricted
 * settings on the app's info page; this says how and opens that page.
 */
export function RestrictedSettingsHint() {
  const styles = useStyles();
  return (
    <View style={styles.hint}>
      <Text variant="footnote">
        <Text variant="footnote" tone="text" style={styles.strong}>
          Schalter ausgegraut?{" "}
        </Text>
        Android sperrt diese Einstellung für Apps, die nicht aus einem Store kommen. Öffne die App-Info, tippe oben rechts auf die drei Punkte und wähle „Eingeschränkte Einstellungen zulassen“. Danach lässt sich der Zugriff erlauben.
      </Text>
      <Button label="App-Info öffnen" kind="secondary" size="sm" stretch={false} onPress={openAppSettings} />
    </View>
  );
}

/** PC on a cable, or no Wi-Fi at all: the two ways that still work. */
export function ConnectionHelp() {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.help}>
      <View style={styles.tip}>
        <IconTile name="cable" tint="cyan" size={34} />
        <Text variant="footnote" style={styles.tipText}>
          <Text variant="footnote" style={[styles.strong, { color: colors.text }]}>
            PC am LAN-Kabel:{" "}
          </Text>
          Hängt er am selben Router wie dein WLAN, klappt es direkt. Blockt Windows die Verbindung, klicke am PC auf der Seite „Phone“ auf „Allow NOVA in the firewall“ und bestätige die Windows-Abfrage.
        </Text>
      </View>
      <View style={styles.tip}>
        <IconTile name="shield" tint="amber" size={34} />
        <Text variant="footnote" style={styles.tipText}>
          <Text variant="footnote" style={[styles.strong, { color: colors.text }]}>
            Virenschutz mit Firewall:{" "}
          </Text>
          Programme wie Avast oder Norton haben eine eigene Firewall, die auch blocken kann. Stell dort dein Heimnetz auf „Privat“ oder erlaube NOVA eingehende Verbindungen. „Check network“ am PC zeigt, ob so eine Firewall aktiv ist.
        </Text>
      </View>
      <View style={styles.tip}>
        <IconTile name="usb" tint="violet" size={34} />
        <Text variant="footnote" style={styles.tipText}>
          <Text variant="footnote" style={[styles.strong, { color: colors.text }]}>
            Ganz ohne WLAN:{" "}
          </Text>
          Verbinde dein Handy per USB-Kabel mit dem PC und schalte in Android unter Netzwerk → Hotspot und Tethering „USB-Tethering“ ein. Lass dir danach am PC einen neuen Code zeigen.
        </Text>
      </View>
    </View>
  );
}

const useStyles = themed(({ colors }) => ({
  steps: { gap: space.md },
  frames: { flexDirection: "row", gap: space.sm },
  frame: { flex: 1, gap: 6 },
  dialog: { minHeight: 96, borderRadius: radius.md, backgroundColor: colors.field, borderWidth: 1, borderColor: colors.border, padding: space.sm, gap: 6, justifyContent: "flex-end" },
  number: { position: "absolute", top: 6, left: 6, width: 20, height: 20, borderRadius: 10, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  numberText: { fontFamily: fonts.bold, fontSize: 11, lineHeight: 14 },
  line: { height: 5, borderRadius: radius.pill, backgroundColor: colors.surfaceHigh },
  tap: { borderRadius: radius.sm, borderWidth: 1.5, borderColor: colors.accentText, paddingHorizontal: 4, paddingVertical: 4, marginTop: 2 },
  tapText: { fontFamily: fonts.semibold, fontSize: 10.5, lineHeight: 13, textAlign: "center" },
  hint: { gap: space.sm + 2 },
  strong: { fontFamily: fonts.semibold },
  help: { gap: space.md },
  tip: { flexDirection: "row", gap: space.md, alignItems: "flex-start" },
  tipText: { flex: 1 },
}));
