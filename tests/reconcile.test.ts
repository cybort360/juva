import assert from 'node:assert/strict';
import test from 'node:test';

import { descriptionScore, reconcileTrip, type MatchConfirmation } from '../src/domain/reconcile';
import { snapshotOrigin } from '../src/domain/tripOrigin';
import type { Receipt, ReceiptLine, ShoppingTrip, Store, TripItem } from '../src/domain/types';

const store: Store = {
  id: 'grove',
  retailerId: 'grove',
  retailerName: 'Grove Market',
  displayName: 'Grove Market Dumbo',
  address: '48 Jay St',
  distanceMiles: 0.8,
  etaMinutes: 9,
  colorToken: 'forest',
};

function item(over: Partial<TripItem> & { groceryItemId: string }): TripItem {
  return {
    requestedName: 'milk',
    storeId: 'grove',
    retailerProductId: 'g-milk',
    productTitle: 'Whole Milk',
    productBrand: 'Grove Farms',
    sizeLabel: '1 gal',
    quantity: 1,
    packBasis: 'requested_count',
    roundedUp: false,
    listPriceCents: 349,
    unitPriceCents: 349,
    lineTotalCents: 349,
    listTotalCents: 349,
    promotionStatus: 'none',
    promotionSavingsCents: 0,
    substitutionSavingsCents: 0,
    confidence: 0.9,
    freshness: 'demo',
    source: 'demo',
    observedAt: '2026-01-01T00:00:00.000Z',
    substitution: false,
    status: 'pending',
    ...over,
  };
}

function line(over: Partial<ReceiptLine> & { id: string }): ReceiptLine {
  return {
    rawText: 'WHL MLK 1GAL',
    productName: 'Whole Milk',
    chargedPriceCents: 349,
    quantity: 1,
    kind: 'item',
    ...over,
  };
}

function trip(items: TripItem[], expectedSubtotalCents?: number): ShoppingTrip {
  return {
    id: 'trip-1',
    planId: 'plan-1',
    listTitle: 'Test basket',
    startedAt: '2026-01-01T00:00:00.000Z',
    currentStopIndex: 0,
    stops: [
      {
        store,
        items,
        expectedSubtotalCents:
          expectedSubtotalCents ?? items.reduce((sum, entry) => sum + entry.lineTotalCents, 0),
      },
    ],
    // Reconciliation reads none of these; they exist so the fixture is a real
    // ShoppingTrip rather than a partial one the type system had to be told to accept.
    origin: snapshotOrigin({
      planId: 'plan-1',
      planKind: 'recommended',
      basketCostCents: items.reduce((sum, entry) => sum + entry.lineTotalCents, 0),
      comparedBaselineCents: 0,
      baselineKind: 'none',
      savingsVsBaselineCents: 0,
      storeIds: [store.id],
      capturedAt: '2026-01-01T00:00:00.000Z',
      comparisonEligible: false,
    }),
    market: {
      mode: 'demo',
      capturedAt: '2026-01-01T00:00:00.000Z',
      stores: [store],
      products: [],
      promotions: [],
      list: {
        id: 'list-1',
        title: 'Test basket',
        prompt: 'test',
        currency: 'USD',
        createdAt: '2026-01-01T00:00:00.000Z',
        items: [],
      },
    },
    adaptations: [],
  };
}

function receipt(lines: ReceiptLine[], over: Partial<Receipt> = {}): Receipt {
  return {
    id: 'r1',
    capturedAt: '2026-01-01T01:00:00.000Z',
    storeId: 'grove',
    merchant: 'Grove Market',
    imageUris: [],
    currency: 'USD',
    source: 'scan',
    confidence: 0.9,
    lines,
    ...over,
  };
}

// ---------------------------------------------------------------- scoring

test('an abbreviated receipt description matches the planned product', () => {
  assert.ok(descriptionScore('Whole Milk', 'WHL MLK 1GAL') >= 0.6);
  assert.ok(descriptionScore('Boneless Chicken Breast', 'BNLS CHKN BRST') >= 0.6);
});

test('unrelated products do not score as a match', () => {
  assert.ok(descriptionScore('Whole Milk', 'BANANAS') < 0.2);
  assert.ok(descriptionScore('Long Grain Rice', 'SALES TAX') < 0.2);
});

test('an empty description scores zero rather than matching everything', () => {
  assert.equal(descriptionScore('Whole Milk', ''), 0);
  assert.equal(descriptionScore('', 'WHL MLK'), 0);
});

// ---------------------------------------------------------------- matching

