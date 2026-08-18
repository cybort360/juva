import assert from 'node:assert/strict';
import { test } from 'node:test';

import { demoPreferences } from '../src/domain/demoMarket';
import { optimizeBasket } from '../src/domain/optimizer';
import { reconcileTrip, type MatchConfirmation } from '../src/domain/reconcile';
import {
  buildLedger,
  isReadableLedger,
  persistLedger,
  readableLedgers,
  RECEIPT_OBSERVATIONS_ARE_LOCAL_ONLY,
} from '../src/domain/savingsLedger';
import { adaptTrip, applyAdaptation } from '../src/domain/shopAdapt';
import { createTrip } from '../src/domain/trip';
import type {
  GroceryList,
  GroceryListItem,
  MarketSnapshot,
  OptimizedPlan,
  PersistedLedger,
  Receipt,
  ReceiptLine,
  ReconciliationCorrection,
  RetailerProduct,
  ShoppingTrip,
  Store,
  UserPreferences,
} from '../src/domain/types';
import { LEDGER_SCHEMA_VERSION } from '../src/domain/types';

/**
 * The proof layer's user-facing guarantees.
 *
 * Three things are under test here that the ledger suite does not cover: that a refusal
 * never looks like a verified zero, that an ambiguous receipt is settled by the shopper
 * rather than the engine, and that the whole chain survives a restart with the figures
 * bit-identical. The last one is the completion gate, and it is the final test in the
 * file.
 */

const NOW = new Date('2026-08-18T14:00:00Z');

const prefs: UserPreferences = {
  ...demoPreferences,
  onboarded: true,
  maxStores: 1,
  radiusMiles: 25,
  loyaltyRetailers: [],
  couponIds: [],
};

function store(id: string, distanceMiles: number): Store {
  return {
    id,
    retailerId: id,
    retailerName: id === 'near' ? 'Grove Market' : 'North Market',
    displayName: id,
    address: `${id} street`,
    distanceMiles,
    etaMinutes: Math.round(distanceMiles * 4),
    colorToken: 'forest',
  };
}

function priced(spec: {
  id: string;
  concept: string;
  storeId: string;
  price: number;
  title?: string;
}): RetailerProduct {
  return {
    id: spec.id,
    canonicalConcept: spec.concept,
    storeId: spec.storeId,
    title: spec.title ?? spec.concept,
    brand: 'Generic',
    sizeLabel: '1 ct',
    observation: {
      id: `obs-${spec.id}`,
      storeId: spec.storeId,
      retailerId: spec.storeId,
      retailerProductId: spec.id,
      scope: 'store',
      priceCents: spec.price,
      currency: 'USD',
      source: 'demo',
      observedAt: NOW.toISOString(),
      freshness: 'demo',
      confidence: 1,
      available: true,
      availability: 'in_stock',
    },
  };
}

function basket(items: Partial<GroceryListItem>[]): GroceryList {
  return {
    id: 'list-1',
    title: 'Weekly groceries',
    prompt: 'weekly',
    currency: 'USD',
    createdAt: NOW.toISOString(),
    items: items.map((item, index) => ({
      id: item.id ?? `i${index + 1}`,
      concept: item.concept ?? 'milk',
      displayName: item.displayName ?? item.concept ?? 'Milk',
      quantity: item.quantity ?? 1,
      unit: item.unit ?? '1 ct',
    })),
  };
}

function line(over: Partial<ReceiptLine> & { id: string }): ReceiptLine {
  return {
    rawText: over.productName ?? 'ITEM',
    productName: over.productName ?? 'Item',
    chargedPriceCents: 0,
    quantity: 1,
    kind: 'item',
    ...over,
  };
}

function receipt(storeId: string, lines: ReceiptLine[]): Receipt {
  return {
    id: `r-${storeId}`,
    capturedAt: NOW.toISOString(),
    storeId,
    merchant: 'Grove Market',
    source: 'scan',
    imageUris: [],
    currency: 'USD',
    lines,
    totalCents: lines.reduce((sum, entry) => sum + entry.chargedPriceCents, 0),
    confidence: 0.95,
  };
}

