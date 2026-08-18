import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolateColor,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { JuvaPressable } from '@/components/Pressable';
import type { CurrencyCode, TripItem } from '@/domain/types';
import { hapticCollect, hapticSelect } from '@/motion/haptics';
import { DURATION, SPRING } from '@/motion/tokens';
import { useReducedMotion } from '@/motion/useReducedMotion';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';
import { formatMoney } from '@/utils/money';

interface Props {
  item: TripItem;
  currency: CurrencyCode;
  onToggle: () => void;
  onSkip: () => void;
  onCorrectPrice: () => void;
  /** The price-entry row, rendered by the screen when this line is being edited. */
  editor?: React.ReactNode;
}

/** How far the row must travel before releasing commits the action. */
const COMMIT_DISTANCE = 78;
/** Travel is damped past this, so the row resists rather than sliding away. */
const MAX_TRAVEL = 120;

/**
 * One line of the in-store checklist.
 *
 * Collecting an item is the most repeated action in the product, and it happens
 * one-handed with a basket in the other, so it has three routes: tap the row,
 * tap a button, or swipe. Swipe right collects, swipe left skips.
 *
 * The gesture yields to vertical scrolling — the list is long and scrolling must
 * always win — and a haptic fires at the commit threshold rather than on release,
 * so the row feels like it has a detent you can find without looking.
 *
 * Both gesture actions are also plain controls — the row itself is the collect
 * checkbox and skip is a button — because a swipe is invisible to a screen reader
 * and undiscoverable without one.
 */
export function ChecklistItem({ item, currency, onToggle, onSkip, onCorrectPrice, editor }: Props) {
  const reduced = useReducedMotion();
  const collected = item.status === 'collected';
  // An unavailable line reads like a skipped one: it is not coming home either way.
  const skipped = item.status === 'skipped' || item.status === 'unavailable';
  // Every other status is a report that the shelf disagreed with the plan, and the row
  // shows the corrected figure rather than the planned one.
  const corrected =
    item.status === 'different_price' ||
    item.status === 'different_package' ||
    item.status === 'substituted' ||
    item.status === 'quantity_changed';

  const check = useSharedValue(collected ? 1 : 0);
  const translateX = useSharedValue(0);
  /** 1 once the row has passed the commit threshold, for the detent haptic. */
  const armed = useSharedValue(0);

  useEffect(() => {
    const target = collected ? 1 : 0;
    check.value = reduced
      ? withTiming(target, { duration: DURATION.tap })
      : withSpring(target, SPRING.tactile);
  }, [collected, check, reduced]);

  const pan = Gesture.Pan()
    // Horizontal intent only, and vertical intent cancels: scrolling wins.
    .activeOffsetX([-16, 16])
    .failOffsetY([-14, 14])
    .onUpdate((event) => {
      // Damp past the maximum so the row resists instead of flying off.
      const raw = event.translationX;
      const clamped =
        Math.sign(raw) * Math.min(Math.abs(raw), MAX_TRAVEL + (Math.abs(raw) - MAX_TRAVEL) * 0.2);
      translateX.value = Math.abs(raw) > MAX_TRAVEL ? clamped : raw;

      const past = Math.abs(raw) >= COMMIT_DISTANCE ? 1 : 0;
      if (past !== armed.value) {
        armed.value = past;
        // Fire at the threshold, not on release, so the detent is findable.
        if (past === 1) runOnJS(hapticSelect)();
      }
    })
    .onEnd((event) => {
      const travelled = event.translationX;
      translateX.value = withSpring(0, SPRING.surface);
      armed.value = 0;
      if (travelled >= COMMIT_DISTANCE) runOnJS(onToggle)();
      else if (travelled <= -COMMIT_DISTANCE) runOnJS(onSkip)();
    });

  const boxStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(check.value, [0, 1], ['transparent', colors.ink]),
    borderColor: interpolateColor(check.value, [0, 1], [colors.line, colors.ink]),
    transform: [{ scale: reduced ? 1 : 1 + check.value * 0.06 }],
  }));

  const tickStyle = useAnimatedStyle(() => ({
    opacity: check.value,
    transform: [{ scale: 0.6 + check.value * 0.4 }],
  }));

  const rowStyle = useAnimatedStyle(() => ({
    opacity: 1 - check.value * 0.42,
    transform: [{ translateX: translateX.value }],
  }));

  // The hints behind the row fade in with travel, on the side being revealed.
  const collectHintStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.max(0, translateX.value / COMMIT_DISTANCE)),
  }));
  const skipHintStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.max(0, -translateX.value / COMMIT_DISTANCE)),
  }));

  // The shopper's own observation wins over the plan, and the quantity they actually
  // took wins over the one that was planned.
  const priceCents =
    item.actualPriceCents === undefined
      ? item.lineTotalCents
      : Math.round(item.actualPriceCents * (item.actualQuantity ?? item.quantity));
  const statusWord = collected
    ? 'collected'
    : item.status === 'unavailable'
      ? 'not available here'
      : skipped
        ? 'skipped'
        : item.status === 'substituted'
          ? 'substituted'
          : item.status === 'different_package'
            ? 'different pack'
            : item.status === 'quantity_changed'
              ? 'quantity changed'
              : corrected
                ? 'price corrected'
                : 'not collected';

  return (
    <View style={styles.item}>
      {/* Revealed behind the row as it travels. Decorative: the row carries the
          semantics, and the same actions exist as buttons and a11y actions. */}
      <View
        style={styles.hints}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Animated.Text style={[styles.hint, styles.hintCollect, collectHintStyle]}>
          {collected ? '↺ UNDO' : '✓ COLLECT'}
        </Animated.Text>
        <Animated.Text style={[styles.hint, styles.hintSkip, skipHintStyle]}>
          {skipped ? '↺ UNDO' : 'SKIP ✕'}
        </Animated.Text>
      </View>

      <GestureDetector gesture={pan}>
        <Animated.View style={rowStyle}>
          <JuvaPressable
            onPress={onToggle}
            feedback="none"
            style={styles.hit}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: collected }}
            accessibilityLabel={`${item.productTitle}, ${item.productBrand}, ${item.sizeLabel}, ${formatMoney(priceCents, currency)}, ${statusWord}`}
            accessibilityHint={
              collected ? 'Double tap to un-collect' : 'Double tap to mark collected'
            }
          >
            <Animated.View style={[styles.checkbox, boxStyle]}>
              <Animated.Text style={[styles.checkText, tickStyle]}>✓</Animated.Text>
            </Animated.View>

            <View style={styles.body}>
              <Text
                style={[styles.name, collected && styles.struck, skipped && styles.skipped]}
                allowFontScaling
              >
                {item.productTitle}
              </Text>
              <Text style={styles.meta} allowFontScaling>
                {item.productBrand} · {item.sizeLabel}
              </Text>
              {item.promotionLabel ? (
                <Text style={styles.promo} allowFontScaling>
                  {item.promotionLabel}
                </Text>
              ) : null}
            </View>

            <Text style={[styles.price, corrected && styles.priceCorrected]} allowFontScaling>
              {formatMoney(priceCents, currency)}
            </Text>
          </JuvaPressable>
        </Animated.View>
      </GestureDetector>

      {editor ?? (
        <View style={styles.actions}>
          <JuvaPressable
            onPress={onCorrectPrice}
            feedback="select"
            style={styles.action}
            accessibilityLabel={`Correct the shelf price for ${item.productTitle}`}
          >
            <Text style={styles.actionText}>PRICE IS DIFFERENT</Text>
          </JuvaPressable>
          <JuvaPressable
            onPress={onSkip}
            feedback="select"
            style={styles.action}
            accessibilityLabel={`${skipped ? 'Un-skip' : 'Skip'} ${item.productTitle}`}
            accessibilityState={{ selected: skipped }}
          >
            <Text style={[styles.actionText, skipped && styles.actionActive]}>
              {skipped ? 'SKIPPED' : 'SKIP'}
            </Text>
          </JuvaPressable>
        </View>
      )}
    </View>
  );
}

