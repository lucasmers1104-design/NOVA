import { Image } from "expo-image";
import { View } from "react-native";
import { fonts, type TintName, useTheme } from "../theme";
import { Text } from "./Text";

/** Up to two letters for a name: "Gaming PC" → "GP", "WhatsApp" → "W". */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0]?.[0] ?? "?");
  return letters.toUpperCase();
}

/** A round picture for a PC or an app; without a picture, its initials on a tint. */
export function Avatar({ name, image, size = 40, tint = "violet" }: { name: string; image?: string | null; size?: number; tint?: TintName }) {
  const { colors } = useTheme();
  const t = colors.tints[tint];
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: t.bg, alignItems: "center", justifyContent: "center", overflow: "hidden" }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {image ? (
        <Image source={{ uri: image }} style={{ width: size, height: size }} contentFit="cover" />
      ) : (
        <Text allowFontScaling={false} style={{ fontFamily: fonts.semibold, fontSize: size * 0.38, lineHeight: size * 0.5, color: t.fg }}>
          {initials(name)}
        </Text>
      )}
    </View>
  );
}
