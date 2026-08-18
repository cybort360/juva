import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { CorrectionSheet } from '@/components/CorrectionSheet';
import { JuvaButton } from '@/components/JuvaButton';
import { JuvaRail } from '@/components/JuvaRail';
import { JuvaPressable } from '@/components/Pressable';
import { ReceiptCapture } from '@/components/ReceiptCapture';
import { SectionLabel } from '@/components/SectionLabel';
import { Surface } from '@/components/Surface';
import { TopBar } from '@/components/TopBar';
import { receiptDiscountTotalCents, toReceiptLines } from '@/domain/receipt';
import type { MatchConfirmation } from '@/domain/reconcile';
import type { ReceiptLine } from '@/domain/types';
import { deletePages, type ReceiptPage } from '@/services/receiptImages';
import { extractReceipt, isReceiptExtractionAvailable } from '@/services/vision';
import { useJuva } from '@/state/JuvaProvider';
import { colors } from '@/theme/colors';
import { spacing } from '@/theme/spacing';
import { type } from '@/theme/type';
import { decimalToCents, formatMoney } from '@/utils/money';

export default function VerifyScreen() {
  const {
    activeTrip,
    activeList,
    preferences,
    receipts,
    addReceipt,
    removeReceipt,
    deleteReceiptImages,
    reconcileActiveTrip,
    verifyActiveTrip,
    addCorrection,
  } = useJuva();
  const [capturingStoreId, setCapturingStoreId] = useState<string>();
  const [totals, setTotals] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmations, setConfirmations] = useState<MatchConfirmation[]>([]);
  /** The line whose correction sheet is open, if any. */
  const [correcting, setCorrecting] = useState<string>();

  const currency = activeList?.currency ?? 'USD';
  const scanAvailable = isReceiptExtractionAvailable();

  /** Re-run on every decision, so what is shown is what verifying would record. */
  const reconciliation = useMemo(
    () => reconcileActiveTrip(confirmations),
    [reconcileActiveTrip, confirmations],
  );

  const receiptLineById = useMemo(() => {
    const map = new Map<string, ReceiptLine>();
    for (const receipt of receipts) for (const line of receipt.lines) map.set(line.id, line);
    return map;
  }, [receipts]);

  if (!activeTrip)
    return (
      <AppScreen footer={<JuvaRail />}>
        <TopBar title="Verify" />
        <Surface>
          <Text style={styles.title}>Nothing to verify yet.</Text>
          <JuvaButton label="Plan a trip" onPress={() => router.replace('/')} />
        </Surface>
      </AppScreen>
    );

  const capturingStop = activeTrip.stops.find((stop) => stop.store.id === capturingStoreId);
  if (capturingStoreId !== undefined && capturingStop) {
    /**
     * Reads the captured pages, then keeps or discards the images according to the
     * shopper's retention setting. A retention of zero means the photograph existed
     * only for the length of the request.
     */
    const readPages = async (pages: ReceiptPage[]): Promise<void> => {
      setBusy(true);
      try {
        const extraction = await extractReceipt(pages);
        const lines = toReceiptLines(extraction.lines);
        const keepImages = preferences.receiptImageRetentionDays > 0;
        addReceipt({
          storeId: capturingStoreId,
          merchant: extraction.merchant ?? capturingStop.store.retailerName,
          imageUris: keepImages ? pages.map((page) => page.uri) : [],
          currency: extraction.currency,
          source: 'scan',
          confidence: extraction.confidence,
          lines,
          receiptDiscountCents: extraction.receiptDiscountCents ?? receiptDiscountTotalCents(lines),
          ...(extraction.totalCents === undefined ? {} : { totalCents: extraction.totalCents }),
          ...(keepImages ? {} : { imagesDeletedAt: new Date().toISOString() }),
        });
        if (!keepImages) await deletePages(pages.map((page) => page.uri));
        setMessage(
          `Read ${lines.length} lines from the ${capturingStop.store.retailerName} receipt.`,
        );
      } catch (error) {
        // The temporary copies go whether or not the read worked.
        await deletePages(pages.map((page) => page.uri));
        setMessage(
          error instanceof Error
            ? error.message
            : 'Receipt reading failed. Enter the receipt total manually.',
        );
      } finally {
        setBusy(false);
        setCapturingStoreId(undefined);
      }
    };

    return (
      <ReceiptCapture
        storeName={capturingStop.store.retailerName}
        onCancel={() => setCapturingStoreId(undefined)}
        onDone={(pages) => void readPages(pages)}
      />
    );
  }

  /** A typed total. Parsed with the same integer-cent helper as everything else. */
  const saveManualReceipt = (storeId: string, retailerName: string): void => {
    const totalCents = decimalToCents(totals[storeId] ?? '');
    if (totalCents === null || totalCents <= 0) {
      setMessage('Enter the printed receipt total to verify this stop.');
      return;
    }
    setMessage(undefined);
    addReceipt({
      storeId,
      merchant: retailerName,
      currency,
      totalCents,
      lines: [],
      imageUris: [],
      source: 'manual',
    });
  };

  const decide = (tripItemId: string, receiptLineId: string | null): void => {
    setConfirmations((current) => [
      ...current.filter((entry) => entry.tripItemId !== tripItemId),
      { tripItemId, receiptLineId },
    ]);
  };

  const doneCount = activeTrip.stops.filter((stop) =>
    receipts.some((receipt) => receipt.storeId === stop.store.id),
  ).length;
  const allReceiptsIn = doneCount === activeTrip.stops.length;
  const pending = reconciliation?.items.filter((item) => item.needsConfirmation) ?? [];
  const canVerify = allReceiptsIn && pending.length === 0;

  return (
    <AppScreen
      footer={<JuvaRail status={`VERIFY · ${doneCount}/${activeTrip.stops.length} RECEIPTS`} />}
    >
      <TopBar title="Verify" eyebrow="TURN ESTIMATED INTO VERIFIED" />
      <View style={styles.hero}>
        <Text style={styles.kicker}>ONE LAST THING</Text>
        <Text style={styles.heroTitle}>What did you actually pay?</Text>
        <Text style={styles.copy}>
          {scanAvailable
            ? 'Photograph each receipt, or type the store total. Juva reads the lines, then does the arithmetic itself.'
            : 'Enter each store total from your receipt. Juva keeps estimated and verified savings separate.'}
        </Text>
      </View>

      {message ? (
        <Surface signal>
          <Text style={styles.message} accessibilityLiveRegion="polite">
            {message}
          </Text>
        </Surface>
      ) : null}

      <SectionLabel>Receipts</SectionLabel>
      {activeTrip.stops.map((stop) => {
        const receipt = receipts.find((entry) => entry.storeId === stop.store.id);
        return (
          <Surface key={stop.store.id}>
            <View style={styles.storeHeader}>
              <View style={styles.storeText}>
                <Text style={styles.storeTitle}>{stop.store.retailerName}</Text>
                <Text style={styles.storeMeta}>
                  Expected {formatMoney(stop.expectedSubtotalCents, currency)}
                </Text>
              </View>
              <View style={[styles.status, receipt && styles.statusDone]}>
                <Text style={styles.statusText}>{receipt ? 'ADDED' : 'NEEDED'}</Text>
              </View>
            </View>

            {receipt ? (
              <>
                <View style={styles.receiptResult}>
                  <Text style={styles.receiptLabel}>
                    {receipt.source === 'manual' ? 'TYPED TOTAL' : 'READ FROM RECEIPT'}
                  </Text>
                  <Text style={styles.receiptTotal}>
                    {receipt.totalCents !== undefined
                      ? formatMoney(receipt.totalCents, currency)
                      : `${receipt.lines.length} lines`}
                  </Text>
                  {/* Provenance in plain words, never a claim the scan was perfect. */}
                  <Text style={styles.receiptMeta}>
                    {receipt.source === 'manual'
                      ? 'You typed this total. Juva did not read the lines.'
                      : `${receipt.lines.length} lines read${
                          receipt.confidence === undefined
                            ? ''
                            : ` · ${Math.round(receipt.confidence * 100)}% confidence`
                        }`}
                  </Text>
                  {receipt.receiptDiscountCents !== undefined &&
                  receipt.receiptDiscountCents > 0 ? (
                    <Text style={styles.receiptMeta}>
                      Includes {formatMoney(receipt.receiptDiscountCents, currency)} of receipt
                      discounts.
                    </Text>
                  ) : null}
                  {receipt.imagesDeletedAt !== undefined ? (
                    <Text style={styles.receiptMeta}>
                      Images deleted. The figures above were kept.
                    </Text>
                  ) : null}
                </View>
                <View style={styles.receiptActions}>
                  {receipt.imageUris.length > 0 ? (
                    <JuvaButton
                      label={`Delete ${receipt.imageUris.length === 1 ? 'image' : 'images'}`}
                      variant="ghost"
                      onPress={() => deleteReceiptImages(receipt.id)}
                      accessibilityHint="Deletes the photographs and keeps the figures"
                      style={styles.flex}
                    />
                  ) : null}
                  <JuvaButton
                    label="Replace"
                    variant="ghost"
                    onPress={() => removeReceipt(stop.store.id)}
                    accessibilityHint="Forgets this receipt so it can be added again"
                    style={styles.flex}
                  />
                </View>
              </>
            ) : (
              <>
                {scanAvailable ? (
                  <>
                    <JuvaButton
                      label="Photograph receipt"
                      variant="light"
                      busy={busy}
                      onPress={() => setCapturingStoreId(stop.store.id)}
                    />
                    <View style={styles.or}>
                      <View style={styles.orLine} />
                      <Text style={styles.orText}>OR ENTER TOTAL</Text>
                      <View style={styles.orLine} />
                    </View>
                  </>
                ) : null}
                <View style={styles.manualRow}>
                  <View style={styles.moneyInput}>
                    <Text style={styles.dollar}>$</Text>
                    <TextInput
                      value={totals[stop.store.id] ?? ''}
                      onChangeText={(value) =>
                        setTotals((current) => ({ ...current, [stop.store.id]: value }))
                      }
                      keyboardType="decimal-pad"
                      placeholder="0.00"
                      accessibilityLabel={`Receipt total for ${stop.store.retailerName}`}
                      style={styles.input}
                    />
                  </View>
                  <JuvaButton
                    label="Add"
                    variant="signal"
                    onPress={() => saveManualReceipt(stop.store.id, stop.store.retailerName)}
                    style={styles.add}
                  />
                </View>
              </>
            )}
          </Surface>
        );
      })}

      {/*
        Corrections discovered after leaving the store.
        Shop Mode only accepts changes for the aisle the shopper is in, so anything
        noticed at the kitchen table lands here — appended to `corrections`, never
        written back into the trip's in-store history.
      */}
      {reconciliation !== undefined && reconciliation.items.length > 0 ? (
        <>
          <SectionLabel>Correct a line</SectionLabel>
          {reconciliation.items.map((item) =>
            correcting === item.tripItemId ? (
              <Surface key={`fix-${item.tripItemId}`}>
                <CorrectionSheet
                  item={item}
                  {...(item.receiptLineId === undefined
                    ? {}
                    : { matchedLine: receiptLineById.get(item.receiptLineId) })}
                  currency={currency}
                  onSubmit={(draft) => {
                    addCorrection({
                      id: `fix-${Date.now()}-${item.tripItemId}`,
                      at: new Date().toISOString(),
                      tripItemId: item.tripItemId,
                      beforeCents: item.expectedCents,
                      ...draft,
                    });
                    setMessage('Correction recorded. Juva has re-reconciled this trip.');
                  }}
                  onClose={() => setCorrecting(undefined)}
                />
              </Surface>
            ) : null,
          )}
          <Surface>
            <View style={styles.fixGrid}>
              {reconciliation.items.map((item) => (
                <JuvaPressable
                  key={`open-${item.tripItemId}`}
                  onPress={() => setCorrecting(item.tripItemId)}
                  feedback="select"
                  accessibilityRole="button"
                  accessibilityLabel={`Correct ${item.productName}`}
                  style={styles.fixChip}
                >
                  <Text style={styles.fixChipText}>{item.productName}</Text>
                </JuvaPressable>
              ))}
            </View>
            <Text style={styles.fixNote}>
              Corrections are recorded separately and never change what Shop Mode saw at the time.
            </Text>
          </Surface>
        </>
      ) : null}

      {/*
        Uncertain matches. The engine will not choose between candidates, so the
        shopper does — and until they do, nothing is verified.
      */}
      {pending.length > 0 ? (
        <>
          <SectionLabel>{`Confirm ${pending.length} ${pending.length === 1 ? 'match' : 'matches'}`}</SectionLabel>
          {pending.map((item) => (
            <Surface key={item.tripItemId}>
              <Text style={styles.confirmTitle}>{item.productName}</Text>
              <Text style={styles.confirmReason}>{item.reason}</Text>
              <Text style={styles.confirmExpected}>
                Juva expected {formatMoney(item.expectedCents, currency)}
              </Text>
              <View style={styles.choices}>
                {item.candidateLineIds.map((lineId) => {
                  const line = receiptLineById.get(lineId);
                  if (!line) return null;
                  return (
                    <JuvaPressable
                      key={lineId}
                      onPress={() => decide(item.tripItemId, lineId)}
                      feedback="select"
                      accessibilityRole="radio"
                      accessibilityLabel={`${line.productName}, ${formatMoney(line.chargedPriceCents, currency)}`}
                      style={styles.choice}
                    >
                      <Text style={styles.choiceName}>{line.productName || line.rawText}</Text>
                      <Text style={styles.choicePrice}>
                        {formatMoney(line.chargedPriceCents, currency)}
                      </Text>
                    </JuvaPressable>
                  );
                })}
                <JuvaPressable
                  onPress={() => decide(item.tripItemId, null)}
                  feedback="select"
                  accessibilityRole="radio"
                  accessibilityLabel={`${item.productName} was not bought`}
                  style={styles.choice}
                >
                  <Text style={styles.choiceName}>I did not buy this</Text>
                  <Text style={styles.choiceNone}>—</Text>
                </JuvaPressable>
              </View>
            </Surface>
          ))}
        </>
      ) : null}

      {reconciliation && allReceiptsIn ? (
        <Surface>
          <Text style={styles.previewLabel}>SO FAR</Text>
          {(
            [
              ['Expected', reconciliation.expectedTotalCents],
              ['Actual', reconciliation.actualTotalCents],
              ['Difference', reconciliation.differenceCents],
            ] as const
          ).map(([label, cents]) => (
            <View key={label} style={styles.previewRow}>
              <Text style={styles.previewKey}>{label}</Text>
              <Text style={styles.previewValue}>{formatMoney(cents, currency)}</Text>
            </View>
          ))}
          {reconciliation.unmatchedLines.length > 0 ? (
            <Text style={styles.previewNote}>
              {reconciliation.unmatchedLines.length} receipt line
              {reconciliation.unmatchedLines.length === 1 ? '' : 's'} did not match a planned item.
              They are counted in the total, not attributed to an item.
            </Text>
          ) : null}
        </Surface>
      ) : null}

      <Surface dark>
        <Text style={styles.readyLabel}>
          {canVerify ? 'READY' : pending.length > 0 ? 'WAITING ON YOU' : 'WAITING FOR RECEIPTS'}
        </Text>
        <Text style={styles.readyTitle}>
          {canVerify
            ? 'Calculate verified savings.'
            : pending.length > 0
              ? `Confirm ${pending.length} match${pending.length === 1 ? '' : 'es'} first.`
              : `Add ${activeTrip.stops.length - doneCount} more receipt${activeTrip.stops.length - doneCount === 1 ? '' : 's'}.`}
        </Text>
        <Text style={styles.readyCopy}>
          Only a trip with every receipt read and every uncertain match confirmed counts toward your
          verified savings. Juva compares what you paid against the cheapest complete single-store
          baseline captured before the trip.
        </Text>
        <JuvaButton
          label="Verify my trip"
          variant="signal"
          disabled={!canVerify}
          onPress={() => {
            const record = verifyActiveTrip(confirmations);
            if (record) router.push('/receipt-result');
          }}
        />
      </Surface>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  title: { ...type.h2, color: colors.ink },
  hero: { gap: spacing.sm, paddingVertical: spacing.sm },
  kicker: { ...type.label, color: colors.signalDeep },
  heroTitle: { ...type.display, color: colors.ink },
  copy: { ...type.body, color: colors.muted, maxWidth: 350 },
  message: { ...type.bodySmall, color: colors.ink, fontWeight: '800' },
  storeHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  storeText: { flex: 1 },
  storeTitle: { ...type.h2, color: colors.ink },
  storeMeta: { ...type.bodySmall, color: colors.muted, marginTop: 2 },
  status: {
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 6,
    backgroundColor: colors.amberSoft,
  },
  statusDone: { backgroundColor: colors.forestSoft },
  statusText: { ...type.label, fontSize: 8, letterSpacing: 0.6, color: colors.ink },
  receiptResult: {
    backgroundColor: colors.paperStrong,
    borderRadius: 18,
    padding: spacing.md,
    gap: 3,
  },
  receiptLabel: { ...type.label, color: colors.muted },
  receiptTotal: { ...type.h2, color: colors.ink, marginTop: 4 },
  receiptMeta: { ...type.bodySmall, fontSize: 12, color: colors.muted },
  receiptActions: { flexDirection: 'row', gap: spacing.xs },
  flex: { flex: 1 },
  or: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  orLine: { flex: 1, height: 1, backgroundColor: colors.border },
  orText: { ...type.label, color: colors.muted, fontSize: 8 },
  manualRow: { flexDirection: 'row', gap: spacing.sm },
  moneyInput: {
    flex: 1,
    minHeight: 56,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.paper,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
  },
  dollar: { ...type.h2, color: colors.muted },
  input: { flex: 1, ...type.h2, color: colors.ink, paddingHorizontal: 6 },
  add: { width: 92 },
  fixGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  fixChip: {
    minHeight: 40,
    borderRadius: 12,
    backgroundColor: colors.paperStrong,
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  fixChipText: { ...type.bodySmall, fontSize: 12, color: colors.ink, fontWeight: '800' },
  fixNote: { ...type.bodySmall, fontSize: 11, lineHeight: 16, color: colors.muted },
  confirmTitle: { ...type.h2, color: colors.ink },
  confirmReason: { ...type.bodySmall, color: colors.amber, fontWeight: '800' },
  confirmExpected: { ...type.bodySmall, color: colors.muted },
  choices: { gap: spacing.xs },
  choice: {
    minHeight: 56,
    borderRadius: 16,
    backgroundColor: colors.paperStrong,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  choiceName: { ...type.body, color: colors.ink, fontWeight: '800', flex: 1 },
  choicePrice: { ...type.body, color: colors.ink, fontWeight: '900' },
  choiceNone: { ...type.body, color: colors.muted },
  previewLabel: { ...type.label, color: colors.muted },
  previewRow: { flexDirection: 'row', justifyContent: 'space-between', minHeight: 30 },
  previewKey: { ...type.bodySmall, color: colors.muted },
  previewValue: { ...type.bodySmall, color: colors.ink, fontWeight: '900' },
  previewNote: { ...type.bodySmall, fontSize: 12, color: colors.muted, lineHeight: 18 },
  readyLabel: { ...type.label, color: colors.signal },
  readyTitle: { ...type.h2, color: colors.white },
  readyCopy: { ...type.bodySmall, color: 'rgba(255,255,255,0.6)' },
});