/** Re-exported so the screen can fire the same cue when it toggles from elsewhere. */
export { hapticCollect, hapticSelect };

const styles = StyleSheet.create({
  item: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: spacing.sm,
    // Keeps the revealed hints from bleeding past the row.
    overflow: 'hidden',
  },
  hints: {
    ...StyleSheet.absoluteFill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
  },
  hint: { ...type.label, fontSize: 9 },
  hintCollect: { color: colors.signalDeep },
  hintSkip: { color: colors.red },
  hit: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    minHeight: 64,
    paddingVertical: spacing.xs,
    // Opaque so the hints sit behind rather than showing through.
    backgroundColor: colors.paper,
  },
  checkbox: {
    width: 30,
    height: 30,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  checkText: { color: colors.signal, fontWeight: '900', fontSize: 15 },
  body: { flex: 1 },
  name: { ...type.body, color: colors.ink, fontWeight: '900' },
  struck: { textDecorationLine: 'line-through' },
  skipped: { color: colors.muted },
  meta: { ...type.bodySmall, color: colors.muted, marginTop: 2 },
  promo: {
    ...type.bodySmall,
    fontSize: 11,
    color: colors.signalDeep,
    fontWeight: '900',
    marginTop: 3,
  },
  price: { ...type.bodySmall, color: colors.ink, fontWeight: '900', marginTop: 3 },
  priceCorrected: { color: colors.blue },
  actions: { flexDirection: 'row', gap: spacing.xs, paddingLeft: 46 },
  action: {
    borderRadius: 10,
    backgroundColor: colors.paperStrong,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  actionText: { ...type.label, fontSize: 8, color: colors.inkSoft },
  actionActive: { color: colors.red },
});
