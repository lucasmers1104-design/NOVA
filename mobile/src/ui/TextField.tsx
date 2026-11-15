import { type ReactNode, useState } from "react";
import { TextInput, type TextInputProps, View } from "react-native";
import { radius, space, themed, type, useTheme } from "../theme";
import { Text } from "./Text";

export interface TextFieldProps extends Omit<TextInputProps, "placeholderTextColor"> {
  /** Shown above the field and read by screen readers. */
  label: string;
  helper?: string;
  /** Replaces the helper and turns the rim red. */
  error?: string | null;
  /** A button inside the field, on the right. */
  right?: ReactNode;
}

/** One line or several of typed text, with its label, a hint and an error underneath. */
export function TextField({ label, helper, error, right, style, onFocus, onBlur, ...input }: TextFieldProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.wrap}>
      <Text variant="caption">{label}</Text>
      <View style={[styles.field, focused && styles.focused, error ? styles.invalid : null]}>
        <TextInput
          accessibilityLabel={label}
          placeholderTextColor={colors.subtle}
          selectionColor={colors.accent}
          keyboardAppearance={colors.scheme}
          {...input}
          style={[type.body, styles.input, style]}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
        />
        {right}
      </View>
      {error ? (
        <Text variant="footnote" tone="warning" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : helper ? (
        <Text variant="footnote">{helper}</Text>
      ) : null}
    </View>
  );
}

const useStyles = themed(({ colors }) => ({
  wrap: { gap: 6 },
  field: { flexDirection: "row", alignItems: "flex-end", backgroundColor: colors.field, borderColor: colors.border, borderWidth: 1, borderRadius: radius.lg, paddingHorizontal: space.md + 2, paddingVertical: 2, minHeight: 50 },
  focused: { borderColor: colors.accent },
  invalid: { borderColor: colors.warning },
  input: { flex: 1, color: colors.text, paddingVertical: space.md, minHeight: 46 },
}));