test('an exactly-priced match is reported as matched with no difference', () => {
  const result = reconcileTrip(trip([item({ groceryItemId: 'i1' })]), [
    receipt([line({ id: 'l1' })], { totalCents: 349 }),
  ]);
  const first = result.items[0];
  assert.equal(first?.status, 'matched');
  assert.equal(first?.actualCents, 349);
  assert.equal(first?.differenceCents, 0);
  assert.equal(result.needsConfirmation, false);
});

test('a higher shelf price is a price change, not a substitution', () => {
  const result = reconcileTrip(trip([item({ groceryItemId: 'i1' })]), [
    receipt([line({ id: 'l1', chargedPriceCents: 399 })], { totalCents: 399 }),
  ]);
  assert.equal(result.items[0]?.status, 'price_changed');
  assert.equal(result.items[0]?.differenceCents, 50);
});

test('a planned item with nothing resembling it on the receipt is missing', () => {
  const result = reconcileTrip(trip([item({ groceryItemId: 'i1' })]), [
    receipt([line({ id: 'l1', rawText: 'BANANAS', productName: 'Bananas' })], {
      totalCents: 159,
    }),
  ]);
  assert.equal(result.items[0]?.status, 'missing');
  assert.equal(result.items[0]?.actualCents, undefined, 'a missing item has no actual price');
  assert.equal(result.missingItemCount, 1);
});

test('a missing item requires confirmation before the trip can be verified', () => {
  const result = reconcileTrip(trip([item({ groceryItemId: 'i1' })]), [
    receipt([line({ id: 'l1', rawText: 'BANANAS', productName: 'Bananas' })]),
  ]);
  assert.equal(result.needsConfirmation, true);
});

test('one receipt line cannot explain two planned items', () => {
  const result = reconcileTrip(
    trip([
      item({ groceryItemId: 'i1' }),
      item({ groceryItemId: 'i2', retailerProductId: 'g-milk-2' }),
    ]),
    [receipt([line({ id: 'l1' })])],
  );
  const matched = result.items.filter((entry) => entry.receiptLineId === 'l1');
  assert.equal(matched.length, 1, 'the line is claimed once');
});

test('two equally plausible lines make the match ambiguous rather than guessed', () => {
  const result = reconcileTrip(trip([item({ groceryItemId: 'i1' })]), [
    receipt([
      line({ id: 'l1', chargedPriceCents: 349 }),
      line({ id: 'l2', chargedPriceCents: 429 }),
    ]),
  ]);
  const first = result.items[0];
  assert.equal(first?.status, 'ambiguous');
  assert.equal(first?.needsConfirmation, true);
  assert.deepEqual(first?.candidateLineIds, ['l1', 'l2']);
  assert.equal(first?.actualCents, undefined, 'an unresolved match contributes no money');
});

test('a confirmation resolves an ambiguous match to the chosen line', () => {
  const base = trip([item({ groceryItemId: 'i1' })]);
  const receipts = [
    receipt([
      line({ id: 'l1', chargedPriceCents: 349 }),
      line({ id: 'l2', chargedPriceCents: 429 }),
    ]),
  ];
  const confirmations: MatchConfirmation[] = [{ tripItemId: 'i1', receiptLineId: 'l2' }];
  const result = reconcileTrip(base, receipts, confirmations);
  assert.equal(result.items[0]?.receiptLineId, 'l2');
  assert.equal(result.items[0]?.actualCents, 429);
  assert.equal(result.items[0]?.confidence, 'exact');
  assert.equal(result.needsConfirmation, false);
});

test('confirming an item was not bought settles it as missing with no money', () => {
  const result = reconcileTrip(
    trip([item({ groceryItemId: 'i1' })]),
    [receipt([line({ id: 'l1', chargedPriceCents: 349 }), line({ id: 'l2' })])],
    [{ tripItemId: 'i1', receiptLineId: null }],
  );
  assert.equal(result.items[0]?.status, 'missing');
  assert.equal(result.items[0]?.needsConfirmation, false);
  assert.equal(result.items[0]?.actualCents, undefined);
});

test('reconciliation is deterministic: the same inputs give the same money', () => {
  const build = () =>
    reconcileTrip(trip([item({ groceryItemId: 'i1' }), item({ groceryItemId: 'i2' })]), [
      receipt([line({ id: 'l1' }), line({ id: 'l2', chargedPriceCents: 399 })]),
    ]);
  assert.deepEqual(build(), build());
});

// ---------------------------------------------------------------- corrections

test('a shelf correction from Shop Mode outranks any receipt match', () => {
  const result = reconcileTrip(trip([item({ groceryItemId: 'i1', actualPriceCents: 500 })]), [
    receipt([line({ id: 'l1', chargedPriceCents: 349 })]),
  ]);
  assert.equal(result.items[0]?.actualCents, 500);
  assert.equal(result.items[0]?.confidence, 'exact');
  assert.equal(result.items[0]?.needsConfirmation, false);
});

