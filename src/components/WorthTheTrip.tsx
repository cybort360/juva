import { StyleSheet, Text, View } from 'react-native';

import { JuvaPressable } from '@/components/Pressable';
import { worthTheTripComparison } from '@/domain/optimizer';
import type { CurrencyCode, OptimizedPlan, TransportMode, UserPreferences } from '@/domain/types';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';
import { formatMoney } from '@/utils/money';

/**
 * The trade-off control.
 *
 * Every touch here re-runs the deterministic optimizer over the same observed
 * prices and rebuilds the whole plan set. Nothing is a mock-up of an alternative:
 * the comparison below is between plans that were actually generated, and the
 * numbers move because the ranking genuinely changed.
 */

interface Props {
  selected: OptimizedPlan;
  plans: readonly OptimizedPlan[];
  preferences: UserPreferences;
  currency: CurrencyCode;
  onRecompute: (patch: Partial<UserPreferences>) => void;
}

const PRIORITIES: { label: string; value: number }[] = [
  { label: 'LOWEST PRICE', value: 0 },
  { label: 'BALANCED', value: 0.5 },
  { label: 'CONVENIENCE', value: 1 },
];

const TRANSPORTS: { label: string; value: TransportMode }[] = [
  { label: 'DRIVE', value: 'drive' },
  { label: 'WALK', value: 'walk' },
  { label: 'TRANSIT', value: 'transit' },
];

function nearestPriority(value: number): number {
  return (
    PRIORITIES.reduce((best, option) =>
      Math.abs(option.value - value) < Math.abs(best.value - value) ? option : best,
    ).value ?? 0.5
  );
}

export function WorthTheTrip({ selected, plans, preferences, currency, onRecompute }: Props) {
  // Derived in the domain, not here, so what this control claims is testable: the
  // alternative is a plan the optimizer generated, and these are its own numbers.
  const { alternative, extraSavingsCents, extraMinutes, extraStops, alternativeScoresBetter } =
    worthTheTripComparison(selected, plans);
  const activePriority = nearestPriority(preferences.conveniencePreference);

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>WORTH THE TRIP?</Text>

      {alternative && extraSavingsCents > 0 ? (
        <>
          <Text style={styles.title}>
            {alternative.label} costs {formatMoney(extraSavingsCents, currency)} less on the basket.
          </Text>
          <Text style={styles.copy}>
            It needs {alternative.stops.length}{' '}
            {alternative.stops.length === 1 ? 'store' : 'stores'}
            {extraStops > 0 ? ` (${extraStops} more)` : ''} and about {Math.abs(extraMinutes)}{' '}
            {Math.abs(extraMinutes) === 1 ? 'minute' : 'minutes'}{' '}
            {extraMinutes >= 0 ? 'longer' : 'less'}. At your time value of{' '}
            {formatMoney(preferences.timeValueCentsPerMinute, currency)} per minute, Juva scores it{' '}
            {formatMoney(
              Math.abs(alternative.effectiveCostCents - selected.effectiveCostCents),
              currency,
            )}{' '}
            {alternativeScoresBetter ? 'better' : 'worse'} overall.
          </Text>
        </>
      ) : (
        <>
          <Text style={styles.title}>
            This is the lowest basket price Juva found within {preferences.radiusMiles} miles.
          </Text>
          <Text style={styles.copy}>
            No combination Juva checked, using up to {preferences.maxStores}{' '}
            {preferences.maxStores === 1 ? 'store' : 'stores'}, buys this basket for less. Change
            the trade-offs below and Juva will re-plan.
          </Text>
        </>
      )}

      <View style={styles.controls}>
        <Text style={styles.controlLabel}>MAXIMUM STORES</Text>
        <View style={styles.segments} accessibilityRole="radiogroup">
          {[1, 2, 3].map((count) => (
            <JuvaPressable
              key={count}
              feedback="select"
              accessibilityRole="radio"
              accessibilityState={{ selected: preferences.maxStores === count }}
              accessibilityLabel={`Plan with up to ${count} ${count === 1 ? 'store' : 'stores'}`}
              accessibilityHint="Re-plans the basket"
              onPress={() => onRecompute({ maxStores: count })}
              style={[styles.segment, preferences.maxStores === count && styles.segmentActive]}
            >
              <Text
                style={[
                  styles.segmentText,
                  preferences.maxStores === count && styles.segmentTextActive,
                ]}
              >
                {count}
              </Text>
            </JuvaPressable>
          ))}
        </View>

        <Text style={styles.controlLabel}>PRIORITY</Text>
        <View style={styles.segments} accessibilityRole="radiogroup">
          {PRIORITIES.map((option) => (
            <JuvaPressable
              key={option.label}
              feedback="select"
              accessibilityRole="radio"
              accessibilityState={{ selected: activePriority === option.value }}
              accessibilityLabel={`Prioritise ${option.label.toLowerCase()}`}
              accessibilityHint="Re-plans the basket"
              onPress={() => onRecompute({ conveniencePreference: option.value })}
              style={[styles.segment, activePriority === option.value && styles.segmentActive]}
            >
              <Text
                style={[
                  styles.segmentTiny,
                  activePriority === option.value && styles.segmentTextActive,
                ]}
              >
                {option.label}
              </Text>
            </JuvaPressable>
          ))}
        </View>

        <Text style={styles.controlLabel}>GETTING THERE</Text>
        <View style={styles.segments} accessibilityRole="radiogroup">
          {TRANSPORTS.map((option) => (
            <JuvaPressable
              key={option.value}
              feedback="select"
              accessibilityRole="radio"
              accessibilityState={{ selected: preferences.transportMode === option.value }}
              accessibilityLabel={`Travel by ${option.value}`}
              accessibilityHint="Re-plans the basket"
              onPress={() => onRecompute({ transportMode: option.value })}
              style={[
                styles.segment,
                preferences.transportMode === option.value && styles.segmentActive,
              ]}
            >
              <Text
                style={[
                  styles.segmentTiny,
                  preferences.transportMode === option.value && styles.segmentTextActive,
                ]}
              >
                {option.label}
              </Text>
            </JuvaPressable>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  label: { ...type.label, color: colors.signalDeep },
  title: { ...type.h2, color: colors.ink },
  copy: { ...type.bodySmall, color: colors.inkSoft },
  controls: {
    gap: 6,
    marginTop: spacing.xs,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: 'rgba(22,26,22,0.12)',
  },
  controlLabel: { ...type.label, fontSize: 9, color: colors.inkSoft, marginTop: 4 },
  segments: { flexDirection: 'row', gap: 6 },
  segment: {
    flex: 1,
    minHeight: 42,
    borderRadius: 14,
    backgroundColor: 'rgba(22,26,22,0.07)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  segmentActive: { backgroundColor: colors.ink },
  segmentText: { ...type.body, color: colors.inkSoft, fontWeight: '900' },
  segmentTiny: { ...type.label, fontSize: 8, color: colors.inkSoft, letterSpacing: 0.7 },
  segmentTextActive: { color: colors.signal },
});
