import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { FreshnessBadge } from '@/components/FreshnessBadge';
import { JuvaPressable } from '@/components/Pressable';
import type { BrandPolicy, CurrencyCode, PlanItem } from '@/domain/types';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';
import { formatMoney } from '@/utils/money';
import { observedAgo, sourceLabel } from '@/utils/observedAgo';

interface Props {
  item: PlanItem;
  currency: CurrencyCode;
  /** Changes the brand rule for this one line and re-plans. */
  onBrandPolicyChange: (groceryItemId: string, policy: BrandPolicy) => void;
}

/**
 * One priced line, with its evidence available on demand.
 *
 * The collapsed row stays as it was — product, size, price, freshness. Expanding
 * reveals what Juva actually knows: the comparison unit price, how many packs the
 * requested amount needed, what a promotion did or did not do, and how confident
 * the underlying observation is.
 *
 * A substitution is the one case where the shopper may disagree with the engine,
 * so it gets a decision rather than a notice: keep the swap, or demand the exact
 * brand and re-plan.
 */
export function PlanLine({ item, currency, onBrandPolicyChange }: Props) {
  const [expanded, setExpanded] = useState(false);

  const promotionSaved = item.promotionSavingsCents > 0;
  const packNote =
    item.packBasis === 'weighed'
      ? `${item.quantity} × ${item.sizeLabel} by weight`
      : item.quantity > 1
        ? `${item.quantity} × ${item.sizeLabel}${item.roundedUp ? ' (rounded up)' : ''}`
        : item.sizeLabel;

  return (
    <View style={styles.wrap}>
      <JuvaPressable
        onPress={() => setExpanded((value) => !value)}
        feedback="select"
        accessibilityRole="button"
        accessibilityState={{ selected: expanded }}
        accessibilityLabel={`${item.productTitle}, ${item.productBrand}, ${packNote}, ${formatMoney(item.lineTotalCents, currency)}`}
        accessibilityHint={expanded ? 'Hide the price detail' : 'Show how Juva priced this'}
        style={styles.row}
      >
        <View style={styles.text}>
          <Text style={styles.name} allowFontScaling>
            {item.productTitle}
          </Text>
          <Text style={styles.meta} allowFontScaling>
            {item.productBrand} · {packNote}
            {item.substitution ? ' · substitute' : ''}
          </Text>
          {item.promotionLabel ? (
            <Text style={[styles.promo, !promotionSaved && styles.promoUnapplied]} allowFontScaling>
              {item.promotionLabel}
            </Text>
          ) : null}
        </View>
        <View style={styles.right}>
          <Text style={styles.price} allowFontScaling>
            {formatMoney(item.lineTotalCents, currency)}
          </Text>
          <FreshnessBadge value={item.freshness} />
        </View>
      </JuvaPressable>

      {expanded ? (
        <View style={styles.detail}>
          {/* Every figure here is observed or arithmetic over observed values. */}
          <DetailRow label="Shelf price" value={formatMoney(item.listPriceCents, currency)} />
          {item.comparisonUnitPriceCents !== undefined && item.comparisonUnitLabel ? (
            <DetailRow
              label={`Unit price ${item.comparisonUnitLabel}`}
              value={formatMoney(item.comparisonUnitPriceCents, currency)}
            />
          ) : (
            <DetailRow label="Unit price" value="not comparable at this size" muted />
          )}
          {promotionSaved ? (
            <DetailRow
              label="Promotion saved"
              value={`−${formatMoney(item.promotionSavingsCents, currency)}`}
              tone="good"
            />
          ) : null}
          {item.substitution && item.substitutionSavingsCents > 0 ? (
            <DetailRow
              label="Cheaper than the brand you asked for"
              value={`−${formatMoney(item.substitutionSavingsCents, currency)}`}
              tone="good"
            />
          ) : null}
          {/*
            Where this price came from, and when.
            A freshness badge alone invites the assumption that a price is current; a source
            and a timestamp cannot be misread. The store id is included because a price is
            only ever valid at one branch.
          */}
          <DetailRow label="Source" value={sourceLabel(item.source)} />
          <DetailRow label="Store" value={item.storeId} />
          <DetailRow label="Price checked" value={observedAgo(item.observedAt)} />
          <DetailRow
            label="Price confidence"
            value={`${Math.round(item.confidence * 100)}%`}
            muted
          />

          {item.substitution ? (
            <View style={styles.decision}>
              <Text style={styles.decisionCopy} allowFontScaling>
                Juva swapped the brand you asked for. Keep it, or insist on the exact brand and Juva
                will re-plan — the item may then cost more, or become unavailable nearby.
              </Text>
              <View style={styles.decisionActions}>
                <JuvaPressable
                  onPress={() => onBrandPolicyChange(item.groceryItemId, 'exact_product')}
                  feedback="select"
                  accessibilityLabel={`Insist on the exact brand for ${item.requestedName}`}
                  style={[styles.decisionButton, styles.decisionPrimary]}
                >
                  <Text style={styles.decisionPrimaryText}>INSIST ON MY BRAND</Text>
                </JuvaPressable>
                <JuvaPressable
                  onPress={() => onBrandPolicyChange(item.groceryItemId, 'cheapest')}
                  feedback="select"
                  accessibilityLabel={`Always take the cheapest option for ${item.requestedName}`}
                  style={styles.decisionButton}
                >
                  <Text style={styles.decisionText}>ALWAYS CHEAPEST</Text>
                </JuvaPressable>
              </View>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function DetailRow({
  label,
  value,
  tone,
  muted,
}: {
  label: string;
  value: string;
  tone?: 'good';
  muted?: boolean;
}) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel} allowFontScaling>
        {label}
      </Text>
      <Text
        style={[
          styles.detailValue,
          tone === 'good' && styles.detailGood,
          muted && styles.detailMuted,
        ]}
        allowFontScaling
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  text: { flex: 1 },
  name: { ...type.bodySmall, color: colors.ink, fontWeight: '900' },
  meta: { ...type.bodySmall, fontSize: 12, color: colors.muted, marginTop: 2 },
  promo: {
    ...type.bodySmall,
    fontSize: 11,
    color: colors.signalDeep,
    fontWeight: '900',
    marginTop: 3,
  },
  promoUnapplied: { color: colors.muted },
  right: { alignItems: 'flex-end', gap: 6 },
  price: { ...type.bodySmall, color: colors.ink, fontWeight: '900' },
  detail: { gap: 2, marginTop: spacing.sm, paddingLeft: 2 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  detailLabel: { ...type.bodySmall, fontSize: 11, color: colors.muted, flex: 1 },
  detailValue: { ...type.bodySmall, fontSize: 11, color: colors.ink, fontWeight: '800' },
  detailGood: { color: colors.signalDeep },
  detailMuted: { color: colors.muted, fontWeight: '500' },
  decision: {
    gap: spacing.xs,
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: 14,
    backgroundColor: colors.blueSoft,
  },
  decisionCopy: { ...type.bodySmall, fontSize: 11, lineHeight: 16, color: colors.inkSoft },
  decisionActions: { flexDirection: 'row', gap: spacing.xs, flexWrap: 'wrap' },
  decisionButton: {
    borderRadius: 10,
    backgroundColor: 'rgba(22,26,22,0.07)',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  decisionPrimary: { backgroundColor: colors.ink },
  decisionText: { ...type.label, fontSize: 8, color: colors.inkSoft },
  decisionPrimaryText: { ...type.label, fontSize: 8, color: colors.signal },
});
