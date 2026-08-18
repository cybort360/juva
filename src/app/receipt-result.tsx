import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { JuvaButton } from '@/components/JuvaButton';
import { JuvaRail } from '@/components/JuvaRail';
import { Reconciliation } from '@/components/Reconciliation';
import { SavingsNumber } from '@/components/SavingsNumber';
import { SectionLabel } from '@/components/SectionLabel';
import { Surface } from '@/components/Surface';
import { TopBar } from '@/components/TopBar';
import { useJuva } from '@/state/JuvaProvider';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';
import { formatMoney } from '@/utils/money';

export default function ReceiptResultScreen() {
  const { savingsRecords } = useJuva();
  const record = savingsRecords[0];
  if (!record)
    return (
      <AppScreen>
        <TopBar back title="Verified trip" />
        <Text>No verification record.</Text>
      </AppScreen>
    );
  return (
    <AppScreen
      footer={
        <JuvaRail
          status={`VERIFIED · SAVED ${formatMoney(record.verifiedSavingsCents, record.currency)}`}
        />
      }
    >
      <TopBar title="Verified trip" eyebrow="RECEIPT CHECK COMPLETE" />
      <Surface signal style={styles.hero}>
        <Text style={styles.heroLabel}>
          {record.receiptConfirmed ? 'YOU SAVED' : 'NOT VERIFIED'}
        </Text>
        <SavingsNumber
          cents={
            record.receiptConfirmed ? record.verifiedSavingsCents : record.estimatedSavingsCents
          }
          currency={record.currency}
        />
        <Text style={styles.heroCopy}>
          {record.receiptConfirmed
            ? 'verified against the complete single-store baseline Juva captured before your trip.'
            : 'estimated only. Some receipts were missing or unconfirmed, so this trip does not count toward your verified savings.'}
        </Text>
      </Surface>

      <Reconciliation
        expectedCents={record.expectedTotalCents}
        actualCents={record.actualCents}
        currency={record.currency}
      />

      {/* The eight figures, each labelled with what it is measured against. */}
      <SectionLabel>The arithmetic</SectionLabel>
      <Surface>
        {(
          [
            ['Expected total', record.expectedTotalCents, 'what the plan said'],
            ['Actual total', record.actualCents, 'what you paid'],
            [
              'Difference',
              record.differenceCents,
              record.differenceCents > 0 ? 'dearer than planned' : 'cheaper than planned',
            ],
            ['Estimated savings', record.estimatedSavingsCents, 'before the trip'],
            [
              'Verified savings',
              record.verifiedSavingsCents,
              record.receiptConfirmed ? 'from your receipts' : 'nothing verified yet',
            ],
          ] as const
        ).map(([label, cents, basis]) => (
          <View key={label} style={styles.breakdown}>
            <View style={styles.breakdownText}>
              <Text style={styles.breakdownLabel}>{label}</Text>
              <Text style={styles.breakdownBasis}>{basis}</Text>
            </View>
            <Text style={styles.breakdownValue}>{formatMoney(cents, record.currency)}</Text>
          </View>
        ))}
      </Surface>

      {/* Provenance: where each figure came from, and how sure Juva is. */}
      <SectionLabel>Where these came from</SectionLabel>
      <Surface>
        {record.provenance.map((entry) => (
          <View key={entry.storeId} style={styles.breakdown}>
            <View style={styles.breakdownText}>
              <Text style={styles.breakdownLabel}>{entry.retailerName}</Text>
              <Text style={styles.breakdownBasis}>
                {entry.source === 'missing'
                  ? 'no receipt added — planned prices stood in'
                  : entry.source === 'manual'
                    ? 'you typed the total'
                    : `${entry.lineCount} lines read from the receipt`}
                {entry.usedPrintedTotal ? ' · printed total used' : ''}
              </Text>
            </View>
          </View>
        ))}
        <Text style={styles.breakdownNote}>
          Reconciliation confidence {Math.round(record.confidence * 100)}%. This describes how well
          the receipt matched the plan, not how likely the arithmetic is to be right — the
          arithmetic is exact.
          {record.unmatchedLineCount > 0
            ? ` ${record.unmatchedLineCount} receipt line${record.unmatchedLineCount === 1 ? '' : 's'} could not be attributed to a planned item.`
            : ''}
          {record.missingItemCount > 0
            ? ` ${record.missingItemCount} planned item${record.missingItemCount === 1 ? '' : 's'} did not appear.`
            : ''}
        </Text>
      </Surface>

      <SectionLabel>Why you saved</SectionLabel>
      <Surface>
        <View style={styles.breakdown}>
          <View style={styles.breakdownText}>
            <Text style={styles.breakdownLabel}>Store selection</Text>
            <Text style={styles.breakdownBasis}>vs the cheapest single store</Text>
          </View>
          <Text style={styles.breakdownValue}>
            {formatMoney(record.storeSelectionSavingsCents, record.currency)}
          </Text>
        </View>
        <View style={styles.breakdown}>
          <View style={styles.breakdownText}>
            <Text style={styles.breakdownLabel}>Promotions</Text>
            <Text style={styles.breakdownBasis}>vs shelf price</Text>
          </View>
          <Text style={styles.breakdownValue}>
            {formatMoney(record.promotionSavingsCents, record.currency)}
          </Text>
        </View>
        <View style={styles.breakdown}>
          <View style={styles.breakdownText}>
            <Text style={styles.breakdownLabel}>Substitutions</Text>
            <Text style={styles.breakdownBasis}>vs the brand you asked for</Text>
          </View>
          <Text style={styles.breakdownValue}>
            {formatMoney(record.substitutionSavingsCents, record.currency)}
          </Text>
        </View>
        <Text style={styles.breakdownNote}>
          Each line is measured against a different reference, so they are not parts of one total.
          The headline figure above is your receipt total against the single-store baseline.
        </Text>
      </Surface>

      <SectionLabel>Receipt differences</SectionLabel>
      <Surface>
        {record.lines.filter((line) => line.differenceCents !== 0).length === 0 ? (
          <Text style={styles.noDiff}>No item-level differences were recorded.</Text>
        ) : (
          record.lines
            .filter((line) => line.differenceCents !== 0)
            .map((line) => (
              <View key={line.tripItemId} style={styles.line}>
                <Text style={styles.lineName}>{line.productName}</Text>
                <Text
                  style={[
                    styles.lineDiff,
                    line.differenceCents > 0 ? styles.deltaUp : styles.deltaDown,
                  ]}
                >
                  {line.differenceCents > 0 ? '+' : '−'}
                  {formatMoney(Math.abs(line.differenceCents), record.currency)}
                </Text>
              </View>
            ))
        )}
      </Surface>

      <Surface dark>
        <Text style={styles.darkLabel}>THE NUMBER THAT COUNTS</Text>
        <Text style={styles.darkTitle}>
          {formatMoney(record.verifiedSavingsCents, record.currency)} is now part of your verified
          savings.
        </Text>
        <Text style={styles.darkCopy}>
          Juva never mixes projected savings with receipt-verified savings.
        </Text>
        <JuvaButton
          label="See the full ledger"
          variant="signal"
          onPress={() => router.push('/ledger')}
        />
        <JuvaButton
          label="View savings history"
          variant="ghost"
          onPress={() => router.push('/history')}
        />
      </Surface>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  hero: { paddingVertical: spacing.xl },
  heroLabel: { ...type.label, color: colors.signalDeep },
  heroCopy: { ...type.bodySmall, color: colors.inkSoft, maxWidth: 310 },
  deltaUp: { color: colors.red },
  deltaDown: { color: colors.signalDeep },
  breakdown: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingVertical: 4,
  },
  breakdownText: { flex: 1 },
  breakdownLabel: { ...type.bodySmall, color: colors.ink, fontWeight: '800' },
  breakdownBasis: { ...type.bodySmall, fontSize: 11, color: colors.muted, marginTop: 1 },
  breakdownValue: { ...type.bodySmall, color: colors.ink, fontWeight: '900' },
  breakdownNote: { ...type.bodySmall, fontSize: 11, lineHeight: 16, color: colors.muted },
  noDiff: { ...type.bodySmall, color: colors.muted },
  line: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  lineName: { ...type.bodySmall, color: colors.ink, flex: 1 },
  lineDiff: { ...type.bodySmall, fontWeight: '900' },
  darkLabel: { ...type.label, color: colors.signal },
  darkTitle: { ...type.h2, color: colors.white },
  darkCopy: { ...type.bodySmall, color: 'rgba(255,255,255,0.6)' },
});
