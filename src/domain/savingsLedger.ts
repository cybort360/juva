import { savingsBreakdown } from './optimizer';
import { reconcileTrip, type MatchConfirmation } from './reconcile';
import { actualLineTotal, tripProgress } from './shopAdapt';
import { originFingerprint } from './tripOrigin';
import { LEDGER_SCHEMA_VERSION } from './types';
import type {
  CurrencyCode,
  LedgerLine,
  OptimizedPlan,
  PersistedLedger,
  PriceEvidenceSource,
  ReconciledItem,
  ReconciliationCorrection,
  SavingsBlocker,
  SavingsClaimability,
  SavingsClaimState,
  SavingsLedger,
  ShoppingTrip,
  TripIntegrity,
  TripItem,
  VerificationState,
} from './types';

/**
 * The economic proof layer.
 *
 * Juva's whole claim is a chain — baseline → plan → adaptation → actual purchase →
 * verified saving — and this module is where that chain is either completed or refused.
 * Five figures are preserved separately and none overwrites another, because each is the
 * answer to a different question and collapsing any two destroys the proof.
 *
 * The refusals matter more than the arithmetic. A verified saving is only produced when
 * every link holds: the origin is intact, the baseline was comparable, nothing was
 * dropped, receipts exist, matches are settled, and no unverified figure is carrying
 * money. Any one of those failing yields a ledger with the actual total shown and no
 * savings claim — never a smaller claim, and never a silent one.
 */

/**
 * Verifies the trip's economic origin before any money is computed.
 *
 * Fail-closed by construction: the caller receives an integrity object it must consult,
 * and `buildLedger` refuses to produce a saving when it fails. A production build cannot
 * continue past origin corruption because the blocker is part of the result, not a log
 * line someone might not read.
 */
export function checkIntegrity(trip: ShoppingTrip, now: Date = new Date()): TripIntegrity {
  const actual = originFingerprint(trip.origin);
  const ok = actual === trip.origin.fingerprint;
  return {
    ok,
    expectedFingerprint: trip.origin.fingerprint,
    actualFingerprint: actual,
    checkedAt: now.toISOString(),
    // The corrupted origin is preserved rather than discarded. Something wrote to it,
    // and throwing the evidence away would make that impossible to investigate.
    ...(ok ? {} : { evidence: trip.origin }),
  };
}

/** Where a trip line's money currently comes from. */
export function evidenceSourceFor(item: TripItem): PriceEvidenceSource {
  if (item.substituteUnverified === true) return 'user_reported';
  if (item.sourceType !== undefined) return item.sourceType;
  // A shelf correction is the shopper's report, not an observation Juva made.
  if (item.actualPriceCents !== undefined) return 'user_reported';
  return 'provider_observed';
}

/**
 * What the shopper should be shown about one line.
 *
 * A hand-typed substitute must never look like a provider-backed product until a receipt
 * confirms it, which is why `user_reported` evidence can only ever reach
 * `reported_in_store` or `needs_review` — never `receipt_verified` — until a match lands.
 */
export function verificationStateFor(
  item: TripItem,
  reconciled: ReconciledItem | undefined,
): VerificationState {
  if (reconciled?.needsConfirmation === true) return 'needs_review';
  if (reconciled?.status === 'missing') return 'needs_review';

  const source = evidenceSourceFor(item);

  /**
   * A hand-typed substitute needs stronger evidence than words.
   *
   * Juva never saw this product, so a description match is a resemblance between two
   * strings the shopper wrote and a receipt printed — not proof they are the same thing.
   * Promoting on that alone would let a typo become a verified saving. It is promoted
   * only on an exact match (a barcode) or one the shopper confirmed themselves; anything
   * weaker lands in `needs_review`, which is a question, not a verdict.
   */
  if (item.substituteUnverified === true) {
    if (reconciled?.actualCents === undefined) return 'reported_in_store';
    return reconciled.confidence === 'exact' || reconciled.userConfirmed === true
      ? 'receipt_verified'
      : 'needs_review';
  }

  if (reconciled?.actualCents !== undefined) return 'receipt_verified';

  if (source === 'user_reported') return 'reported_in_store';
  if (item.status === 'skipped' || item.status === 'unavailable') return 'needs_review';
  if (item.status !== 'pending' && item.status !== 'collected') return 'reported_in_store';
  return 'planned';
}

/** Applies post-trip corrections to a line's expected figure, without touching the trip. */
function correctedExpectedCents(
  item: TripItem,
  corrections: readonly ReconciliationCorrection[],
): number {
  const forItem = corrections.filter((entry) => entry.tripItemId === item.groceryItemId);
  const last = forItem[forItem.length - 1];
  if (!last) return actualLineTotal(item);
  if (last.kind === 'never_purchased') return 0;
  if (last.actualCents === undefined) return actualLineTotal(item);
  return Math.round(
    last.actualCents * (last.actualQuantity ?? item.actualQuantity ?? item.quantity),
  );
}

