import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';

export function TopBar({
  title = 'Juva',
  eyebrow,
  back = false,
  right,
}: {
  title?: string;
  eyebrow?: string;
  back?: boolean;
  right?: ReactNode;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.leftRow}>
        {back ? (
          <Pressable onPress={() => router.back()} style={styles.back} hitSlop={10}>
            <Text style={styles.backText}>‹</Text>
          </Pressable>
        ) : null}
        <View>
          {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
          <Text style={styles.title}>{title}</Text>
        </View>
      </View>
      {right ?? <View />}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  leftRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  back: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.white,
  },
  backText: { color: colors.ink, fontSize: 31, lineHeight: 32, marginTop: -2 },
  eyebrow: { ...type.label, color: colors.muted },
  title: { color: colors.ink, fontSize: 19, fontWeight: '900', letterSpacing: -0.4 },
});