function start(
  list: GroceryList,
  stores: Store[],
  products: RetailerProduct[],
): { trip: ShoppingTrip; plan: OptimizedPlan } {
  const plans = optimizeBasket({
    list,
    stores,
    products,
    promotions: [],
    preferences: prefs,
    now: NOW,
  });
  const plan = plans.find((entry) => entry.kind === 'recommended') ?? plans[0];
  assert.ok(plan);
  const snapshot: MarketSnapshot = {
    mode: 'demo',
    fetchedAt: NOW.toISOString(),
    stores,
    products,
    promotions: [],
  };
  return { trip: createTrip(plan, list, snapshot, NOW), plan };
}

function ledgerFor(
  trip: ShoppingTrip,
  plan: OptimizedPlan,
  receipts: Receipt[],
  confirmations: MatchConfirmation[] = [],
  corrections: ReconciliationCorrection[] = [],
) {
  return buildLedger({
    trip,
    plan,
    receipts,
    currency: 'USD',
    confirmations,
    corrections,
    now: NOW,
  });
}

/** Two lines, one store cheaper than the other so a real saving is reachable. */
function market() {
  const stores = [store('near', 1), store('far', 3)];
  const products = [
    priced({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 349, title: 'Whole Milk' }),
    priced({ id: 'near-eggs', concept: 'eggs', storeId: 'near', price: 399, title: 'Large Eggs' }),
    priced({ id: 'far-milk', concept: 'milk', storeId: 'far', price: 600, title: 'Whole Milk' }),
    priced({ id: 'far-eggs', concept: 'eggs', storeId: 'far', price: 700, title: 'Large Eggs' }),
  ];
  const list = basket([
    { concept: 'milk', displayName: 'Milk' },
    { concept: 'eggs', displayName: 'Eggs' },
  ]);
  return { stores, products, list };
}

// ── 1. Integrity failure is not a zero saving ───────────────────────────────

test('a verified zero and an integrity failure are different results', () => {
  const { stores, products, list } = market();
  const { trip, plan } = start(list, stores, products);
  const receipts = [
    receipt('near', [
      line({ id: 'l1', productName: 'Whole Milk', chargedPriceCents: 349 }),
      line({ id: 'l2', productName: 'Large Eggs', chargedPriceCents: 399 }),
    ]),
  ];

  const honest = ledgerFor(trip, plan, receipts);
  const tampered = JSON.parse(JSON.stringify(trip)) as ShoppingTrip;
  tampered.origin.comparedBaselineCents = 12_345;
  const broken = ledgerFor(tampered, plan, receipts);

  // The verified case carries a figure — which may legitimately be zero.
  assert.equal(honest.claimability.state, 'verified');
  assert.equal(typeof honest.verifiedSavingsCents, 'number');

  // The integrity failure carries none at all. This is the distinction: a shopper
  // reading "$0.00" cannot tell whether Juva checked or refused.
  assert.equal(broken.claimability.state, 'integrity_failed');
  assert.equal(broken.verifiedSavingsCents, undefined);
  assert.notEqual(broken.verifiedSavingsCents, 0);
});

test('an integrity failure still shows what was actually paid', () => {
  const { stores, products, list } = market();
  const { trip, plan } = start(list, stores, products);
  const tampered = JSON.parse(JSON.stringify(trip)) as ShoppingTrip;
  tampered.origin.basketCostCents = 1;

  const ledger = ledgerFor(tampered, plan, [
    receipt('near', [
      line({ id: 'l1', productName: 'Whole Milk', chargedPriceCents: 349 }),
      line({ id: 'l2', productName: 'Large Eggs', chargedPriceCents: 399 }),
    ]),
  ]);
  assert.equal(ledger.actualCents, 748, 'the receipt total is not withheld');
  assert.equal(ledger.verifiedSavingsCents, undefined, 'only the claim is');
  assert.ok(ledger.integrity.evidence, 'and the evidence is retained');
});

