import { normalizeGtin, resolveGtin } from './identity';
import {
  comparableItemLines,
  expandReceiptDescription,
  receiptDiscountTotalCents,
} from './receipt';
import type {
  MatchConfidence,
  ReceiptLine,
  ReconcileProvenance,
  ReconciledItem,
  ReconciliationResult,
  ReconcileStatus,
  Receipt,
  ShoppingTrip,
  TripItem,
  UnmatchedReceiptLine,
} from './types';

/**
 * Deterministic reconciliation of a plan against its receipts.
 *
 * Every figure this module produces is integer-cent arithmetic over values that
 * were either printed on a receipt, typed by the shopper, or computed by the
 * optimizer before the trip. Nothing is modelled, inferred or estimated. The
 * model's only contribution upstream was transcription, and a transcription that
 * cannot be matched is reported as unmatched rather than fitted to something.
 *
 * The engine refuses to guess. When two receipt lines are equally good
 * candidates for one planned item, the item comes back `ambiguous` with both
 * candidates attached, and the shopper decides. That refusal is why a verified
 * saving can be trusted.
 */

/** A shopper's decision about an otherwise-uncertain match. */
export interface MatchConfirmation {
  tripItemId: string;
  /** The chosen receipt line, or null for "this item is not on the receipt". */
  receiptLineId: string | null;
}

/** Score thresholds for the description comparison below. */
const STRONG_SCORE = 0.6;
const WEAK_SCORE = 0.34;
/** Below this, two descriptions are simply unrelated. */
const NOISE_SCORE = 0.2;
/** A second candidate this close to the best one makes the choice unsafe. */
const AMBIGUITY_MARGIN = 0.12;

const STOPWORDS = new Set([
  'the',
  'a',
  'of',
  'and',
  'with',
  'each',
  'count',
  'pound',
  'ounce',
  'gallon',
  'quart',
  'pack',
]);

function contentTokens(value: string): string[] {
  return expandReceiptDescription(value)
    .split(' ')
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/**
 * How much two descriptions have in common, 0..1.
 *
 * Weighted toward the planned item's tokens: a receipt line is usually a
 * truncation of the product name, so the question that matters is how much of the
 * planned name the receipt line accounts for. Prefix matching handles truncation
 * ("SANDWCH" against "sandwich") without letting short fragments match anything.
 */
export function descriptionScore(plannedName: string, receiptText: string): number {
  const planned = contentTokens(plannedName);
  const printed = contentTokens(receiptText);
  if (planned.length === 0 || printed.length === 0) return 0;

  let hits = 0;
  for (const token of planned) {
    const found = printed.some(
      (other) =>
        other === token ||
        (token.length >= 4 && other.startsWith(token.slice(0, 4))) ||
        (other.length >= 4 && token.startsWith(other.slice(0, 4))),
    );
    if (found) hits += 1;
  }
  return hits / planned.length;
}

interface Candidate {
  line: ReceiptLine;
  score: number;
  exact: boolean;
}

/**
 * Ranks the receipt lines that could explain one planned item.
 *
 * Trade identity first, words second — the same hierarchy the optimizer's matcher uses,
 * for the same reason: two feeds describing one tin differently is routine, two
 * different articles sharing a valid GTIN is not. When both the planned item and the
 * receipt line carry a check-digit-valid identifier, equality settles the match outright
 * and every description score below becomes irrelevant.
 *
 * Neither side usually has one. No connected retailer source publishes barcodes today
 * and most receipts do not print them, so the text path remains the working path — which
 * is why this engine still surfaces ambiguity to the shopper rather than resolving it.
 * Nothing here fabricates an identifier when one is absent.
 */
function rankCandidates(item: TripItem, lines: readonly ReceiptLine[]): Candidate[] {
  const plannedGtin = resolveGtin(item.identifiers);

  const ranked: Candidate[] = [];
  for (const line of lines) {
    const lineGtin = normalizeGtin(line.barcode);
    if (plannedGtin !== undefined && lineGtin !== undefined) {
      // A mismatch is real negative evidence: this line is provably a different
      // article, so it is not a candidate at any description score.
      if (plannedGtin !== lineGtin) continue;
      ranked.push({ line, score: 1, exact: true });
      continue;
    }

    const score = Math.max(
      descriptionScore(item.productTitle, line.rawText),
      descriptionScore(item.productTitle, line.productName),
    );
    if (score > NOISE_SCORE) ranked.push({ line, score, exact: false });
  }

  // Identifier matches sort above every text match, whatever the words say.
  return ranked.sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score);
}