/**
 * Builds the permanent ledger for a trip.
 *
 * Pure: the same trip, receipts, confirmations and corrections always produce the same
 * money. No model is involved in any figure here, and none could be — every number is a
 * sum or a difference of observed integers.
 */
export function buildLedger(input: {
  trip: ShoppingTrip;
  /** The plan the trip started from, for its savings attribution. */
  plan: OptimizedPlan;
  receipts: readonly Parameters<typeof reconcileTrip>[1][number][];
  currency: CurrencyCode;
  confirmations?: readonly MatchConfirmation[];
  /** Corrections discovered after leaving the store. */
  corrections?: readonly ReconciliationCorrection[];
  now?: Date;
}): SavingsLedger {
  const { trip, plan, receipts, currency } = input;
  const now = input.now ?? new Date();
  const corrections = input.corrections ?? [];

  // Step one, before any money: is the origin still what it was?
  const integrity = checkIntegrity(trip, now);

  const reconciliation = reconcileTrip(trip, receipts, input.confirmations ?? []);
  const reconciledById = new Map(reconciliation.items.map((item) => [item.tripItemId, item]));
  const progress = tripProgress(trip);
  const attribution = savingsBreakdown(plan);

  const tripItems = trip.stops.flatMap((stop) => stop.items);

  const lines: LedgerLine[] = tripItems.map((item) => {
    const reconciled = reconciledById.get(item.groceryItemId);
    const expected = correctedExpectedCents(item, corrections);
    const actual = reconciled?.actualCents;
    const state = verificationStateFor(item, reconciled);
    return {
      tripItemId: item.groceryItemId,
      productName: item.substituteTitle ?? item.productTitle,
      plannedCents: item.listTotalCents,
      expectedCents: expected,
      actualCents: actual,
      differenceCents: actual === undefined ? 0 : actual - expected,
      state,
      sourceType: state === 'receipt_verified' ? 'receipt_verified' : evidenceSourceFor(item),
      manualSubstitute: item.substituteUnverified === true,
      reason: reconciled?.reason ?? 'Not yet compared against a receipt.',
    };
  });

  const finalExpectedCents = lines.reduce((sum, line) => sum + line.expectedCents, 0);
  const actualCents = reconciliation.actualTotalCents;

  const claimability = assessClaimability({
    integrity,
    comparisonEligible: progress.comparisonEligible,
    droppedItemCount: progress.droppedItemCount,
    reconciliation,
    lines,
  });

  /**
   * Verified savings = a valid comparison baseline − actual eligible basket spend.
   *
   * Computed only when every blocker is clear, and left `undefined` otherwise —
   * deliberately not zero. A zero here would be indistinguishable from the genuine
   * answer "you saved nothing", which is a real and different result. `Math.max(0, …)`
   * still applies to the real answer, because paying more than the baseline is an
   * overspend that `differenceCents` already reports.
   */
  const verifiedSavingsCents = claimability.claimable
    ? Math.max(0, trip.origin.comparedBaselineCents - actualCents)
    : undefined;

  return {
    tripId: trip.id,
    listTitle: trip.listTitle,
    currency,
    createdAt: now.toISOString(),
    integrity,

    baselineCents: trip.origin.comparedBaselineCents,
    baselineKind: trip.origin.baselineKind,
    baselineLabel: baselineLabelFor(trip.origin.baselineKind),

    originalPlannedCents: trip.origin.basketCostCents,
    finalExpectedCents,
    actualCents,
    differenceCents: actualCents - finalExpectedCents,

    ...(verifiedSavingsCents === undefined ? {} : { verifiedSavingsCents }),
    estimatedSavingsCents: trip.origin.savingsVsBaselineCents,

    // Attribution describes how the *plan* earned its saving. It is reported whether or
    // not the saving is claimable, because it explains the plan either way — but it is
    // never summed into a headline that the blockers have refused.
    storeSelectionSavingsCents: attribution.storeSelectionCents,
    promotionSavingsCents: attribution.promotionCents,
    substitutionSavingsCents: attribution.substitutionCents,

    claimability,
    lines,
    corrections: [...corrections],
    unattributedCents: reconciliation.unattributedCents,
    confidence: reconciliation.confidence,
  };
}

