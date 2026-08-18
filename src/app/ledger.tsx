import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { JuvaButton } from '@/components/JuvaButton';
import { JuvaRail } from '@/components/JuvaRail';
import { SectionLabel } from '@/components/SectionLabel';
import { Surface } from '@/components/Surface';
import { TopBar } from '@/components/TopBar';
import { describeBlocker } from '@/domain/savingsLedger';
import type {
  LedgerLine,
  ReconciliationCorrection,
  SavingsBlocker,
  SavingsClaimState,
  VerificationState,
} from '@/domain/types';
import { useJuva } from '@/state/JuvaProvider';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';
import { formatMoney } from '@/utils/money';

/**
 * The Savings Ledger: the whole economic chain for one trip, on one screen.
 *
 * Five figures, kept apart and shown apart, because each answers a different question —
 * what a comparable basket cost, what Juva planned, what the plan became, what was
 * charged, and what of that is provable. The verified figure is the only claim, and it
 * appears only when every link holds; otherwise the screen says which link is missing
 * rather than showing a smaller number.
 */

/** Headline for a ledger that has no figure to show. Never "$0.00". */
const HEADLINE: Record<SavingsClaimState, string> = {
  verified: 'VERIFIED SAVING',
  pending: 'NOT VERIFIED YET',
  blocked: 'CANNOT BE COMPARED',
  integrity_failed: 'COULD NOT BE VERIFIED',
};

const RAIL_STATUS: Record<SavingsClaimState, string> = {
  verified: 'VERIFIED',
  pending: 'AWAITING EVIDENCE',
  blocked: 'NOT COMPARABLE',
  integrity_failed: 'INTEGRITY CHECK FAILED',
};

const STATE_LABEL: Record<VerificationState, string> = {
  planned: 'PLANNED',
  reported_in_store: 'REPORTED IN STORE',
  receipt_verified: 'RECEIPT VERIFIED',
  needs_review: 'NEEDS REVIEW',
};

