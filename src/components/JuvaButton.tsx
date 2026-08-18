import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { JuvaPressable } from '@/components/Pressable';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';

interface Props {
  label: string;
  onPress: () => void;
  variant?: 'dark' | 'light' | 'signal' | 'ghost';
  disabled?: boolean;
  icon?: string;
  style?: StyleProp<ViewStyle>;
  /** Overrides the spoken label when `label` alone is not self-explanatory. */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** `select` for choices that change state; defaults to a navigation tap. */
  feedback?: 'tap' | 'select' | 'none';
  /** Renders a working state and blocks presses. */
  busy?: boolean;
  testID?: string;
}

/**
 * Juva's primary control.
 *
 * Built on `JuvaPressable`, so every button in the product gets the same press
 * spring, the matching haptic and a proper accessibility role for free. A minimum
 * height of 56 keeps it comfortably above the 44pt touch-target floor even before
 * large text expands it.
 */
export function JuvaButton({
  label,
  onPress,
  variant = 'dark',
  disabled,
  icon,
  style,
  accessibilityLabel,
  accessibilityHint,
  feedback = 'tap',
  busy = false,
  testID,
}: Props) {
  const blocked = Boolean(disabled) || busy;

  return (
    <JuvaPressable
      testID={testID}
      onPress={onPress}
      disabled={blocked}
      feedback={feedback}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      {...(accessibilityHint === undefined ? {} : { accessibilityHint })}
      accessibilityState={{ disabled: blocked, busy }}
      style={[styles.base, styles[variant], style]}
    >
      <View style={styles.row}>
        {icon ? (
          <Text style={[styles.label, styles[`text_${variant}`]]} allowFontScaling>
            {icon}
          </Text>
        ) : null}
        <Text
          style={[styles.label, styles[`text_${variant}`]]}
          allowFontScaling
          // Two lines at most: large text should wrap, not truncate an action.
          numberOfLines={2}
        >
          {busy ? 'Working…' : label}
        </Text>
      </View>
    </JuvaPressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 56,
    borderRadius: 19,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  dark: { backgroundColor: colors.ink, borderColor: colors.ink },
  light: { backgroundColor: colors.white, borderColor: colors.border },
  signal: { backgroundColor: colors.signal, borderColor: colors.signal },
  ghost: { backgroundColor: 'transparent', borderColor: colors.border },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  label: { ...type.bodySmall, fontWeight: '900', textAlign: 'center' },
  text_dark: { color: colors.white },
  text_light: { color: colors.ink },
  text_signal: { color: colors.ink },
  text_ghost: { color: colors.ink },
});
