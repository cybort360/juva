import { StyleSheet, Text, View } from 'react-native';

import { JuvaPressable } from '@/components/Pressable';
import { Surface } from '@/components/Surface';
import type { AdaptDecision } from '@/domain/shopAdapt';
import type { AdaptOption, CurrencyCode } from '@/domain/types';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';
import { formatMoney } from '@/utils/money';

/**
 * What Juva makes of a change at the shelf.
 *
 * Deliberately plain. The shopper is standing in an aisle, possibly holding a basket,
 * and the job is to answer one question — buy it here or not — in as few words as the
 * arithmetic allows. Every option is a large target, the recommendation is marked, and
 * nothing is hidden behind a disclosure: an option the shopper cannot see is an option
 * Juva effectively made for them.
 */

interface Props {
  decision: AdaptDecision;
  currency: CurrencyCode;
  onChoose: (optionId: string) => void;
  onDismiss: () => void;
}

/** The cost of an option in the shopper's terms: money, and time if it costs any. */
function optionCost(option: AdaptOption, currency: CurrencyCode): string {
  if (option.kind === 'drop_item') return 'leaves the basket';
  const money = formatMoney(option.lineTotalCents, currency);
  if (option.extraMinutes > 0) return `${money} · +${option.extraMinutes} min`;
  if (option.extraMinutes < 0) return `${money} · ${option.extraMinutes} min`;
  return money;
}

export function ShelfChange({ decision, currency, onChoose, onDismiss }: Props) {
  return (
    <Surface>
      <Text style={styles.headline}>{decision.headline}</Text>
      <Text style={styles.detail} allowFontScaling>
        {decision.detail}
      </Text>

      <View style={styles.divider} />
      <Text style={styles.recommendLabel}>JUVA RECOMMENDS</Text>
      <Text style={styles.recommend} allowFontScaling>
        {decision.recommendation}
      </Text>

      <View style={styles.options}>
        {decision.options
          // A dropped line is offered last and never sold as a saving.
          .filter((option) => option.feasible)
          .map((option) => {
            const isRecommended = option.id === decision.recommended.id;
            return (
              <JuvaPressable
                key={option.id}
                onPress={() => onChoose(option.id)}
                feedback="select"
                accessibilityRole="button"
                accessibilityLabel={`${option.label}, ${optionCost(option, currency)}`}
                accessibilityHint={
                  isRecommended ? 'This is what Juva recommends' : 'Choose this instead'
                }
                style={[styles.option, isRecommended && styles.optionRecommended]}
              >
                <View style={styles.optionBody}>
                  <Text
                    style={[styles.optionLabel, isRecommended && styles.optionLabelRecommended]}
                    allowFontScaling
                  >
                    {option.label}
                  </Text>
                  <Text
                    style={[styles.optionMeta, isRecommended && styles.optionMetaRecommended]}
                    allowFontScaling
                  >
                    {optionCost(option, currency)}
                  </Text>
                </View>
                {isRecommended ? <Text style={styles.tick}>◉</Text> : null}
              </JuvaPressable>
            );
          })}
      </View>

      {/* Every recommendation is overridable, and saying so is part of the design:
          Juva is advising, not deciding. */}
      <JuvaPressable
        onPress={onDismiss}
        feedback="tap"
        accessibilityRole="button"
        accessibilityLabel="Keep the plan as it is"
        style={styles.dismiss}
      >
        <Text style={styles.dismissText}>KEEP THE PLAN AS IT IS</Text>
      </JuvaPressable>
    </Surface>
  );
}

const styles = StyleSheet.create({
  headline: { ...type.label, color: colors.signalDeep },
  detail: { ...type.body, color: colors.ink, lineHeight: 24 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs },
  recommendLabel: { ...type.label, fontSize: 9, color: colors.muted },
  recommend: { ...type.h2, color: colors.ink },
  options: { gap: 8, marginTop: spacing.xs },
  option: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: 16,
    backgroundColor: colors.paperStrong,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  optionRecommended: { backgroundColor: colors.ink },
  optionBody: { flex: 1 },
  optionLabel: { ...type.body, color: colors.ink, fontWeight: '900' },
  optionLabelRecommended: { color: colors.white },
  optionMeta: { ...type.bodySmall, fontSize: 12, color: colors.muted, marginTop: 2 },
  optionMetaRecommended: { color: colors.signal },
  tick: { color: colors.signal, fontSize: 18 },
  dismiss: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xs,
  },
  dismissText: { ...type.label, fontSize: 9, color: colors.muted },
});