test('integrity failure outranks every other blocker in the state', () => {
  // A trip can be both corrupted and missing a receipt. The state must name the fatal
  // problem, not the recoverable one.
  const { stores, products, list } = market();
  const { trip, plan } = start(list, stores, products);
  const tampered = JSON.parse(JSON.stringify(trip)) as ShoppingTrip;
  tampered.origin.savingsVsBaselineCents = 99;

  const ledger = ledgerFor(tampered, plan, []);
  assert.equal(ledger.claimability.state, 'integrity_failed');
  assert.ok(ledger.claimability.blockers.includes('receipt_missing'), 'both are reported');
});

test('pending and blocked are distinguished from each other', () => {
  const { stores, products, list } = market();
  const { trip, plan } = start(list, stores, products);

  // No receipt yet: recoverable.
  assert.equal(ledgerFor(trip, plan, []).claimability.state, 'pending');

  // An item dropped: this basket will never be the one the baseline priced.
  const decision = adaptTrip({
    trip,
    event: { kind: 'unavailable', groceryItemId: 'i1' },
    preferences: prefs,
    now: NOW,
  });
  assert.ok(decision);
  const dropped = applyAdaptation({ trip, decision, chosenOptionId: 'drop', now: NOW });
  assert.ok(dropped);
  assert.equal(ledgerFor(dropped.trip, plan, []).claimability.state, 'blocked');
});

// ── 4. Duplicate and ambiguous receipt lines ────────────────────────────────

/** One planned line, two receipt lines that could both be it. */
function ambiguousSetup() {
  const stores = [store('near', 1), store('far', 3)];
  const products = [
    priced({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 349, title: 'Whole Milk' }),
    priced({ id: 'far-milk', concept: 'milk', storeId: 'far', price: 600, title: 'Whole Milk' }),
  ];
  const list = basket([{ concept: 'milk', displayName: 'Milk' }]);
  return start(list, stores, products);
}

test('two identical receipt lines are never resolved arbitrarily', () => {
  const { trip, plan } = ambiguousSetup();
  const ledger = ledgerFor(trip, plan, [
    receipt('near', [
      line({ id: 'a', productName: 'Whole Milk', chargedPriceCents: 349 }),
      line({ id: 'b', productName: 'Whole Milk', chargedPriceCents: 349 }),
    ]),
  ]);
  const reconciliation = reconcileTrip(trip, [
    receipt('near', [
      line({ id: 'a', productName: 'Whole Milk', chargedPriceCents: 349 }),
      line({ id: 'b', productName: 'Whole Milk', chargedPriceCents: 349 }),
    ]),
  ]);

  const item = reconciliation.items[0];
  assert.ok(item);
  assert.equal(item.needsConfirmation, true, 'the engine refuses to choose');
  assert.ok(item.candidateLineIds.length >= 2, 'and offers both candidates');
  assert.equal(ledger.claimability.state, 'pending');
});

test('two same-price lines with different names are still ambiguous', () => {
  const { trip } = ambiguousSetup();
  const reconciliation = reconcileTrip(trip, [
    receipt('near', [
      line({ id: 'a', productName: 'WHOLE MILK 1GAL', chargedPriceCents: 349 }),
      line({ id: 'b', productName: 'MILK WHOLE GAL', chargedPriceCents: 349 }),
    ]),
  ]);
  const item = reconciliation.items[0];
  assert.ok(item);
  assert.equal(item.needsConfirmation, true);
});

