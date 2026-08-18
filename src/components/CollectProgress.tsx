import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { DURATION, SPRING } from '@/motion/tokens';
import { useReducedMotion } from '@/motion/useReducedMotion';
import { colors } from '@/theme/colors';

/**
 * How far through a store's checklist the shopper is.
 *
 * The bar springs rather than eases, so ticking an item off feels like it landed.
 * The value is exposed to assistive tech as a real progress bar with min, max and
 * current, rather than as a decorative view.
 */
export function CollectProgress({ collected, total }: { collected: number; total: number }) {
  const reduced = useReducedMotion();
  const fraction = total > 0 ? collected / total : 0;
  const progress = useSharedValue(fraction);

  useEffect(() => {
    progress.value = reduced
      ? withTiming(fraction, { duration: DURATION.tap })
      : withSpring(fraction, SPRING.surface);
  }, [fraction, progress, reduced]);

  const fillStyle = useAnimatedStyle(() => ({
    width: `${Math.max(0, Math.min(1, progress.value)) * 100}%`,
  }));

  return (
    <View
      style={styles.track}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: total, now: collected }}
      accessibilityLabel={`${collected} of ${total} items collected`}
    >
      <Animated.View style={[styles.fill, fillStyle]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 5,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  fill: { height: 5, backgroundColor: colors.signal, borderRadius: 6 },
});
