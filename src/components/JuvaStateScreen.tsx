import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';

interface Props {
  eyebrow: string;
  title: string;
  copy?: string;
  detail?: string;
  action?: ReactNode;
}

/**
 * The shared full-bleed surface behind Juva's loading, error and not-found
 * states. Keeps those moments inside the product's own visual language instead
 * of falling back to a stock React Native screen.
 */
export function JuvaStateScreen({ eyebrow, title, copy, detail, action }: Props) {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.body}>
        <Text style={styles.logo}>JUVA</Text>
        <View style={styles.copyBlock}>
          <Text style={styles.eyebrow}>{eyebrow}</Text>
          <Text style={styles.title}>{title}</Text>
          {copy ? <Text style={styles.copy}>{copy}</Text> : null}
          {detail ? (
            <View style={styles.detail}>
              <Text style={styles.detailText}>{detail}</Text>
            </View>
          ) : null}
        </View>
        {action ? <View style={styles.action}>{action}</View> : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  body: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
    justifyContent: 'space-between',
  },
  logo: { ...type.label, color: colors.ink, fontSize: 15, letterSpacing: 3.5 },
  copyBlock: { gap: spacing.sm, paddingBottom: spacing.xl },
  eyebrow: { ...type.label, color: colors.signalDeep },
  title: { ...type.display, color: colors.ink, maxWidth: 340 },
  copy: { ...type.body, color: colors.muted, maxWidth: 340 },
  detail: {
    marginTop: spacing.sm,
    borderRadius: 18,
    backgroundColor: colors.paperStrong,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  detailText: { ...type.bodySmall, fontSize: 12, lineHeight: 18, color: colors.inkSoft },
  action: { gap: spacing.xs },
});
