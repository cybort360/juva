import { StyleSheet, Text, View } from 'react-native';

import { colors } from '@/theme/colors';
import { type } from '@/theme/type';
export function MetricPill({ label, dark = false }: { label: string; dark?: boolean }) {
  return (
    <View style={[styles.base, dark && styles.dark]}>
      <Text style={[styles.text, dark && styles.textDark]}>{label}</Text>
    </View>
  );
}
const styles = StyleSheet.create({
  base: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.paperStrong,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dark: { backgroundColor: 'rgba(255,255,255,0.08)', borderColor: 'rgba(255,255,255,0.12)' },
  text: { ...type.bodySmall, color: colors.ink, fontWeight: '800' },
  textDark: { color: colors.white },
});
