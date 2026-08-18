import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import type { CurrencyCode, PlanStop } from '@/domain/types';
import { DURATION, EASING } from '@/motion/tokens';
import { useReducedMotion } from '@/motion/useReducedMotion';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';
import { formatMoney } from '@/utils/money';

interface Props {
  stops: PlanStop[];
  currency?: CurrencyCode;
}

/**
 * The route, drawn rather than listed.
 *
 * Each stop arrives in order and the connecting line grows between them, so the
 * shopper reads the trip as a sequence they will actually walk or drive. The
 * stagger is what makes it a route instead of a list.
 */
export function StoreRoute({ stops, currency = 'USD' }: Props) {
  return (
    <View
      style={styles.wrap}
      accessibilityRole="list"
      accessibilityLabel={`Route with ${stops.length} ${stops.length === 1 ? 'stop' : 'stops'}`}
    >
      {stops.map((stop, index) => (
        <RouteStop
          key={stop.store.id}
          stop={stop}
          index={index}
          isLast={index === stops.length - 1}
          currency={currency}
        />
      ))}
    </View>
  );
}

function RouteStop({
  stop,
  index,
  isLast,
  currency,
}: {
  stop: PlanStop;
  index: number;
  isLast: boolean;
  currency: CurrencyCode;
}) {
  const reduced = useReducedMotion();
  // Rebuilt whenever the plan changes, so `stop.store.id` keying gives each new
  // route its own draw rather than reusing a finished one.
  const drawn = useSharedValue(reduced ? 1 : 0);

  useEffect(() => {
    if (reduced) {
      drawn.value = 1;
      return;
    }
    drawn.value = withDelay(
      index * DURATION.draw * 0.45,
      withTiming(1, { duration: DURATION.draw, easing: EASING.enter }),
    );
  }, [drawn, index, reduced]);

  const nodeStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 0.4 + drawn.value * 0.6 }],
    opacity: drawn.value,
  }));

  // The line grows downward from the node above it.
  const lineStyle = useAnimatedStyle(() => ({
    transform: [{ scaleY: drawn.value }],
  }));

  const contentStyle = useAnimatedStyle(() => ({
    opacity: drawn.value,
    transform: [{ translateX: (1 - drawn.value) * 10 }],
  }));

  const itemCount = stop.items.length;

  return (
    <View
      style={styles.row}
      accessibilityRole="text"
      accessibilityLabel={`Stop ${index + 1}: ${stop.store.retailerName}, ${itemCount} ${
        itemCount === 1 ? 'item' : 'items'
      }, ${formatMoney(stop.subtotalCents, currency)}, ${stop.store.distanceMiles.toFixed(1)} miles away`}
    >
      <View style={styles.track}>
        <Animated.View style={[styles.node, index === 0 && styles.nodeActive, nodeStyle]} />
        {!isLast ? <Animated.View style={[styles.line, lineStyle]} /> : null}
      </View>
      <Animated.View style={[styles.content, contentStyle]}>
        <Text style={styles.store} allowFontScaling>
          {stop.store.retailerName}
        </Text>
        <Text style={styles.meta} allowFontScaling>
          {itemCount} {itemCount === 1 ? 'item' : 'items'} ·{' '}
          {formatMoney(stop.subtotalCents, currency)}
        </Text>
        <Text style={styles.distance} allowFontScaling>
          {stop.store.distanceMiles.toFixed(1)} mi away
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 0 },
  row: { flexDirection: 'row', minHeight: 74 },
  track: { width: 34, alignItems: 'center' },
  node: {
    width: 13,
    height: 13,
    borderRadius: 7,
    marginTop: 6,
    backgroundColor: colors.ink,
    borderWidth: 3,
    borderColor: colors.paperStrong,
  },
  nodeActive: { backgroundColor: colors.signalDeep },
  line: {
    flex: 1,
    width: 1.5,
    backgroundColor: colors.line,
    marginVertical: 4,
    // Grow downward from the node rather than outward from the middle.
    transformOrigin: 'top',
  },
  content: { flex: 1, paddingBottom: spacing.md },
  store: { ...type.body, color: colors.ink, fontWeight: '900' },
  meta: { ...type.bodySmall, color: colors.inkSoft, marginTop: 2 },
  distance: { ...type.bodySmall, color: colors.muted, marginTop: 2 },
});