// ---------------------------------------------------------------- totals

test('a printed total governs the stop, and the residual is reported not hidden', () => {
  const result = reconcileTrip(trip([item({ groceryItemId: 'i1' })]), [
    // 349 of item plus 30 of tax the shopper actually paid.
    receipt(
      [
        line({ id: 'l1' }),
        line({ id: 'l2', rawText: 'SALES TAX', kind: 'tax', chargedPriceCents: 30 }),
      ],
      {
        totalCents: 379,
      },
    ),
  ]);
  assert.equal(result.actualTotalCents, 379);
  assert.equal(result.unattributedCents, 30, 'tax is surfaced as unattributed, not absorbed');
});

test('without a printed total the stop is the sum of what was read', () => {
  const result = reconcileTrip(trip([item({ groceryItemId: 'i1' })]), [
    receipt([line({ id: 'l1', chargedPriceCents: 349 })]),
  ]);
  assert.equal(result.actualTotalCents, 349);
  assert.equal(result.provenance[0]?.usedPrintedTotal, false);
});

test('a receipt-level discount reduces a summed stop total', () => {
  const result = reconcileTrip(trip([item({ groceryItemId: 'i1' })]), [
    receipt([
      line({ id: 'l1', chargedPriceCents: 349 }),
      line({ id: 'l2', rawText: 'MFR COUPON', kind: 'discount', chargedPriceCents: -100 }),
    ]),
  ]);
  assert.equal(result.receiptDiscountCents, 100);
  assert.equal(result.actualTotalCents, 249);
});

test('an unmatched item line is counted in the total but attributed to nothing', () => {
  const result = reconcileTrip(trip([item({ groceryItemId: 'i1' })]), [
    receipt([
      line({ id: 'l1' }),
      line({ id: 'l2', rawText: 'CANDY BAR', productName: 'Candy Bar', chargedPriceCents: 199 }),
    ]),
  ]);
  assert.equal(result.unmatchedLines.length, 1);
  assert.equal(result.unmatchedLines[0]?.receiptLineId, 'l2');
  assert.equal(result.actualTotalCents, 548, 'the shopper still paid for it');
});

test('expected and actual and difference always reconcile', () => {
  const result = reconcileTrip(trip([item({ groceryItemId: 'i1' })]), [
    receipt([line({ id: 'l1', chargedPriceCents: 429 })], { totalCents: 429 }),
  ]);
  assert.equal(result.expectedTotalCents, 349);
  assert.equal(result.actualTotalCents, 429);
  assert.equal(result.differenceCents, result.actualTotalCents - result.expectedTotalCents);
});

test('tax and summary lines are never treated as buyable items', () => {
  const result = reconcileTrip(trip([item({ groceryItemId: 'i1' })]), [
    receipt([
      line({ id: 'l1' }),
      line({ id: 'l2', rawText: 'SUBTOTAL', kind: 'subtotal', chargedPriceCents: 349 }),
      line({ id: 'l3', rawText: 'SALES TAX', kind: 'tax', chargedPriceCents: 30 }),
    ]),
  ]);
  assert.equal(result.unmatchedLines.length, 0, 'summaries are not unmatched products');
});

test('a redacted line is invisible to matching', () => {
  const result = reconcileTrip(trip([item({ groceryItemId: 'i1' })]), [
    receipt([line({ id: 'l1', redacted: true, productName: 'Redacted', chargedPriceCents: 0 })]),
  ]);
  assert.equal(result.items[0]?.status, 'missing');
});

// ---------------------------------------------------------------- provenance

test('a stop with no receipt keeps the planned price and says so', () => {
  const result = reconcileTrip(trip([item({ groceryItemId: 'i1' })]), []);
  assert.equal(result.items[0]?.status, 'assumed_planned');
  assert.equal(result.actualTotalCents, 349, 'the plan stands in, unchanged');
  assert.equal(result.provenance[0]?.source, 'missing');
  assert.equal(result.confidence, 0, 'nothing was verified, so confidence is zero');
});

test('a manually typed total is recorded as manual, not as a read receipt', () => {
  const result = reconcileTrip(trip([item({ groceryItemId: 'i1' })]), [
    receipt([], { source: 'manual', totalCents: 400, confidence: undefined }),
  ]);
  assert.equal(result.provenance[0]?.source, 'manual');
  assert.equal(result.provenance[0]?.usedPrintedTotal, true);
  assert.equal(result.actualTotalCents, 400);
});

