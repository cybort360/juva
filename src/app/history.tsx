import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { JuvaButton } from '@/components/JuvaButton';
import { JuvaRail } from '@/components/JuvaRail';
import { SavingsNumber } from '@/components/SavingsNumber';
import { SectionLabel } from '@/components/SectionLabel';
import { Surface } from '@/components/Surface';
import { TopBar } from '@/components/TopBar';
import {
  confirmedRecords,
  estimatedSavingsTotalCents,
  verifiedSavingsTotalCents,
} from '@/domain/savings';
import { useJuva } from '@/state/JuvaProvider';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';
import { formatMoney } from '@/utils/money';

export default function HistoryScreen() {
  const { savingsRecords, savedLists, rerunSavedList, removeSavedList, ledgerHistory } = useJuva();
  // Planned-versus-baseline savings, kept apart from receipt-verified savings.
  const estimatedTotal = estimatedSavingsTotalCents(savingsRecords);
  const total = verifiedSavingsTotalCents(savingsRecords);
  const confirmed = confirmedRecords(savingsRecords);
  const currency = savingsRecords[0]?.currency ?? 'USD';
  return (
    <AppScreen footer={<JuvaRail />}>
      <TopBar back title="Savings" eyebrow="VERIFIED HISTORY" />
      <Surface dark>
        <Text style={styles.label}>JUVA HAS VERIFIED</Text>
        <SavingsNumber
          cents={total}
          currency={currency}
          dark
          accessibilityLabel={`${formatMoney(total, currency)} verified savings`}
        />
        <Text style={styles.copy}>
          saved across {confirmed.length} verified shopping{' '}
          {confirmed.length === 1 ? 'trip' : 'trips'}.
        </Text>
        {/* Estimated and verified are reported side by side, never summed. */}
        <View style={styles.splitRow}>
          <View style={styles.splitCol}>
            <Text style={styles.splitLabel}>ESTIMATED AT PLANNING</Text>
            <Text style={styles.splitValue}>{formatMoney(estimatedTotal, currency)}</Text>
          </View>
          <View style={styles.splitCol}>
            <Text style={styles.splitLabel}>VERIFIED FROM RECEIPTS</Text>
            <Text style={[styles.splitValue, styles.splitVerified]}>
              {formatMoney(total, currency)}
            </Text>
          </View>
        </View>
        <Text style={styles.splitNote}>
          Estimated savings come from the plan Juva built. Verified savings come from what your
          receipts actually said. Juva never adds them together.
        </Text>
      </Surface>

      {savedLists.length > 0 ? (
        <>
          <View style={styles.sectionHeader}>
            <SectionLabel>Recurring baskets</SectionLabel>
            <Text style={styles.sectionMeta}>re-priced when you run them</Text>
          </View>
          {savedLists.map((list) => (
            <Surface key={list.id}>
              <View style={styles.row}>
                <View style={styles.recurringText}>
                  <Text style={styles.trip} allowFontScaling>
                    {list.title}
                  </Text>
                  <Text style={styles.meta} allowFontScaling>
                    {list.items.length} {list.items.length === 1 ? 'item' : 'items'} · saved{' '}
                    {new Date(list.createdAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </Text>
                </View>
              </View>
              <View style={styles.recurringActions}>
                <JuvaButton
                  label="Run this basket"
                  variant="dark"
                  style={styles.recurringRun}
                  accessibilityLabel={`Run ${list.title} again`}
                  accessibilityHint="Re-prices the same items against today's market"
                  onPress={() => {
                    const fresh = rerunSavedList(list.id);
                    if (fresh) router.push('/basket');
                  }}
                />
                <JuvaButton
                  label="Forget"
                  variant="ghost"
                  style={styles.recurringForget}
                  accessibilityLabel={`Forget the saved basket ${list.title}`}
                  onPress={() => removeSavedList(list.id)}
                />
              </View>
            </Surface>
          ))}
        </>
      ) : null}
      <SectionLabel>Trips</SectionLabel>
      {savingsRecords.length === 0 ? (
        <Surface>
          <Text style={styles.emptyTitle}>No verified trips yet.</Text>
          <Text style={styles.emptyCopy}>
            Plan a basket, shop it, then add your receipts. Only those trips count toward verified
            savings.
          </Text>
          <JuvaButton label="Plan groceries" onPress={() => router.replace('/')} />
        </Surface>
      ) : (
        savingsRecords.map((record) => (
          <Surface key={record.id}>
            <View style={styles.row}>
              <View>
                <Text style={styles.date}>
                  {new Date(record.createdAt)
                    .toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                    .toUpperCase()}
                </Text>
                <Text style={styles.trip}>Grocery trip</Text>
              </View>
              <View style={styles.right}>
                {/* A trip that was never confirmed has no verified figure, and showing
                    $0.00 would read as "you saved nothing" rather than "not checked". */}
                {record.receiptConfirmed ? (
                  <>
                    <Text style={styles.saved}>
                      {formatMoney(record.verifiedSavingsCents, record.currency)}
                    </Text>
                    <Text style={styles.savedLabel}>verified</Text>
                  </>
                ) : (
                  <>
                    <Text style={styles.unverified}>—</Text>
                    <Text style={styles.savedLabel}>not verified</Text>
                  </>
                )}
              </View>
            </View>
            <View style={styles.metaRow}>
              <Text style={styles.meta}>
                Planned {formatMoney(record.plannedCents, record.currency)}
              </Text>
              <Text style={styles.meta}>
                Paid {formatMoney(record.actualCents, record.currency)}
              </Text>
              <Text style={styles.meta}>
                Baseline {formatMoney(record.baselineCents, record.currency)}
              </Text>
            </View>
            {ledgerHistory.some((entry) => entry.ledger.tripId === record.tripId) ? (
              <JuvaButton
                label="View verification"
                variant="ghost"
                onPress={() => router.push(`/ledger?tripId=${record.tripId}`)}
              />
            ) : null}
          </Surface>
        ))
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  label: { ...type.label, color: colors.signal },
  splitRow: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.12)',
  },
  splitCol: { flex: 1, gap: 3 },
  splitLabel: { ...type.label, fontSize: 8, color: 'rgba(255,255,255,0.5)' },
  splitValue: { ...type.body, color: colors.white, fontWeight: '900' },
  splitVerified: { color: colors.signal },
  splitNote: { ...type.bodySmall, fontSize: 11, lineHeight: 16, color: 'rgba(255,255,255,0.6)' },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionMeta: { ...type.bodySmall, fontSize: 11, color: colors.muted },
  recurringText: { flex: 1 },
  recurringActions: { flexDirection: 'row', gap: spacing.xs },
  recurringRun: { flex: 2 },
  recurringForget: { flex: 1 },
  total: { ...type.displayXL, color: colors.white },
  copy: { ...type.bodySmall, color: 'rgba(255,255,255,0.6)' },
  emptyTitle: { ...type.h2, color: colors.ink },
  emptyCopy: { ...type.bodySmall, color: colors.muted },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  date: { ...type.label, color: colors.muted },
  trip: { ...type.h2, color: colors.ink, marginTop: 4 },
  right: { alignItems: 'flex-end' },
  saved: { ...type.h2, color: colors.signalDeep },
  unverified: { ...type.h2, color: colors.muted },
  savedLabel: { ...type.bodySmall, color: colors.muted },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  meta: { ...type.bodySmall, fontSize: 11, color: colors.muted },
});