function confidenceFromScore(score: number, exact: boolean): MatchConfidence {
  if (exact) return 'exact';
  if (score >= STRONG_SCORE) return 'strong';
  if (score >= WEAK_SCORE) return 'weak';
  return 'none';
}

/**
 * Whether a matched line represents the planned product or a stand-in.
 *
 * A weak description match against a line whose price differs is the signature of
 * a substitution — the shopper picked up something else. It is reported as such
 * rather than as a price change, because the two mean different things to a
 * shopper reading the result.
 */
function statusFor(
  item: TripItem,
  line: ReceiptLine,
  confidence: MatchConfidence,
): ReconcileStatus {
  const samePrice = line.chargedPriceCents === item.lineTotalCents;
  if (confidence === 'weak' && !samePrice) return 'substituted';
  if (samePrice) return 'matched';
  return 'price_changed';
}

function reasonFor(status: ReconcileStatus, item: TripItem, line?: ReceiptLine): string {
  switch (status) {
    case 'matched':
      return 'Charged exactly what Juva expected.';
    case 'price_changed':
      return line !== undefined && line.chargedPriceCents > item.lineTotalCents
        ? 'The shelf price was higher than the price Juva planned with.'
        : 'The shelf price was lower than the price Juva planned with.';
    case 'substituted':
      return 'A different product appears to have stood in for this one.';
    case 'missing':
      return 'Nothing on the receipt corresponds to this item.';
    case 'ambiguous':
      return 'More than one receipt line could be this item. Confirm which it was.';
    case 'assumed_planned':
      return 'No receipt was added for this stop, so the planned price stands.';
  }
}

/**
 * Reconciles one stop.
 *
 * Items the shopper already corrected in Shop Mode are settled from that
 * correction and never re-matched, because a price the shopper read off the shelf
 * outranks a description match.
 */