test('a duplicated quantity line is surfaced rather than summed', () => {
  const { trip } = ambiguousSetup();
  const reconciliation = reconcileTrip(trip, [
    receipt('near', [
      line({ id: 'a', productName: 'Whole Milk', chargedPriceCents: 349, quantity: 1 }),
      line({ id: 'b', productName: 'Whole Milk', chargedPriceCents: 349, quantity: 2 }),
    ]),
  ]);
  const item = reconciliation.items[0];
  assert.ok(item);
  assert.equal(item.needsConfirmation, true, 'two quantities is a question, not a total');
  assert.notEqual(item.actualCents, 1047, 'nothing was silently summed');
});

test('the shopper selecting the first line settles it, and is recorded as their choice', () => {
  const { trip } = ambiguousSetup();
  const receipts = [
    receipt('near', [
      line({ id: 'a', productName: 'Whole Milk', chargedPriceCents: 349 }),
      line({ id: 'b', productName: 'Whole Milk', chargedPriceCents: 500 }),
    ]),
  ];
  const result = reconcileTrip(trip, receipts, [{ tripItemId: 'i1', receiptLineId: 'a' }]);
  const item = result.items[0];
  assert.ok(item);
  assert.equal(item.needsConfirmation, false);
  assert.equal(item.actualCents, 349);
  assert.equal(item.receiptLineId, 'a');
  assert.equal(item.userConfirmed, true, 'marked as the shopper’s decision, not a score');
  assert.equal(result.needsConfirmation, false);
});

test('the shopper selecting the second line settles it to that line instead', () => {
  const { trip } = ambiguousSetup();
  const receipts = [
    receipt('near', [
      line({ id: 'a', productName: 'Whole Milk', chargedPriceCents: 349 }),
      line({ id: 'b', productName: 'Whole Milk', chargedPriceCents: 500 }),
    ]),
  ];
  const item = reconcileTrip(trip, receipts, [{ tripItemId: 'i1', receiptLineId: 'b' }]).items[0];
  assert.ok(item);
  assert.equal(item.actualCents, 500, 'the shopper’s choice governs, not the closer price');
  assert.equal(item.receiptLineId, 'b');
  assert.equal(item.userConfirmed, true);
});

test('the shopper rejecting both marks the item as not bought', () => {
  const { trip, plan } = ambiguousSetup();
  const receipts = [
    receipt('near', [
      line({ id: 'a', productName: 'Whole Milk', chargedPriceCents: 349 }),
      line({ id: 'b', productName: 'Whole Milk', chargedPriceCents: 349 }),
    ]),
  ];
  const confirmations: MatchConfirmation[] = [{ tripItemId: 'i1', receiptLineId: null }];
  const item = reconcileTrip(trip, receipts, confirmations).items[0];
  assert.ok(item);
  assert.equal(item.status, 'missing');
  assert.equal(item.needsConfirmation, false);
  assert.equal(item.actualCents, undefined);

  // And a basket with an item that was not bought is no longer comparable.
  const ledger = ledgerFor(trip, plan, receipts, confirmations);
  assert.notEqual(ledger.claimability.state, 'verified');
});

// ── 5. Manual substitute lifecycle ──────────────────────────────────────────

test('a manual substitute is never promoted to verified on text similarity alone', () => {
  // Juva never saw this product. A resemblance between the shopper's typing and the
  // receipt's printing is not proof they are the same thing.
  const { stores, products, list } = market();
  const { trip, plan } = start(list, stores, products);
  const decision = adaptTrip({
    trip,
    event: {
      kind: 'substitute',
      groceryItemId: 'i1',
      manualSubstitute: { title: 'Shop brand milk', priceCents: 289 },
    },
    preferences: prefs,
    now: NOW,
  });
  assert.ok(decision);
  const applied = applyAdaptation({
    trip,
    decision,
    chosenOptionId: 'manual_substitute',
    now: NOW,
  });
  assert.ok(applied);

  const receipts = [
    receipt('near', [
      line({ id: 'l1', productName: 'SHOP BRAND MILK', chargedPriceCents: 289 }),
      line({ id: 'l2', productName: 'Large Eggs', chargedPriceCents: 399 }),
    ]),
  ];

  const unconfirmed = ledgerFor(applied.trip, plan, receipts);
  const substitute = unconfirmed.lines.find((entry) => entry.manualSubstitute);
  assert.ok(substitute);
  assert.notEqual(substitute.state, 'receipt_verified', 'a text match is not enough');
  assert.equal(substitute.state, 'needs_review');

  // The shopper confirming it is the evidence that promotes it.
  const confirmed = ledgerFor(applied.trip, plan, receipts, [
    { tripItemId: 'i1', receiptLineId: 'l1' },
  ]);
  const promoted = confirmed.lines.find((entry) => entry.manualSubstitute);
  assert.ok(promoted);
  assert.equal(promoted.state, 'receipt_verified');
  assert.equal(promoted.sourceType, 'receipt_verified');
  assert.equal(
    confirmed.claimability.blockers.includes('unverified_substitute'),
    false,
    'and it stops blocking the claim',
  );
});

