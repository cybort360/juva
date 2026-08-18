import { StyleSheet, Text } from 'react-native';

import { colors } from '@/theme/colors';
import { type } from '@/theme/type';
export function SectionLabel({ children }: { children: string }) {
  return <Text style={styles.text}>{children.toUpperCase()}</Text>;
}
const styles = StyleSheet.create({ text: { ...type.label, color: colors.muted } });
