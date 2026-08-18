import type { PropsWithChildren, ReactNode } from 'react';
import { StyleSheet, View, type ScrollViewProps } from 'react-native';
// Gesture Handler's ScrollView, not React Native's. The core one is a plain
// UIScrollView on iOS whose recognizer does not join Gesture Handler's arena, so it
// cancelled Shop Mode's swipe-to-collect pan mid-drag — `onEnd` never fired and the
// swipe silently committed nothing. This one negotiates with the gestures inside it.
import { ScrollView } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';

type Props = PropsWithChildren<{
  footer?: ReactNode;
  scroll?: boolean;
  contentStyle?: ScrollViewProps['contentContainerStyle'];
}>;

export function AppScreen({ children, footer, scroll = true, contentStyle }: Props) {
  const body = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[styles.content, contentStyle]}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, styles.content, contentStyle]}>{children}</View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      {body}
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  flex: { flex: 1 },
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: 120,
    gap: spacing.lg,
  },
  footer: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    backgroundColor: colors.paper,
  },
});
