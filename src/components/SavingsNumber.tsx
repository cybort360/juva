import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import type { CurrencyCode } from '@/domain/types';
import { DURATION, EASING } from '@/motion/tokens';
import { useReducedMotionState } from '@/motion/useReducedMotion';
import { colors } from '@/theme/colors';
import { type } from '@/theme/type';
import { formatMoney } from '@/utils/money';

/** Slack after the reveal before the amount is forced to its true value. */
const SETTLE_GRACE_MS = 80;

interface Props {
  cents: number;
  currency?: CurrencyCode;
  dark?: boolean;
  size?: 'xl' | 'md';
  /** Announced instead of the raw figure, e.g. "Basket total 46 dollars 8 cents". */
  accessibilityLabel?: string;
}

/**
 * Juva's headline money figure.
 *
 * One behaviour, two situations: the value always animates from wherever it was to
 * wherever it now is. On first mount "wherever it was" is zero, which produces the
 * signature count-up; afterwards it is the previous figure, which produces a morph
 * plus a flash of direction — green when the basket got cheaper, red when it got
 * dearer. That flash is the cue that the trade-off controls actually did something.
 *
 * Correctness is never animated. The rendered value is `cents` scaled by a known
 * 0..1 factor, the timing callback pins it to the exact figure, and under reduced
 * motion the true amount renders immediately with no movement at all.
 */
export function SavingsNumber({
  cents,
  currency = 'USD',
  dark = false,
  size = 'xl',
  accessibilityLabel,
}: Props) {
  const { reduced, resolved } = useReducedMotionState();
  const [shown, setShown] = useState(reduced ? cents : 0);

  // Starts at zero so the first run is the reveal, with no separate mount path.
  const previous = useRef(0);

  /**
   * The interpolation bounds live in shared values, not refs.
   *
   * The reaction below runs on the UI thread, and a worklet cannot reliably read
   * a React ref's mutations — doing so briefly interpolated against a stale bound
   * and rendered a figure that was never between the two amounts.
   */
  const from = useSharedValue(0);
  const to = useSharedValue(cents);

  const progress = useSharedValue(1);
  /** -1 cheaper, 1 dearer. Drives the directional flash only, never a value. */
  const direction = useSharedValue(0);
  const flash = useSharedValue(0);

  useEffect(() => {
    /**
     * Wait until the reduce-motion setting is actually known.
     *
     * Native answers asynchronously, so without this the first frame assumes
     * "animate" and briefly runs a reveal for someone who asked for none — then
     * snaps. Holding the figure at its start value for the one tick it takes to
     * get the answer is invisible; animating against the setting is not.
     */
    if (!resolved) return;

    const start = previous.current;
    const isFirstReveal = start === 0;
    previous.current = cents;

    if (reduced || start === cents) {
      setShown(cents);
      from.value = cents;
      to.value = cents;
      progress.value = 1;
      return;
    }

    // Set both bounds before starting, so the reaction never sees a half-updated
    // pair on the UI thread.
    from.value = start;
    to.value = cents;
    const duration = isFirstReveal ? DURATION.reveal : DURATION.settle;

    progress.value = 0;
    progress.value = withTiming(1, { duration, easing: EASING.settle }, (finished) => {
      // Land on the exact figure however the animation ended.
      if (finished) runOnJS(setShown)(to.value);
    });

    /**
     * The guarantee that the figure is correct even if no frame ever runs.
     *
     * Reanimated is driven by animation frames, and a backgrounded tab or an app
     * that is not foregrounded receives none — the timing never progresses and its
     * completion callback never fires, which would leave a real basket reading
     * $0.00. Timers still fire in that state, so this pins the true value.
     */
    const settle = setTimeout(() => setShown(cents), duration + SETTLE_GRACE_MS);

    // A change has a direction worth showing; an arrival from zero does not.
    if (!isFirstReveal) {
      direction.value = cents > start ? 1 : -1;
      flash.value = withSequence(
        withTiming(1, { duration: DURATION.tap }),
        withTiming(0, { duration: DURATION.reveal }),
      );
    }

    return () => clearTimeout(settle);
  }, [cents, reduced, resolved, progress, direction, flash, from, to]);

  // Push to JS only when the displayed integer changes, not every frame.
  useAnimatedReaction(
    () => Math.round(from.value + (to.value - from.value) * progress.value),
    (value, last) => {
      if (value !== last) runOnJS(setShown)(value);
    },
  );

  const textStyle = useMemo(
    () => [styles.base, size === 'xl' ? type.displayXL : type.number, dark && styles.dark],
    [dark, size],
  );

  const flashStyle = useAnimatedStyle(() => ({
    opacity: flash.value * 0.9,
    backgroundColor: direction.value > 0 ? colors.red : colors.signalDeep,
  }));

  return (
    <View style={styles.wrap}>
      {/* A hairline under the figure carries the direction of the change. */}
      <Animated.View pointerEvents="none" style={[styles.flash, flashStyle]} />
      <Text
        style={textStyle}
        // The true figure is announced, never a mid-count value.
        accessibilityLabel={accessibilityLabel ?? formatMoney(cents, currency)}
        accessibilityLiveRegion="polite"
        allowFontScaling
      >
        {formatMoney(shown, currency)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'flex-start' },
  base: { color: colors.ink },
  dark: { color: colors.white },
  flash: { position: 'absolute', left: 0, right: 0, bottom: -2, height: 3, borderRadius: 2 },
});
