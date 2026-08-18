import { useEffect } from 'react';
import { StyleSheet, View, type DimensionValue } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { DURATION, EASING } from '@/motion/tokens';
import { useReducedMotion } from '@/motion/useReducedMotion';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';

/**
 * Placeholder shapes for content that is on its way.
 *
 * A shimmer would be the obvious choice and the wrong one here — Juva's surfaces
 * are paper, and a moving highlight reads as glass. These breathe in opacity
 * instead, which matches the rest of the product's ambient motion.
 *
 * Skeletons are hidden from assistive tech: a screen reader should hear the
 * loading announcement once, not a list of empty boxes.
 */
export function SkeletonBlock({
  width = '100%',
  height = 16,
  radius = 8,
  delay = 0,
}: {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  delay?: number;
}) {
  const reduced = useReducedMotion();
  const pulse = useSharedValue(0.5);

  useEffect(() => {
    if (reduced) {
      pulse.value = 0.5;
      return;
    }
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: DURATION.breathe, easing: EASING.breathe }),
        withTiming(0.45, { duration: DURATION.breathe, easing: EASING.breathe }),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(pulse);
  }, [pulse, reduced, delay]);

  const style = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width, height, borderRadius: radius }, styles.block, style]}
    />
  );
}

/**
 * The shape of a plan while it is being built: a headline figure, a couple of
 * metrics, and a route. Matching the real layout stops the screen from jumping
 * when the content lands.
 */
export function PlanSkeleton() {
  return (
    <View
      style={styles.plan}
      accessibilityRole="progressbar"
      accessibilityLabel="Building your plan"
    >
      <View style={styles.hero}>
        <SkeletonBlock width={110} height={11} radius={6} />
        <SkeletonBlock width={190} height={44} radius={12} delay={80} />
        <SkeletonBlock width="70%" height={13} delay={140} />
        <View style={styles.pills}>
          <SkeletonBlock width={74} height={30} radius={999} delay={180} />
          <SkeletonBlock width={64} height={30} radius={999} delay={220} />
          <SkeletonBlock width={80} height={30} radius={999} delay={260} />
        </View>
      </View>
      <View style={styles.route}>
        {[0, 1].map((index) => (
          <View key={index} style={styles.routeRow}>
            <SkeletonBlock width={13} height={13} radius={7} delay={300 + index * 60} />
            <View style={styles.routeText}>
              <SkeletonBlock width="55%" height={14} delay={320 + index * 60} />
              <SkeletonBlock width="35%" height={11} delay={360 + index * 60} />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { backgroundColor: colors.paperStrong },
  plan: { gap: spacing.lg },
  hero: {
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
  },
  pills: { flexDirection: 'row', gap: spacing.xs, marginTop: spacing.xs },
  route: {
    gap: spacing.md,
    backgroundColor: colors.white,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  routeRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  routeText: { flex: 1, gap: 6 },
});
