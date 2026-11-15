import { type ReactNode, useEffect } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { motion, radius, space, themed } from "../theme";
import { Text } from "./Text";

export interface SheetProps {
  visible: boolean;
  /** The scrim, the back button and the handle all close it. */
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Buttons that stay at the bottom while the content scrolls. */
  footer?: ReactNode;
}

/**
 * A panel that rises from the bottom for a question or an explanation that belongs to
 * the screen underneath. The whole dialog fades in (the system's own animation) and the
 * panel moves up a little: nothing here depends on an animation finishing.
 */
export function Sheet({ visible, onClose, title, children, footer }: SheetProps) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const rise = useSharedValue(0);

  useEffect(() => {
    if (!visible) return;
    rise.value = reduced ? 0 : 28;
    rise.value = withTiming(0, { duration: motion.base });
  }, [visible, reduced, rise]);

  const panel = useAnimatedStyle(() => ({ transform: [{ translateY: rise.value }] }));

  return (
    <Modal visible={visible} transparent statusBarTranslucent navigationBarTranslucent animationType="fade" onRequestClose={onClose}>
      <View style={styles.root}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Schließen">
          <View style={styles.scrim} />
        </Pressable>
        <Animated.View style={[styles.panel, { paddingBottom: Math.max(insets.bottom, space.lg) + space.sm }, panel]} accessibilityViewIsModal>
          <View style={styles.handle} />
          <Text variant="title" accessibilityRole="header">
            {title}
          </Text>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            {children}
          </ScrollView>
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </Animated.View>
      </View>
    </Modal>
  );
}

const useStyles = themed(({ colors, elevation }) => ({
  root: { flex: 1, justifyContent: "flex-end" },
  scrim: { flex: 1, backgroundColor: colors.scrim },
  panel: { backgroundColor: colors.raised, borderTopLeftRadius: 28, borderTopRightRadius: 28, borderWidth: 1, borderBottomWidth: 0, borderColor: colors.border, borderTopColor: colors.borderTop, paddingHorizontal: space.page, paddingTop: space.sm + 2, gap: space.md, maxHeight: "88%", ...elevation.floating },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: radius.pill, backgroundColor: colors.surfaceHigh, marginBottom: space.xs },
  scroll: { flexGrow: 0 },
  content: { gap: space.md, paddingBottom: space.xs },
  footer: { gap: space.sm + 2 },
}));