function reconcileStop(
  storeId: string,
  retailerName: string,
  items: readonly TripItem[],
  receipt: Receipt | undefined,
  confirmations: ReadonlyMap<string, string | null>,
): {
  items: ReconciledItem[];
  unmatched: UnmatchedReceiptLine[];
  itemsAttributedCents: number;
  stopActualCents: number;
  discountCents: number;
  provenance: ReconcileProvenance;
} {
  const available = receipt ? comparableItemLines(receipt.lines) : [];
  const claimed = new Set<string>();
  const resolved: ReconciledItem[] = [];

  /** Pre-claim every line a shopper explicitly confirmed, so it cannot be stolen. */
  for (const item of items) {
    const choice = confirmations.get(item.groceryItemId);
    if (choice != null && available.some((line) => line.id === choice)) claimed.add(choice);
  }

  /**
   * A total-only receipt: the shopper typed the total, or every line was redacted.
   *
   * There is nothing to match against, and that is not the same as the items being
   * missing. The printed total settles the stop, the planned prices stand in for
   * the items, and no confirmation is asked for — there is no question to put to
   * the shopper. Item-level detail is simply reported as unchecked.
   */
  const totalOnly =
    receipt !== undefined && available.length === 0 && receipt.totalCents !== undefined;

  for (const item of items) {
    const confirmation = confirmations.get(item.groceryItemId);

    if (totalOnly && item.actualPriceCents === undefined) {
      resolved.push({
        tripItemId: item.groceryItemId,
        productName: item.productTitle,
        expectedCents: item.lineTotalCents,
        differenceCents: 0,
        status: 'assumed_planned',
        confidence: 'none',
        candidateLineIds: [],
        needsConfirmation: false,
        reason: 'Only the receipt total was recorded, so this line was not checked individually.',
      });
      continue;
    }

    // 1. A shelf correction from Shop Mode settles the item outright.
    if (item.actualPriceCents !== undefined) {
      const actual = item.actualPriceCents;
      resolved.push({
        tripItemId: item.groceryItemId,
        productName: item.productTitle,
        expectedCents: item.lineTotalCents,
        actualCents: actual,
        differenceCents: actual - item.lineTotalCents,
        status: actual === item.lineTotalCents ? 'matched' : 'price_changed',
        confidence: 'exact',
        candidateLineIds: [],
        needsConfirmation: false,
        reason: 'You corrected this price in the store.',
      });
      continue;
    }

    // 2. An explicit decision from the shopper, including "not on the receipt".
    if (confirmation !== undefined) {
      if (confirmation === null) {
        resolved.push({
          tripItemId: item.groceryItemId,
          productName: item.productTitle,
          expectedCents: item.lineTotalCents,
          differenceCents: 0,
          status: 'missing',
          confidence: 'none',
          candidateLineIds: [],
          needsConfirmation: false,
          reason: 'You confirmed this item was not bought.',
        });
        continue;
      }
      const chosen = available.find((line) => line.id === confirmation);
      if (chosen) {
        resolved.push({
          tripItemId: item.groceryItemId,
          productName: item.productTitle,
          expectedCents: item.lineTotalCents,
          actualCents: chosen.chargedPriceCents,
          differenceCents: chosen.chargedPriceCents - item.lineTotalCents,
          status: statusFor(item, chosen, 'strong'),
          confidence: 'exact',
          receiptLineId: chosen.id,
          candidateLineIds: [],
          needsConfirmation: false,
          // Recorded explicitly rather than inferred from the confidence, because this
          // is the one signal strong enough to promote a hand-typed substitute — and a
          // future change to how confidence is scored must not silently grant that.
          userConfirmed: true,
          reason: 'You confirmed this match.',
        });
        continue;
      }
    }

    // 3. No receipt for this stop at all: the plan stands, and says so.
    if (!receipt) {
      resolved.push({
        tripItemId: item.groceryItemId,
        productName: item.productTitle,
        expectedCents: item.lineTotalCents,
        differenceCents: 0,
        status: 'assumed_planned',
        confidence: 'none',
        candidateLineIds: [],
        needsConfirmation: false,
        reason: reasonFor('assumed_planned', item),
      });
      continue;
    }

    // 4. Otherwise, rank what is left and decide whether the choice is safe.
    const ranked = rankCandidates(item, available).filter((entry) => !claimed.has(entry.line.id));
    const best = ranked[0];
    const runnerUp = ranked[1];

    if (!best) {
      resolved.push({
        tripItemId: item.groceryItemId,
        productName: item.productTitle,
        expectedCents: item.lineTotalCents,
        differenceCents: 0,
        status: 'missing',
        confidence: 'none',
        candidateLineIds: [],
        needsConfirmation: true,
        reason: reasonFor('missing', item),
      });
      continue;
    }

    const confidence = confidenceFromScore(best.score, best.exact);
    const contested =
      !best.exact && runnerUp !== undefined && best.score - runnerUp.score < AMBIGUITY_MARGIN;

    if (contested || confidence === 'none') {
      resolved.push({
        tripItemId: item.groceryItemId,
        productName: item.productTitle,
        expectedCents: item.lineTotalCents,
        differenceCents: 0,
        status: 'ambiguous',
        confidence: 'weak',
        candidateLineIds: [best.line.id, ...(runnerUp ? [runnerUp.line.id] : [])],
        needsConfirmation: true,
        reason: reasonFor('ambiguous', item),
      });
      continue;
    }

    claimed.add(best.line.id);
    const status = statusFor(item, best.line, confidence);
    resolved.push({
      tripItemId: item.groceryItemId,
      productName: item.productTitle,
      expectedCents: item.lineTotalCents,
      actualCents: best.line.chargedPriceCents,
      differenceCents: best.line.chargedPriceCents - item.lineTotalCents,
      status,
      confidence,
      receiptLineId: best.line.id,
      candidateLineIds: [],
      // A weak match that changes what the shopper is told to have bought is
      // worth one tap to confirm.
      needsConfirmation: status === 'substituted',
      reason: reasonFor(status, item, best.line),
    });
  }

  const itemsAttributedCents = resolved.reduce((sum, entry) => sum + (entry.actualCents ?? 0), 0);
  const plannedFallbackCents = resolved
    .filter((entry) => entry.status === 'assumed_planned')
    .reduce((sum, entry) => sum + entry.expectedCents, 0);

  const discountCents = receipt
    ? (receipt.receiptDiscountCents ?? receiptDiscountTotalCents(receipt.lines))
    : 0;

  const unmatched: UnmatchedReceiptLine[] = receipt
    ? comparableItemLines(receipt.lines)
        .filter((line) => !claimed.has(line.id))
        .map((line) => ({
          receiptLineId: line.id,
          storeId,
          productName: line.productName,
          chargedPriceCents: line.chargedPriceCents,
          kind: line.kind,
        }))
    : [];

  /**
   * A printed total governs the stop when there is one.
   *
   * It is the only figure on the receipt the shopper actually paid, so tax, fees
   * and anything Juva failed to match are inside it by definition. Summed lines
   * are the fallback, and are recorded as such in provenance.
   */
  const usedPrintedTotal = receipt?.totalCents !== undefined;
  const stopActualCents = usedPrintedTotal
    ? (receipt?.totalCents ?? 0)
    : itemsAttributedCents +
      plannedFallbackCents +
      unmatched.reduce((sum, line) => sum + line.chargedPriceCents, 0) -
      discountCents;

  return {
    items: resolved,
    unmatched,
    itemsAttributedCents: itemsAttributedCents + plannedFallbackCents,
    stopActualCents,
    discountCents,
    provenance: {
      storeId,
      retailerName,
      source: receipt ? receipt.source : 'missing',
      usedPrintedTotal,
      lineCount: receipt ? receipt.lines.length : 0,
      ...(receipt?.confidence === undefined ? {} : { confidence: receipt.confidence }),
    },
  };
}

