import { savingsBreakdown } from './optimizer';
import { reconcileTrip, type MatchConfirmation } from './reconcile';
import { checkIntegrity } from './savingsLedger';
import { snapshotOrigin } from './tripOrigin';
import type {
  CurrencyCode,
  GroceryList,
  MarketSnapshot,
  OptimizedPlan,
  Receipt,
  SavingsRecord,
  ShoppingTrip,
  VerificationLine,
} from './types';

/**
 * Starts a trip from a plan.
 *
 * Two things are captured here that the trip cannot work without later.
 *
 * `origin` freezes what the plan claimed: its basket, its baseline, and whether that
 * baseline was comparable at all. Shop Mode may reroute the trip as much as the shelves
 * demand, but the saving is always measured against this record. A baseline that moved
 * with the plan would let Juva improve its own savings figure by replanning.
 *
 * `market` caches the snapshot the plan was built from. Juva's snapshot otherwise lives
 * in memory only, so a shopper who loses signal in an aisle — or whose app is relaunched
 * at the checkout — could not be replanned at all. The deterministic optimizer needs no
 * network, only this.
 */
export function createTrip(
  plan: OptimizedPlan,
  list: GroceryList,
  snapshot: MarketSnapshot,
  now: Date = new Date(),
): ShoppingTrip {
  return {
    id: `trip-${now.getTime()}`,
    planId: plan.id,
    listTitle: list.title,
    startedAt: now.toISOString(),
    currentStopIndex: 0,
    stops: plan.stops.map((stop) => ({
      store: stop.store,
      expectedSubtotalCents: stop.subtotalCents,
      items: stop.items.map((item) => ({ ...item, status: 'pending' as const })),
    })),
    // A value snapshot, fingerprinted and frozen — never a reference into the plan.
    origin: snapshotOrigin({
      planId: plan.id,
      planKind: plan.kind,
      basketCostCents: plan.basketCostCents,
      comparedBaselineCents: plan.comparedBaselineCents,
      baselineKind: plan.explanation.baselineKind,
      savingsVsBaselineCents: plan.savingsVsBaselineCents,
      storeIds: plan.stops.map((stop) => stop.store.id),
      capturedAt: now.toISOString(),
      comparisonEligible: plan.completeness.comparisonEligible,
    }),
    market: {
      mode: snapshot.mode,
      capturedAt: now.toISOString(),
      stores: snapshot.stores,
      products: snapshot.products,
      promotions: snapshot.promotions,
      list,
    },
    adaptations: [],
  };
}

/**
 * Turns a finished trip plus its receipts into a verified savings record.
 *
 * All matching and attribution is delegated to the deterministic reconciliation
 * engine; this function's only job is to shape the result into a record and to
 * decide whether the trip earned the right to be called verified.
 *
 * A trip is verified only when every stop produced a receipt and nothing is still
 * waiting on the shopper. Anything less is kept as a record with
 * `receiptConfirmed: false` and contributes nothing to the verified total — an
 * estimate that was never checked is not a saving.
 */
export function verifyTrip(
  trip: ShoppingTrip,
  plan: OptimizedPlan,
  receipts: readonly Receipt[],
  currency: CurrencyCode,
  confirmations: readonly MatchConfirmation[] = [],
): SavingsRecord {
  const reconciliation = reconcileTrip(trip, receipts, confirmations);
  const breakdown = savingsBreakdown(plan);

  /**
   * The origin check, before any money is called verified.
   *
   * Fail-closed: a trip whose economic origin has moved cannot produce a verified
   * saving, however clean its receipts are. The record is still written — the shopper
   * keeps their actual total and the evidence is preserved — but `receiptConfirmed`
   * stays false, which is what keeps it out of the lifetime verified figure.
   */
  const integrity = checkIntegrity(trip);

  const everyStopHasReceipt = reconciliation.provenance.every(
    (entry) => entry.source !== 'missing',
  );
  const receiptConfirmed = integrity.ok && everyStopHasReceipt && !reconciliation.needsConfirmation;

  const lines: VerificationLine[] = reconciliation.items.map((item) => ({
    tripItemId: item.tripItemId,
    productName: item.productName,
    expectedCents: item.expectedCents,
    actualCents: item.actualCents ?? item.expectedCents,
    differenceCents: item.differenceCents,
  }));

  // The residual is surfaced as its own line rather than absorbed, so expected
  // and actual always reconcile visibly.
  if (reconciliation.unattributedCents !== 0) {
    lines.push({
      tripItemId: `receipt-adjustment-${trip.id}`,
      productName: 'Tax, fees and unplanned items',
      expectedCents: 0,
      actualCents: reconciliation.unattributedCents,
      differenceCents: reconciliation.unattributedCents,
    });
  }

  return {
    id: `saving-${Date.now()}`,
    tripId: trip.id,
    createdAt: new Date().toISOString(),
    currency,
    plannedCents: plan.basketCostCents,
    expectedTotalCents: reconciliation.expectedTotalCents,
    actualCents: reconciliation.actualTotalCents,
    differenceCents: reconciliation.differenceCents,
    baselineCents: plan.comparedBaselineCents,
    estimatedSavingsCents: plan.savingsVsBaselineCents,
    // Never negative: paying more than the baseline is an overspend, not a
    // negative saving, and the difference figure already says so.
    verifiedSavingsCents: receiptConfirmed
      ? Math.max(0, plan.comparedBaselineCents - reconciliation.actualTotalCents)
      : 0,
    storeSelectionSavingsCents: breakdown.storeSelectionCents,
    promotionSavingsCents: breakdown.promotionCents,
    substitutionSavingsCents: breakdown.substitutionCents,
    receiptConfirmed,
    confidence: reconciliation.confidence,
    provenance: reconciliation.provenance,
    unmatchedLineCount: reconciliation.unmatchedLines.length,
    missingItemCount: reconciliation.missingItemCount,
    lines,
  };
}