export default function LedgerScreen() {
  const { activeLedger, ledgerHistory } = useJuva();
  const params = useLocalSearchParams<{ tripId?: string }>();

  /**
   * A frozen ledger wins over the live one.
   *
   * Once a trip is verified its ledger is history, and history does not get recomputed.
   * Reading the snapshot is what makes the figures after a restart identical to the ones
   * before it, rather than merely equivalent.
   */
  const ledger =
    params.tripId === undefined
      ? (ledgerHistory[0]?.ledger ?? activeLedger)
      : (ledgerHistory.find((entry) => entry.ledger.tripId === params.tripId)?.ledger ??
        (activeLedger?.tripId === params.tripId ? activeLedger : undefined));

  if (!ledger) {
    return (
      <AppScreen footer={<JuvaRail />}>
        <TopBar back title="Savings ledger" eyebrow="JUVA PROOF" />
        <Surface>
          <Text style={styles.emptyTitle}>No ledger for this trip yet.</Text>
          <Text style={styles.emptyCopy}>
            Add your receipts and Juva will reconcile them against the plan.
          </Text>
          <JuvaButton label="Add receipts" onPress={() => router.replace('/verify')} />
        </Surface>
      </AppScreen>
    );
  }

  const { currency } = ledger;

  return (
    <AppScreen
      footer={
        <JuvaRail
          status={
            ledger.verifiedSavingsCents === undefined
              ? RAIL_STATUS[ledger.claimability.state]
              : `VERIFIED · ${formatMoney(ledger.verifiedSavingsCents, currency)}`
          }
        />
      }
    >
      <TopBar back title="Savings ledger" eyebrow={ledger.listTitle.toUpperCase()} />

      {/* The integrity failure comes first and is unmissable. A trip whose baseline
          moved cannot be reasoned about, so nothing below it is a claim. */}
      {!ledger.integrity.ok ? (
        <Surface>
          <Text style={styles.alarmLabel}>TRIP INTEGRITY CHECK FAILED</Text>
          <Text style={styles.alarmCopy} allowFontScaling>
            This trip&rsquo;s original plan no longer matches its own record, so Juva will not
            calculate a saving from it. Your receipt total below is still exactly what you paid.
          </Text>
          <Text style={styles.fingerprint}>
            expected {ledger.integrity.expectedFingerprint} · found{' '}
            {ledger.integrity.actualFingerprint}
          </Text>
        </Surface>
      ) : null}

      <Surface dark style={styles.hero}>
        <Text style={styles.heroLabel}>{ledger.baselineLabel.toUpperCase()}</Text>
        <Text style={styles.baseline}>{formatMoney(ledger.baselineCents, currency)}</Text>

        <View style={styles.chain}>
          <ChainRow
            label="Juva planned"
            value={formatMoney(ledger.originalPlannedCents, currency)}
          />
          <ChainRow
            label="After in-store changes"
            value={formatMoney(ledger.finalExpectedCents, currency)}
          />
          <ChainRow label="Actual" value={formatMoney(ledger.actualCents, currency)} strong />
        </View>

        <View style={styles.heroDivider} />

        {/*
          A verified zero and a refusal are different answers and must never look alike.
          The figure is rendered only when Juva actually has one; otherwise the state is
          named and the reasons listed.
        */}
        {ledger.verifiedSavingsCents !== undefined ? (
          <>
            <Text style={styles.verifiedLabel}>VERIFIED SAVING</Text>
            <Text style={styles.verified}>
              {formatMoney(ledger.verifiedSavingsCents, currency)}
            </Text>
            <Text style={styles.verifiedCopy}>
              {ledger.verifiedSavingsCents === 0
                ? 'Juva checked this trip against the baseline and it came out even.'
                : `${ledger.baselineLabel.toLowerCase()} less what you actually paid.`}
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.verifiedLabel}>{HEADLINE[ledger.claimability.state]}</Text>
            <Text style={styles.noFigure}>—</Text>
            {ledger.claimability.state === 'integrity_failed' ? (
              <Text style={styles.blocker} allowFontScaling>
                Savings could not be verified because this trip&rsquo;s original plan failed an
                integrity check.
              </Text>
            ) : null}
            {ledger.claimability.blockers.map((blocker: SavingsBlocker) => (
              <Text key={blocker} style={styles.blocker} allowFontScaling>
                {describeBlocker(blocker)}
              </Text>
            ))}
            <Text style={styles.verifiedCopy}>
              You paid {formatMoney(ledger.actualCents, currency)}. That figure is what your
              receipts say; only the saving is withheld.
            </Text>
          </>
        )}
      </Surface>

      {/* Attribution explains how the plan earned its saving, whether or not the claim
          is currently allowed. It is never summed into the headline. */}
      <View style={styles.sectionHeader}>
        <SectionLabel>Where it came from</SectionLabel>
        <Text style={styles.sectionMeta}>plan attribution</Text>
      </View>
      <Surface>
        <Attribution
          label="Store selection"
          cents={ledger.storeSelectionSavingsCents}
          currency={currency}
        />
        <Attribution label="Promotions" cents={ledger.promotionSavingsCents} currency={currency} />
        <Attribution
          label="Substitutions"
          cents={ledger.substitutionSavingsCents}
          currency={currency}
        />
        <Text style={styles.note}>
          How the plan earned its saving. These describe the plan, not the receipt, so they are
          shown separately and never added to the verified figure.
        </Text>
      </Surface>

      <View style={styles.sectionHeader}>
        <SectionLabel>Every line</SectionLabel>
        <Text style={styles.sectionMeta}>{ledger.lines.length} items</Text>
      </View>
      <Surface>
        {ledger.lines.map((line: LedgerLine) => (
          <LedgerRow key={line.tripItemId} line={line} currency={currency} />
        ))}
        {ledger.unattributedCents !== 0 ? (
          <View style={styles.row}>
            <Text style={styles.rowName}>Tax, fees and unplanned items</Text>
            <Text style={styles.rowValue}>{formatMoney(ledger.unattributedCents, currency)}</Text>
          </View>
        ) : null}
      </Surface>

      {ledger.corrections.length > 0 ? (
        <>
          <View style={styles.sectionHeader}>
            <SectionLabel>Corrected after the shop</SectionLabel>
            <Text style={styles.sectionMeta}>{ledger.corrections.length}</Text>
          </View>
          <Surface>
            {ledger.corrections.map((correction: ReconciliationCorrection) => (
              <View key={correction.id} style={styles.row}>
                <Text style={styles.rowName}>{correction.kind.replace(/_/g, ' ')}</Text>
                <Text style={styles.rowMeta}>{correction.note ?? ''}</Text>
              </View>
            ))}
            <Text style={styles.note}>
              Recorded here rather than in the shopping history, which stays exactly as it happened.
            </Text>
          </Surface>
        </>
      ) : null}
    </AppScreen>
  );
}

function ChainRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.chainRow}>
      <Text style={styles.chainLabel}>{label}</Text>
      <Text style={[styles.chainValue, strong === true && styles.chainValueStrong]}>{value}</Text>
    </View>
  );
}