/**
 * Reconciles a whole trip.
 *
 * `confirmations` carries decisions the shopper has already made; passing none
 * yields the first pass, whose `needsConfirmation` flag drives what they are
 * asked. Re-running with their answers is what turns the result final — the
 * function is pure, so the same answers always produce the same money.
 */
export function reconcileTrip(
  trip: ShoppingTrip,
  receipts: readonly Receipt[],
  confirmations: readonly MatchConfirmation[] = [],
): ReconciliationResult {
  const receiptByStore = new Map<string, Receipt>();
  for (const receipt of receipts) {
    if (receipt.storeId !== undefined && !receiptByStore.has(receipt.storeId)) {
      receiptByStore.set(receipt.storeId, receipt);
    }
  }
  const decisions = new Map<string, string | null>(
    confirmations.map((entry) => [entry.tripItemId, entry.receiptLineId]),
  );

  const items: ReconciledItem[] = [];
  const unmatchedLines: UnmatchedReceiptLine[] = [];
  const provenance: ReconcileProvenance[] = [];
  let expectedTotalCents = 0;
  let actualTotalCents = 0;
  let attributedCents = 0;
  let receiptDiscountCents = 0;

  for (const stop of trip.stops) {
    const outcome = reconcileStop(
      stop.store.id,
      stop.store.retailerName,
      stop.items,
      receiptByStore.get(stop.store.id),
      decisions,
    );
    items.push(...outcome.items);
    unmatchedLines.push(...outcome.unmatched);
    provenance.push(outcome.provenance);
    expectedTotalCents += stop.expectedSubtotalCents;
    actualTotalCents += outcome.stopActualCents;
    attributedCents += outcome.itemsAttributedCents;
    receiptDiscountCents += outcome.discountCents;
  }

  const needsConfirmation = items.some((item) => item.needsConfirmation);
  const missingItemCount = items.filter((item) => item.status === 'missing').length;

  /**
   * Confidence is the weakest link, not an average.
   *
   * Averaging would let a pile of clean matches hide one stop with no receipt at
   * all. A shopper deciding whether to trust the figure cares about the worst
   * part of it.
   */
  const stopConfidences = provenance.map((entry) =>
    entry.source === 'missing' ? 0 : entry.source === 'manual' ? 0.8 : (entry.confidence ?? 0.5),
  );
  const matchPenalty = items.some((item) => item.needsConfirmation) ? 0.5 : 1;
  const confidence =
    stopConfidences.length === 0 ? 0 : Math.min(...stopConfidences, 1) * matchPenalty;

  return {
    items,
    unmatchedLines,
    receiptDiscountCents,
    expectedTotalCents,
    actualTotalCents,
    differenceCents: actualTotalCents - expectedTotalCents,
    unattributedCents: actualTotalCents - attributedCents,
    missingItemCount,
    needsConfirmation,
    confidence: Math.max(0, Math.min(1, confidence)),
    provenance,
  };
}
