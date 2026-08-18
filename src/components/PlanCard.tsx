import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CurrencyCode, OptimizedPlan } from '@/domain/types';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';
import { formatMoney } from '@/utils/money';

interface Props {
  plan: OptimizedPlan;
  currency?: CurrencyCode;
  selected?: boolean;
  onPress: () => void;
}

export function PlanCard({ plan, currency = 'USD', selected, onPress }: Props) {
  // Single-stop plans are the baseline, so they have nothing to save against it.
  const delta = plan.stops.length === 1 ? 0 : plan.savingsVsBaselineCents;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, selected && styles.selected, pressed && styles.pressed]}
    >
      <View style={styles.top}>
        <Text style={styles.label}>{plan.label.toUpperCase()}</Text>
        {selected ? <Text style={styles.chosen}>JUVA PICK</Text> : null}
      </View>
      <Text style={[styles.price, selected && styles.selectedText]}>
        {formatMoney(plan.basketCostCents, currency)}
      </Text>
      <Text style={[styles.meta, selected && styles.selectedMuted]}>
        {plan.stops.length} {plan.stops.length === 1 ? 'store' : 'stores'} ·{' '}
        {plan.travelMiles.toFixed(1)} mi · ~{plan.etaMinutes} min
      </Text>
      {delta > 0 ? (
        <Text style={[styles.save, selected && styles.selectedSave]}>
          Save {formatMoney(delta, currency)} vs one stop
        </Text>
      ) : (
        <Text style={[styles.neutral, selected && styles.selectedMuted]}>
          Everything in one trip
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 250,
    backgroundColor: colors.white,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  selected: { backgroundColor: colors.ink, borderColor: colors.ink },
  pressed: { transform: [{ scale: 0.985 }] },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { ...type.label, color: colors.muted },
  chosen: { ...type.label, fontSize: 8, color: colors.signal },
  price: { ...type.h1, color: colors.ink },
  meta: { ...type.bodySmall, color: colors.muted },
  save: { ...type.bodySmall, color: colors.signalDeep, fontWeight: '900', marginTop: spacing.xs },
  neutral: { ...type.bodySmall, color: colors.muted, fontWeight: '800', marginTop: spacing.xs },
  selectedText: { color: colors.white },
  selectedMuted: { color: 'rgba(255,255,255,0.65)' },
  selectedSave: { color: colors.signal },
});