function assessClaimability(input: {
  integrity: TripIntegrity;
  comparisonEligible: boolean;
  droppedItemCount: number;
  reconciliation: ReturnType<typeof reconcileTrip>;
  lines: readonly LedgerLine[];
}): SavingsClaimability {
  const blockers: SavingsBlocker[] = [];

  // First and hardest: a moved baseline invalidates everything downstream of it.
  if (!input.integrity.ok) blockers.push('origin_integrity_failed');
  if (!input.comparisonEligible) blockers.push('baseline_not_comparable');
  /**
   * An item that never made it into the basket, however Juva found out.
   *
   * `droppedItemCount` catches what Shop Mode recorded in the aisle;
   * `missingItemCount` catches what the receipt review established afterwards — a
   * confirmed "I didn't buy this", or a line no receipt could explain. Both mean the
   * shopper went home with a different basket than the one the baseline priced, and
   * comparing them would be comparing two different shops.
   */
  if (input.droppedItemCount > 0 || input.reconciliation.missingItemCount > 0) {
    blockers.push('items_dropped');
  }
  if (input.reconciliation.provenance.some((entry) => entry.source === 'missing')) {
    blockers.push('receipt_missing');
  }
  if (input.reconciliation.needsConfirmation) blockers.push('matches_unconfirmed');

  // A hand-typed substitute that no receipt line confirmed is still carrying the
  // shopper's own number. Counting it would be claiming a saving from evidence Juva
  // never checked.
  if (input.lines.some((line) => line.manualSubstitute && line.state !== 'receipt_verified')) {
    blockers.push('unverified_substitute');
  }

  /**
   * The state is not just "claimable or not" — it says *which kind* of not.
   *
   * Integrity failure outranks everything: a trip whose baseline moved cannot be
   * reasoned about at all, and calling that "blocked" would put it in the same category
   * as an ordinary incomparable basket. `pending` means the shopper can still fix it;
   * `blocked` means this basket will never be comparable however many receipts arrive.
   */
  const state: SavingsClaimState = blockers.includes('origin_integrity_failed')
    ? 'integrity_failed'
    : blockers.includes('baseline_not_comparable') || blockers.includes('items_dropped')
      ? 'blocked'
      : blockers.length > 0
        ? 'pending'
        : 'verified';

  return { state, claimable: blockers.length === 0, blockers };
}

function baselineLabelFor(kind: SavingsLedger['baselineKind']): string {
  switch (kind) {
    case 'cheapest_complete_single_store':
      return 'Cheapest complete 1-store basket';
    case 'cheapest_complete_any':
      return 'Cheapest complete basket nearby';
    case 'usual_store':
      return 'Your usual store';
    case 'previous_recurring_basket':
      return 'The same basket last time';
    case 'none':
      return 'No comparable basket was found';
  }
}

/**
 * Freezes a ledger for permanent storage.
 *
 * Called once, when a trip is verified. The result is never recomputed on read: a
 * historical trip must show the figures it showed at the time, not the figures today's
 * engine would produce from the same inputs.
 */
export function persistLedger(
  ledger: SavingsLedger,
  storeNames: readonly string[],
  now: Date = new Date(),
): PersistedLedger {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    ledger,
    storeNames: [...storeNames],
    savedAt: now.toISOString(),
  };
}

/**
 * Whether a stored ledger can be read by this build.
 *
 * A record from a newer schema is not guessed at — it is reported as unreadable and left
 * alone, so a downgrade cannot corrupt evidence it does not understand.
 */
export function isReadableLedger(entry: PersistedLedger): boolean {
  return entry.schemaVersion <= LEDGER_SCHEMA_VERSION;
}

/** Ledgers this build can render, newest first. */
export function readableLedgers(entries: readonly PersistedLedger[]): PersistedLedger[] {
  return [...entries]
    .filter(isReadableLedger)
    .sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
}

/**
 * Receipt-derived observations and the shared Price Graph.
 *
 * **Deliberately not implemented.** A receipt is strong evidence about what *this*
 * shopper paid at *this* till, and Juva trusts it completely for their own verified
 * result. It is not yet trusted as market-price intelligence for anyone else, because
 * that needs rules this pass has no basis to invent: how many independent confirmations
 * make an observation, how a mistyped total is detected, how long a receipt price stays
 * valid, and what a single shopper's data can reveal about them once aggregated.
 *
 * The extension point is `PriceObservation.source: 'receipt_verified'` and its
 * `verificationCount` field, both of which already exist. Nothing writes to them, and
 * nothing should until those rules are designed.
 */
export const RECEIPT_OBSERVATIONS_ARE_LOCAL_ONLY = true;

/** Plain-language reason a verified saving is being withheld. */
export function describeBlocker(blocker: SavingsBlocker): string {
  switch (blocker) {
    case 'origin_integrity_failed':
      return 'This trip’s original plan could not be verified, so no saving is claimed.';
    case 'baseline_not_comparable':
      return 'This trip had no complete basket to compare against.';
    case 'items_dropped':
      return 'Something on the list was not bought, so this is a different basket.';
    case 'receipt_missing':
      return 'A stop has no receipt yet.';
    case 'matches_unconfirmed':
      return 'Some receipt lines still need your confirmation.';
    case 'unverified_substitute':
      return 'A substitute you entered has not been confirmed by a receipt.';
  }
}