test('confidence is the weakest link, not an average', () => {
  const twoStops: ShoppingTrip = {
    ...trip([item({ groceryItemId: 'i1' })]),
    stops: [
      { store, items: [item({ groceryItemId: 'i1' })], expectedSubtotalCents: 349 },
      {
        store: { ...store, id: 'north', retailerName: 'North Market' },
        items: [item({ groceryItemId: 'i2', storeId: 'north' })],
        expectedSubtotalCents: 349,
      },
    ],
  };
  const result = reconcileTrip(twoStops, [
    receipt([line({ id: 'l1' })], { confidence: 0.95, totalCents: 349 }),
  ]);
  // One clean stop cannot average away a stop with no receipt at all.
  assert.equal(result.confidence, 0);
});

test('an unconfirmed match halves confidence rather than reporting certainty', () => {
  const clean = reconcileTrip(trip([item({ groceryItemId: 'i1' })]), [
    receipt([line({ id: 'l1' })], { confidence: 0.9, totalCents: 349 }),
  ]);
  const contested = reconcileTrip(trip([item({ groceryItemId: 'i1' })]), [
    receipt([line({ id: 'l1' }), line({ id: 'l2', chargedPriceCents: 429 })], {
      confidence: 0.9,
      totalCents: 778,
    }),
  ]);
  assert.ok(contested.confidence < clean.confidence);
});

test('confidence never leaves the zero-to-one range', () => {
  const result = reconcileTrip(trip([item({ groceryItemId: 'i1' })]), [
    receipt([line({ id: 'l1' })], { confidence: 5, totalCents: 349 }),
  ]);
  assert.ok(result.confidence >= 0 && result.confidence <= 1);
});

test('provenance names every stop, including the ones with no receipt', () => {
  const result = reconcileTrip(trip([item({ groceryItemId: 'i1' })]), []);
  assert.equal(result.provenance.length, 1);
  assert.equal(result.provenance[0]?.retailerName, 'Grove Market');
});

// ---------------------------------------------------------------- locality

test('a receipt from another store never settles this stop', () => {
  const result = reconcileTrip(trip([item({ groceryItemId: 'i1' })]), [
    receipt([line({ id: 'l1' })], { storeId: 'somewhere-else', totalCents: 100 }),
  ]);
  assert.equal(result.items[0]?.status, 'assumed_planned');
  assert.equal(result.provenance[0]?.source, 'missing');
});

// ------------------------------------------------- manual and total-only entry

test('a typed total settles the stop without asking about individual items', () => {
  // Manual entry is a supported fallback, so it has to be verifiable. With no
  // lines there is nothing to match, and that is not the same as items missing.
  const result = reconcileTrip(
    trip([item({ groceryItemId: 'i1' }), item({ groceryItemId: 'i2' })]),
    [receipt([], { source: 'manual', totalCents: 900, confidence: undefined })],
  );
  assert.equal(result.needsConfirmation, false, 'there is no question to put to the shopper');
  assert.equal(result.missingItemCount, 0, 'unchecked is not the same as not bought');
  assert.equal(result.actualTotalCents, 900);
  assert.ok(result.items.every((entry) => entry.status === 'assumed_planned'));
});

test('a typed total still surfaces the residual against the plan', () => {
  const result = reconcileTrip(trip([item({ groceryItemId: 'i1' })]), [
    receipt([], { source: 'manual', totalCents: 449, confidence: undefined }),
  ]);
  assert.equal(result.expectedTotalCents, 349);
  assert.equal(result.unattributedCents, 100, 'the extra 1.00 is visible, not absorbed');
});

test('a receipt whose every line was redacted behaves as total-only', () => {
  const result = reconcileTrip(trip([item({ groceryItemId: 'i1' })]), [
    receipt([line({ id: 'l1', redacted: true, chargedPriceCents: 0 })], { totalCents: 500 }),
  ]);
  assert.equal(result.needsConfirmation, false);
  assert.equal(result.actualTotalCents, 500);
});

test('a scan with neither lines nor a total cannot settle the stop', () => {
  const result = reconcileTrip(trip([item({ groceryItemId: 'i1' })]), [
    receipt([], { source: 'scan', confidence: 0.2 }),
  ]);
  assert.equal(result.needsConfirmation, true, 'nothing was read, so nothing is settled');
});

test('a shelf correction still wins inside a total-only stop', () => {
  const result = reconcileTrip(trip([item({ groceryItemId: 'i1', actualPriceCents: 500 })]), [
    receipt([], { source: 'manual', totalCents: 500, confidence: undefined }),
  ]);
  assert.equal(result.items[0]?.actualCents, 500);
  assert.equal(result.items[0]?.confidence, 'exact');
});