// ── 3. Persistence and schema versioning ────────────────────────────────────

test('a frozen ledger carries its schema version and its stores', () => {
  const { stores, products, list } = market();
  const { trip, plan } = start(list, stores, products);
  const ledger = ledgerFor(trip, plan, []);
  const frozen = persistLedger(ledger, ['Grove Market'], NOW);

  assert.equal(frozen.schemaVersion, LEDGER_SCHEMA_VERSION);
  assert.deepEqual(frozen.storeNames, ['Grove Market']);
  assert.equal(frozen.ledger.tripId, trip.id);
  assert.equal(isReadableLedger(frozen), true);
});

test('a ledger from a newer schema is not guessed at', () => {
  const { stores, products, list } = market();
  const { trip, plan } = start(list, stores, products);
  const future: PersistedLedger = {
    ...persistLedger(ledgerFor(trip, plan, []), [], NOW),
    schemaVersion: LEDGER_SCHEMA_VERSION + 1,
  };
  assert.equal(isReadableLedger(future), false);
  assert.deepEqual(readableLedgers([future]), [], 'left alone rather than misread');
});

test('readable ledgers come back newest first', () => {
  const { stores, products, list } = market();
  const { trip, plan } = start(list, stores, products);
  const ledger = ledgerFor(trip, plan, []);
  const older = persistLedger(ledger, [], new Date('2026-01-01T00:00:00Z'));
  const newer = persistLedger(ledger, [], new Date('2026-08-01T00:00:00Z'));
  assert.deepEqual(
    readableLedgers([older, newer]).map((entry) => entry.savedAt),
    [newer.savedAt, older.savedAt],
  );
});

// ── 6. Receipt observations stay out of the shared Price Graph ──────────────

test('receipt-derived observations are documented as local-only, not half-built', () => {
  // Deliberately a constant and a doc comment rather than a feature flag guarding a
  // partial implementation: there is nothing to switch on, and there should not be until
  // the aggregation and privacy rules exist.
  assert.equal(RECEIPT_OBSERVATIONS_ARE_LOCAL_ONLY, true);
});

// ── 7. The complete lifecycle, across a restart ─────────────────────────────

