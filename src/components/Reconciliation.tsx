import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import type { CurrencyCode } from '@/domain/types';
import { DURATION, EASING } from '@/motion/tokens';
import { useReducedMotion } from '@/motion/useReducedMotion';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';
import { formatMoney } from '@/utils/money';

interface Props {
  expectedCents: number;
  actualCents: number;
  currency: CurrencyCode;
}

/**
 * Expected against actual, reconciled.
 *
 * The two figures arrive, then a bar travels between them in the direction of the
 * difference — right when the shopper paid more than planned, left when they paid
 * less. That direction is the whole point of the screen, so it is carried by
 * movement and by colour and by words, not by colour alone.
 *
 * Under reduced motion the bar is simply drawn in its final position.
 */
export function Reconciliation({ expectedCents, actualCents, currency }: Props) {
  const reduced = useReducedMotion();
  const deltaCents = actualCents - expectedCents;
  const paidMore = deltaCents > 0;
  const matched = deltaCents === 0;

  const drawn = useSharedValue(reduced ? 1 : 0);

  useEffect(() => {
    if (reduced) {
      drawn.value = 1;
      return;
    }
    drawn.value = withDelay(
      DURATION.settle,
      withTiming(1, { duration: DURATION.reveal, easing: EASING.settle }),
    );
  }, [drawn, reduced, expectedCents, actualCents]);

  const barStyle = useAnimatedStyle(() => ({
    transform: [{ scaleX: drawn.value }],
  }));

  const arrowStyle = useAnimatedStyle(() => ({
    opacity: drawn.value,
    transform: [{ translateX: (paidMore ? 1 : -1) * (1 - drawn.value) * -14 }],
  }));

  const deltaLabel = matched
    ? 'Matched the plan exactly.'
    : `${paidMore ? 'You paid' : 'You saved'} ${formatMoney(Math.abs(deltaCents), currency)} ${paidMore ? 'more than planned' : 'against the plan'}.`;

  return (
    <View
      style={styles.wrap}
      accessibilityRole="summary"
      accessibilityLabel={`Juva expected ${formatMoney(expectedCents, currency)}. You paid ${formatMoney(actualCents, currency)}. ${deltaLabel}`}
    >
      <View style={styles.row}>
        <View style={styles.col}>
          <Text style={styles.label} allowFontScaling>
            JUVA EXPECTED
          </Text>
          <Text style={styles.value} allowFontScaling>
            {formatMoney(expectedCents, currency)}
          </Text>
        </View>
        <Animated.View style={[styles.arrow, arrowStyle]}>
          <Text style={styles.arrowText}>{matched ? '=' : paidMore ? '→' : '←'}</Text>
        </Animated.View>
        <View style={[styles.col, styles.colRight]}>
          <Text style={styles.label} allowFontScaling>
            YOU PAID
          </Text>
          <Text style={styles.value} allowFontScaling>
            {formatMoney(actualCents, currency)}
          </Text>
        </View>
      </View>

      {/* The travelling bar: grows from the side the money moved away from. */}
      <View style={styles.track}>
        <Animated.View
          style={[
            styles.bar,
            matched ? styles.barMatched : paidMore ? styles.barOver : styles.barUnder,
            paidMore ? styles.fromLeft : styles.fromRight,
            barStyle,
          ]}
        />
      </View>

      <Text
        style={[
          styles.delta,
          matched ? styles.deltaFlat : paidMore ? styles.deltaOver : styles.deltaUnder,
        ]}
        allowFontScaling
      >
        {deltaLabel}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  col: { flex: 1 },
  colRight: { alignItems: 'flex-end' },
  label: { ...type.label, color: colors.muted, fontSize: 9 },
  value: { ...type.h1, color: colors.ink, marginTop: 4 },
  arrow: {
    width: 42,
    height: 42,
    borderRadius: 15,
    backgroundColor: colors.paperStrong,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: spacing.xs,
  },
  arrowText: { fontSize: 20, color: colors.ink },
  track: {
    height: 4,
    borderRadius: 3,
    backgroundColor: colors.paperStrong,
    overflow: 'hidden',
  },
  bar: { height: 4, borderRadius: 3 },
  fromLeft: { transformOrigin: 'left' },
  fromRight: { transformOrigin: 'right' },
  barOver: { backgroundColor: colors.red },
  barUnder: { backgroundColor: colors.signalDeep },
  barMatched: { backgroundColor: colors.line },
  delta: { ...type.bodySmall, fontWeight: '900' },
  deltaOver: { color: colors.red },
  deltaUnder: { color: colors.signalDeep },
  deltaFlat: { color: colors.muted },
});
