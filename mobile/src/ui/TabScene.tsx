import { BlurTargetView } from "expo-blur";
import { useFocusEffect } from "expo-router";
import { type ComponentRef, type ReactNode, type RefObject, useCallback, useRef } from "react";
import type { View } from "react-native";
import { create } from "zustand";
import { themed } from "../theme";
import { Backdrop } from "./graphics";

type Target = RefObject<ComponentRef<typeof View> | null>;

/** The screen under the floating tab bar right now; the bar blurs exactly this view. */
export const useBlurTarget = create<{ target: Target | null }>(() => ({ target: null }));

/**
 * The frame of a tab's screen. Android can only blur a view it was told about, so
 * each tab wraps its content in a blur target and hands it to the tab bar while it
 * is the one in front.
 */
export function TabScene({ children }: { children: ReactNode }) {
  const styles = useStyles();
  const ref = useRef<ComponentRef<typeof View>>(null);
  useFocusEffect(
    useCallback(() => {
      useBlurTarget.setState({ target: ref });
      return () => {
        if (useBlurTarget.getState().target === ref) useBlurTarget.setState({ target: null });
      };
    }, []),
  );
  return (
    <BlurTargetView ref={ref} style={styles.scene}>
      <Backdrop />
      {children}
    </BlurTargetView>
  );
}

const useStyles = themed(({ colors }) => ({
  scene: { flex: 1, backgroundColor: colors.background },
}));