test('the whole economic chain survives a restart with identical figures', () => {
  // plan → trip → adaptation → checkout → receipt → ambiguous line → correction →
  // reconciliation → verified saving → restart → history → reopen → same result.
  const { stores, products, list } = market();
  const { trip, plan } = start(list, stores, products);

  // 1. An in-store adaptation: the milk rang up dearer than planned.
  const decision = adaptTrip({
    trip,
    event: { kind: 'different_price', groceryItemId: 'i1', observedPriceCents: 379 },
    preferences: prefs,
    now: NOW,
  });
  assert.ok(decision);
  const shopped = applyAdaptation({ trip, decision, chosenOptionId: 'buy_here', now: NOW });
  assert.ok(shopped);

  // 2. A receipt with an ambiguous pair for the eggs.
  const receipts = [
    receipt('near', [
      line({ id: 'm', productName: 'Whole Milk', chargedPriceCents: 379 }),
      line({ id: 'e1', productName: 'Large Eggs', chargedPriceCents: 399 }),
      line({ id: 'e2', productName: 'Large Eggs', chargedPriceCents: 419 }),
    ]),
  ];
  const unsettled = ledgerFor(shopped.trip, plan, receipts);
  assert.equal(unsettled.claimability.state, 'pending', 'ambiguity blocks the claim');

  // 3. The shopper settles it, and adds a late correction they noticed at home.
  const confirmations: MatchConfirmation[] = [{ tripItemId: 'i2', receiptLineId: 'e2' }];
  const corrections: ReconciliationCorrection[] = [
    {
      id: 'c1',
      at: NOW.toISOString(),
      tripItemId: 'i1',
      kind: 'price_differed',
      beforeCents: 379,
      actualCents: 379,
      note: 'checked the receipt at home',
    },
  ];

  const settled = ledgerFor(shopped.trip, plan, receipts, confirmations, corrections);
  assert.equal(settled.claimability.state, 'verified', settled.claimability.blockers.join(','));
  assert.equal(typeof settled.verifiedSavingsCents, 'number');

  // 4. Freeze it, exactly as `verifyActiveTrip` does.
  const frozen = persistLedger(settled, ['Grove Market'], NOW);

  // 5. Restart: everything goes through JSON and comes back.
  const rehydrated = JSON.parse(JSON.stringify({ ledgers: [frozen] })) as {
    ledgers: PersistedLedger[];
  };
  const reopened = readableLedgers(rehydrated.ledgers)[0];
  assert.ok(reopened, 'history finds the trip');

  // 6. The proof is byte-for-byte what it was.
  assert.equal(
    JSON.stringify(reopened.ledger),
    JSON.stringify(settled),
    'the reopened ledger is identical, not merely equivalent',
  );
  assert.equal(reopened.ledger.verifiedSavingsCents, settled.verifiedSavingsCents);
  assert.equal(reopened.ledger.baselineCents, trip.origin.comparedBaselineCents);
  assert.equal(reopened.ledger.originalPlannedCents, trip.origin.basketCostCents);
  assert.equal(reopened.ledger.integrity.ok, true);
  assert.equal(reopened.ledger.corrections.length, 1);
  assert.equal(reopened.ledger.integrity.expectedFingerprint, trip.origin.fingerprint);

  // 7. And the in-store history was never rewritten by any of it.
  assert.equal(shopped.trip.adaptations.length, 1);
  assert.equal(shopped.trip.adaptations[0]?.event, 'different_price');
});

test('a frozen ledger does not drift when the live trip changes afterwards', () => {
  // The reason for storing a snapshot rather than reconstructing: a later edit to the
  // trip must not change what a past trip proved.
  const { stores, products, list } = market();
  const { trip, plan } = start(list, stores, products);
  const receipts = [
    receipt('near', [
      line({ id: 'l1', productName: 'Whole Milk', chargedPriceCents: 349 }),
      line({ id: 'l2', productName: 'Large Eggs', chargedPriceCents: 399 }),
    ]),
  ];
  const frozen = persistLedger(ledgerFor(trip, plan, receipts), [], NOW);
  const before = JSON.stringify(frozen.ledger);

  const decision = adaptTrip({
    trip,
    event: { kind: 'different_price', groceryItemId: 'i1', observedPriceCents: 900 },
    preferences: prefs,
    now: NOW,
  });
  assert.ok(decision);
  const changed = applyAdaptation({ trip, decision, chosenOptionId: 'buy_here', now: NOW });
  assert.ok(changed);

  assert.equal(JSON.stringify(frozen.ledger), before, 'the frozen record is untouched');
  const recomputed = ledgerFor(changed.trip, plan, receipts);
  assert.notEqual(
    recomputed.finalExpectedCents,
    frozen.ledger.finalExpectedCents,
    'while the live figure did move — which is exactly why it is not the record',
  );
});