function Attribution({
  label,
  cents,
  currency,
}: {
  label: string;
  cents: number;
  currency: LedgerLine extends never ? never : Parameters<typeof formatMoney>[1];
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowName}>{label}</Text>
      <Text style={styles.rowValue}>{formatMoney(cents, currency)}</Text>
    </View>
  );
}

function LedgerRow({
  line,
  currency,
}: {
  line: LedgerLine;
  currency: Parameters<typeof formatMoney>[1];
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowBody}>
        <Text style={styles.rowName} allowFontScaling>
          {line.productName}
        </Text>
        <View style={styles.badges}>
          <Text style={[styles.badge, badgeStyle(line.state)]}>{STATE_LABEL[line.state]}</Text>
          {/* A hand-typed substitute is marked until a receipt confirms it, so it can
              never read as a provider-backed product. */}
          {line.manualSubstitute && line.state !== 'receipt_verified' ? (
            <Text style={[styles.badge, styles.badgeManual]}>YOU ENTERED THIS</Text>
          ) : null}
        </View>
      </View>
      <View style={styles.rowFigures}>
        <Text style={styles.rowValue}>
          {formatMoney(line.actualCents ?? line.expectedCents, currency)}
        </Text>
        {line.differenceCents !== 0 ? (
          <Text style={styles.rowDelta}>
            {line.differenceCents > 0 ? '+' : ''}
            {formatMoney(line.differenceCents, currency)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function badgeStyle(state: VerificationState) {
  switch (state) {
    case 'receipt_verified':
      return styles.badgeVerified;
    case 'needs_review':
      return styles.badgeReview;
    case 'reported_in_store':
      return styles.badgeReported;
    case 'planned':
      return styles.badgePlanned;
  }
}

const styles = StyleSheet.create({
  emptyTitle: { ...type.h2, color: colors.ink },
  emptyCopy: { ...type.bodySmall, color: colors.muted },
  alarmLabel: { ...type.label, color: colors.amber },
  alarmCopy: { ...type.body, color: colors.ink, lineHeight: 23 },
  fingerprint: { ...type.bodySmall, fontSize: 11, color: colors.muted },
  hero: { gap: 4 },
  heroLabel: { ...type.label, color: colors.signal },
  baseline: { ...type.display, color: colors.white },
  chain: { gap: 2, marginTop: spacing.sm },
  chainRow: { flexDirection: 'row', justifyContent: 'space-between', minHeight: 26 },
  chainLabel: { ...type.bodySmall, color: 'rgba(255,255,255,0.56)' },
  chainValue: { ...type.bodySmall, color: 'rgba(255,255,255,0.78)', fontWeight: '800' },
  chainValueStrong: { color: colors.white, fontWeight: '900' },
  heroDivider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.14)',
    marginVertical: spacing.sm,
  },
  verifiedLabel: { ...type.label, fontSize: 9, color: 'rgba(255,255,255,0.56)' },
  verified: { ...type.displayXL, color: colors.signal },
  noFigure: { ...type.displayXL, color: 'rgba(255,255,255,0.28)' },
  verifiedCopy: { ...type.bodySmall, color: 'rgba(255,255,255,0.56)' },
  blocker: { ...type.bodySmall, color: colors.amber, lineHeight: 19, marginTop: 3 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionMeta: { ...type.bodySmall, fontSize: 11, color: colors.muted },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
    minHeight: 44,
    paddingVertical: 6,
  },
  rowBody: { flex: 1 },
  rowFigures: { alignItems: 'flex-end' },
  rowName: { ...type.body, color: colors.ink, fontWeight: '800' },
  rowMeta: { ...type.bodySmall, fontSize: 11, color: colors.muted },
  rowValue: { ...type.body, color: colors.ink, fontWeight: '900' },
  rowDelta: { ...type.bodySmall, fontSize: 11, color: colors.blue, fontWeight: '800' },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 3 },
  badge: {
    ...type.label,
    fontSize: 8,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: 'hidden',
  },
  badgePlanned: { backgroundColor: colors.paperStrong, color: colors.muted },
  badgeReported: { backgroundColor: 'rgba(58,106,214,0.14)', color: colors.blue },
  badgeVerified: { backgroundColor: 'rgba(31,94,54,0.14)', color: colors.signalDeep },
  badgeReview: { backgroundColor: 'rgba(214,143,43,0.16)', color: colors.amber },
  badgeManual: { backgroundColor: 'rgba(214,143,43,0.16)', color: colors.amber },
  note: { ...type.bodySmall, fontSize: 11, lineHeight: 16, color: colors.muted },
});
