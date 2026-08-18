import type { PropsWithChildren } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
export function Surface({
  children,
  dark = false,
  signal = false,
  style,
}: PropsWithChildren<{ dark?: boolean; signal?: boolean; style?: ViewStyle }>) {
  return (
    <View style={[styles.base, dark && styles.dark, signal && styles.signal, style]}>
      {children}
    </View>
  );
}
const styles = StyleSheet.create({
  base: {
    backgroundColor: colors.white,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  dark: { backgroundColor: colors.ink, borderColor: colors.ink },
  signal: { backgroundColor: colors.signal, borderColor: colors.signal },
});
