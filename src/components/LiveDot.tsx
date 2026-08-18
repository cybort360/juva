import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
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

/**
 * The ambient "something is happening" dot.
 *
 * A slow halo breathing outward, not a blink: it should read as a system that is
 * alive rather than an alert demanding attention. Under reduced motion the halo
 * holds at its resting size, so the dot still distinguishes active from inactive
 * without any movement.
 */
export function LiveDot({ active = true }: { active?: boolean }) {
  const reduced = useReducedMotion();
  const pulse = useSharedValue(0);

  useEffect(() => {
    if (!active || reduced) {
      cancelAnimation(pulse);
      pulse.value = withTiming(active && reduced ? 0.5 : 0, { duration: DURATION.snap });
      return;
    }
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: DURATION.breathe, easing: EASING.breathe }),
        withTiming(0, { duration: DURATION.breathe, easing: EASING.breathe }),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(pulse);
  }, [active, reduced, pulse]);

  const haloStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + pulse.value * 0.7 }],
    opacity: 0.28 - pulse.value * 0.16,
  }));

  return (
    // Purely decorative: the surrounding label carries the meaning.
    <View
      style={styles.wrap}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {active ? <Animated.View style={[styles.halo, haloStyle]} /> : null}
      <View style={[styles.dot, !active && styles.off]} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: 16, height: 16, alignItems: 'center', justifyContent: 'center' },
  halo: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.signal,
  },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.signal },
  off: { backgroundColor: colors.line },
});
