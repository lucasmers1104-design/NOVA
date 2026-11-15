import { type ReactNode, useEffect, useState } from "react";
import { type StyleProp, View, type ViewStyle } from "react-native";
import { type Link, useCompanion } from "../store";
import { space, themed, useTheme } from "../theme";
import { Button } from "./Button";
import { Backdrop } from "./graphics";
import { Icon } from "./Icon";
import { Text } from "./Text";

/** The frame of every screen: the theme's ground with NOVA's lights behind the content. */
export function Screen({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const styles = useStyles();
  return (
    <View style={[styles.screen, style]}>
      <Backdrop />
      {children}
    </View>
  );
}

/** A large page title under the status bar, with something on the right. */
export function ScreenHeader({ eyebrow, title, right, left }: { eyebrow?: string; title: string; right?: ReactNode; left?: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.header}>
      {left}
      <View style={styles.headerText}>
        {eyebrow ? <Text variant="footnote">{eyebrow}</Text> : null}
        <Text variant="display" accessibilityRole="header" numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.7}>
          {title}
        </Text>
      </View>
      {right}
    </View>
  );
}

export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.section}>
      <Text variant="caption" accessibilityRole="header" style={styles.sectionTitle}>
        {title}
      </Text>
      {action}
    </View>
  );
}

const LINK_TEXT: Record<Link, string> = { unpaired: "Nicht gekoppelt", connecting: "Verbinde …", online: "Verbunden", offline: "Nicht erreichbar" };

export function linkText(link: Link): string {
  return LINK_TEXT[link];
}

/** The colour that goes with a connection state, for dots and badges. */
export function useLinkColor(link: Link): string {
  const { colors } = useTheme();
  return link === "online" ? colors.success : link === "connecting" ? colors.warning : link === "offline" ? colors.danger : colors.subtle;
}

/**
 * The offline state every screen shares: says the PC can't be reached, when the app
 * tries again, and lets the user try now. Renders nothing while connected or unpaired.
 */
export function OfflineBanner() {
  const styles = useStyles();
  const { colors } = useTheme();
  const link = useCompanion((s) => s.link);
  const retryAt = useCompanion((s) => s.retryAt);
  const waiting = useCompanion((s) => s.outbox.length);
  const refresh = useCompanion((s) => s.refresh);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (link !== "offline" || !retryAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [link, retryAt]);

  if (link !== "offline" && link !== "connecting") return null;
  const seconds = retryAt ? Math.max(1, Math.ceil((retryAt - now) / 1000)) : null;
  const status = link === "connecting" ? "Ich suche deinen PC …" : seconds ? `Nächster Versuch in ${seconds} s.` : "Tippe, um es noch einmal zu versuchen.";
  const queued = waiting === 0 ? "" : waiting === 1 ? " 1 Auftrag wartet." : ` ${waiting} Aufträge warten.`;

  return (
    <View style={styles.banner} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <Icon name="wifi" size={18} color={link === "connecting" ? colors.warning : colors.danger} />
      <View style={styles.bannerText}>
        <Text variant="callout" tone="text">
          {link === "connecting" ? "Verbinde mit deinem PC" : "Dein PC ist nicht erreichbar"}
        </Text>
        <Text variant="footnote">
          {status}
          {queued}
        </Text>
      </View>
      {link === "offline" && <Button label="Verbinden" kind="secondary" size="sm" stretch={false} onPress={() => void refresh()} />}
    </View>
  );
}

const useStyles = themed(({ colors }) => ({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: "row", alignItems: "flex-end", gap: space.md, marginBottom: space.xs },
  headerText: { flex: 1, gap: 2 },
  section: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: space.sm + 2, paddingHorizontal: space.xs, minHeight: 20 },
  sectionTitle: { flex: 1 },
  banner: { flexDirection: "row", alignItems: "center", gap: space.md, backgroundColor: colors.tints.amber.bg, borderRadius: 18, borderWidth: 1, borderColor: colors.border, paddingHorizontal: space.md + 2, paddingVertical: space.sm + 2 },
  bannerText: { flex: 1, gap: 1 },
}));
