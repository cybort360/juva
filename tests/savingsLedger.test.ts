import assert from 'node:assert/strict';
import { test } from 'node:test';

import { demoPreferences } from '../src/domain/demoMarket';
import { optimizeBasket } from '../src/domain/optimizer';
import { buildLedger, checkIntegrity, describeBlocker } from '../src/domain/savingsLedger';
import { adaptTrip, applyAdaptation, type ShopEvent } from '../src/domain/shopAdapt';
import { createTrip } from '../src/domain/trip';
import type {
  GroceryList,
  GroceryListItem,
  MarketSnapshot,
  OptimizedPlan,
  Promotion,
  Receipt,
  ReceiptLine,
  ReconciliationCorrection,
  RetailerProduct,
  ShoppingTrip,
  Store,
  UserPreferences,
} from '../src/domain/types';

/**
 * The economic proof layer.
 *
 * The chain under test is baseline → plan → adaptation → actual purchase → verified
 * saving, and the tests are as much about the refusals as the arithmetic. A verified
 * saving is a claim Juva has to earn, so most of what follows checks that it is withheld
 * when a link is missing — and withheld loudly, with a named reason, rather than
 * silently reduced to zero.
 */

const NOW = new Date('2026-08-18T12:00:00Z');

const prefs: UserPreferences = {
  ...demoPreferences,
  onboarded: true,
  maxStores: 2,
  radiusMiles: 25,
  loyaltyRetailers: [],
  couponIds: [],
  conveniencePreference: 0.5,
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
  brand?: string;
  size?: string;
  barcode?: string;
}): RetailerProduct {
  return {
    id: spec.id,
    canonicalConcept: spec.concept,
    storeId: spec.storeId,
    title: spec.title ?? `${spec.concept} at ${spec.storeId}`,
    brand: spec.brand ?? 'Generic',
    sizeLabel: spec.size ?? '1 ct',
    ...(spec.barcode === undefined ? {} : { identifiers: { barcode: spec.barcode } }),
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

function receipt(storeId: string, lines: ReceiptLine[], over: Partial<Receipt> = {}): Receipt {
  const total = lines.reduce((sum, entry) => sum + entry.chargedPriceCents, 0);
  return {
    id: `r-${storeId}`,
    capturedAt: NOW.toISOString(),
    storeId,
    merchant: storeId === 'near' ? 'Grove Market' : 'North Market',
    source: 'scan',
    imageUris: [],
    currency: 'USD',
    lines,
    totalCents: total,
    confidence: 0.95,
    ...over,
  };
}

/** Plans a basket and starts the trip, exactly as the app does. */
function start(
  list: GroceryList,
  stores: Store[],
  products: RetailerProduct[],
  promotions: Promotion[] = [],
): { trip: ShoppingTrip; plan: OptimizedPlan } {
  const plans = optimizeBasket({
    list,
    stores,
    products,
    promotions,
    preferences: prefs,
    now: NOW,
  });
  const plan = plans.find((entry) => entry.kind === 'recommended') ?? plans[0];
  assert.ok(plan, 'the fixture must produce a plan');
  const snapshot: MarketSnapshot = {
    mode: 'demo',
    fetchedAt: NOW.toISOString(),
    stores,
    products,
    promotions,
  };
  return { trip: createTrip(plan, list, snapshot, NOW), plan };
}

function ledgerFor(
  trip: ShoppingTrip,
  plan: OptimizedPlan,
  receipts: Receipt[],
  corrections: ReconciliationCorrection[] = [],
) {
  return buildLedger({ trip, plan, receipts, currency: 'USD', corrections, now: NOW });
}

/**
 * One store, two lines. `far` is dearer, so the baseline is a real comparison rather
 * than the plan itself, and a verified saving is actually reachable.
 */
function singleStoreMarket() {
  const stores = [store('near', 1), store('far', 3)];
  const products = [
    priced({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 349, title: 'Whole Milk' }),
    priced({ id: 'near-eggs', concept: 'eggs', storeId: 'near', price: 399, title: 'Large Eggs' }),
    priced({ id: 'far-milk', concept: 'milk', storeId: 'far', price: 500, title: 'Whole Milk' }),
    priced({ id: 'far-eggs', concept: 'eggs', storeId: 'far', price: 600, title: 'Large Eggs' }),
  ];
  const list = basket([
    { concept: 'milk', displayName: 'Milk' },
    { concept: 'eggs', displayName: 'Eggs' },
  ]);
  return { stores, products, list };
}

// ── The five preserved figures ──────────────────────────────────────────────

test('the ledger keeps baseline, plan, adapted plan, actual and verified apart', () => {
  const { stores, products, list } = singleStoreMarket();
  const { trip, plan } = start(list, stores, products);
  const ledger = ledgerFor(trip, plan, [
    receipt('near', [
      line({ id: 'l1', productName: 'Whole Milk', chargedPriceCents: 349 }),
      line({ id: 'l2', productName: 'Large Eggs', chargedPriceCents: 399 }),
    ]),
  ]);

  assert.equal(ledger.baselineCents, trip.origin.comparedBaselineCents);
  assert.equal(ledger.originalPlannedCents, trip.origin.basketCostCents);
  assert.equal(ledger.finalExpectedCents, 748);
  assert.equal(ledger.actualCents, 748);
  assert.equal(ledger.differenceCents, 0);
  // Five distinct fields; none is derived by overwriting another.
  assert.ok('verifiedSavingsCents' in ledger && 'estimatedSavingsCents' in ledger);
  assert.equal(ledger.baselineLabel, 'Cheapest complete 1-store basket');
});

test('an exact receipt yields a verified saving against the frozen baseline', () => {
  const stores = [store('near', 1), store('far', 3)];
  const products = [
    priced({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 349, title: 'Whole Milk' }),
    priced({ id: 'near-eggs', concept: 'eggs', storeId: 'near', price: 399, title: 'Large Eggs' }),
    priced({ id: 'far-milk', concept: 'milk', storeId: 'far', price: 500, title: 'Whole Milk' }),
    priced({ id: 'far-eggs', concept: 'eggs', storeId: 'far', price: 600, title: 'Large Eggs' }),
  ];
  const list = basket([
    { concept: 'milk', displayName: 'Milk' },
    { concept: 'eggs', displayName: 'Eggs' },
  ]);
  const { trip, plan } = start(list, stores, products);

  const ledger = ledgerFor(trip, plan, [
    receipt('near', [
      line({ id: 'l1', productName: 'Whole Milk', chargedPriceCents: 349 }),
      line({ id: 'l2', productName: 'Large Eggs', chargedPriceCents: 399 }),
    ]),
  ]);

  assert.equal(ledger.claimability.claimable, true, ledger.claimability.blockers.join(','));
  assert.equal(
    ledger.verifiedSavingsCents,
    Math.max(0, ledger.baselineCents - ledger.actualCents),
    'baseline minus actual eligible spend',
  );
});

// ── Origin integrity fails closed ───────────────────────────────────────────

test('a corrupted origin stops the verified saving and preserves the evidence', () => {
  const { stores, products, list } = singleStoreMarket();
  const { trip, plan } = start(list, stores, products);
  const tampered = JSON.parse(JSON.stringify(trip)) as ShoppingTrip;
  tampered.origin.comparedBaselineCents = 99_999;

  const ledger = ledgerFor(tampered, plan, [
    receipt('near', [
      line({ id: 'l1', productName: 'Whole Milk', chargedPriceCents: 349 }),
      line({ id: 'l2', productName: 'Large Eggs', chargedPriceCents: 399 }),
    ]),
  ]);

  assert.equal(ledger.integrity.ok, false);
  assert.equal(ledger.claimability.state, 'integrity_failed');
  assert.equal(
    ledger.verifiedSavingsCents,
    undefined,
    'absent, not zero — a refusal must never render as a $0.00 result',
  );
  assert.ok(ledger.claimability.blockers.includes('origin_integrity_failed'));
  assert.ok(ledger.integrity.evidence, 'the corrupted origin is kept for debugging');
  assert.equal(ledger.integrity.evidence.comparedBaselineCents, 99_999);
  // The shopper still gets their actual total; only the claim is withheld.
  assert.equal(ledger.actualCents, 748);
});

test('the integrity check is available on its own, before any money', () => {
  const { stores, products, list } = singleStoreMarket();
  const { trip } = start(list, stores, products);
  assert.equal(checkIntegrity(trip, NOW).ok, true);

  const tampered = JSON.parse(JSON.stringify(trip)) as ShoppingTrip;
  tampered.origin.basketCostCents = 1;
  const failed = checkIntegrity(tampered, NOW);
  assert.equal(failed.ok, false);
  assert.notEqual(failed.actualFingerprint, failed.expectedFingerprint);
  assert.equal(failed.expectedFingerprint, trip.origin.fingerprint);
});

test('every blocker has plain-language copy, so nothing fails silently', () => {
  const blockers = [
    'origin_integrity_failed',
    'baseline_not_comparable',
    'items_dropped',
    'receipt_missing',
    'matches_unconfirmed',
    'unverified_substitute',
  ] as const;
  for (const blocker of blockers) {
    assert.ok(describeBlocker(blocker).length > 0, `${blocker} needs a reason`);
  }
});

// ── Price, quantity, discounts ──────────────────────────────────────────────

test('a price change shows against the plan and lands in the actual total', () => {
  const { stores, products, list } = singleStoreMarket();
  const { trip, plan } = start(list, stores, products);
  const ledger = ledgerFor(trip, plan, [
    receipt('near', [
      line({ id: 'l1', productName: 'Whole Milk', chargedPriceCents: 429 }),
      line({ id: 'l2', productName: 'Large Eggs', chargedPriceCents: 399 }),
    ]),
  ]);

  assert.equal(ledger.actualCents, 828);
  const milk = ledger.lines.find((entry) => /Milk/.test(entry.productName));
  assert.ok(milk);
  assert.equal(milk.actualCents, 429);
  assert.equal(milk.differenceCents, 80);
  assert.equal(milk.state, 'receipt_verified');
});

test('an explicit discount reduces the actual total rather than a line price', () => {
  const { stores, products, list } = singleStoreMarket();
  const { trip, plan } = start(list, stores, products);
  const ledger = ledgerFor(trip, plan, [
    receipt('near', [
      line({ id: 'l1', productName: 'Whole Milk', chargedPriceCents: 349 }),
      line({ id: 'l2', productName: 'Large Eggs', chargedPriceCents: 399 }),
      line({ id: 'l3', productName: 'MEMBER SAVINGS', chargedPriceCents: -100, kind: 'discount' }),
    ]),
  ]);
  assert.equal(ledger.actualCents, 648, 'the discount is real money off the bill');
});

test('a quantity difference is visible as a difference, not absorbed', () => {
  const { stores, products, list } = singleStoreMarket();
  const { trip, plan } = start(list, stores, products);
  const ledger = ledgerFor(trip, plan, [
    receipt('near', [
      line({ id: 'l1', productName: 'Whole Milk', chargedPriceCents: 698, quantity: 2 }),
      line({ id: 'l2', productName: 'Large Eggs', chargedPriceCents: 399 }),
    ]),
  ]);
  const milk = ledger.lines.find((entry) => /Milk/.test(entry.productName));
  assert.ok(milk);
  assert.equal(milk.differenceCents, 349, 'a second pack is a real difference');
  assert.equal(ledger.actualCents, 1097);
});

// ── Unmatched, duplicated, partial, wrong retailer ──────────────────────────

test('an unmatched receipt line stays in the total but not attributed to an item', () => {
  const { stores, products, list } = singleStoreMarket();
  const { trip, plan } = start(list, stores, products);
  const ledger = ledgerFor(trip, plan, [
    receipt('near', [
      line({ id: 'l1', productName: 'Whole Milk', chargedPriceCents: 349 }),
      line({ id: 'l2', productName: 'Large Eggs', chargedPriceCents: 399 }),
      line({ id: 'l3', productName: 'Chewing Gum', chargedPriceCents: 129 }),
    ]),
  ]);
  assert.equal(ledger.actualCents, 877, 'the gum was still paid for');
  assert.equal(ledger.unattributedCents, 129, 'and is reported as unattributed');
});

test('a duplicated receipt line does not double-count against one planned item', () => {
  const { stores, products, list } = singleStoreMarket();
  const { trip, plan } = start(list, stores, products);
  const ledger = ledgerFor(trip, plan, [
    receipt('near', [
      line({ id: 'l1', productName: 'Whole Milk', chargedPriceCents: 349 }),
      line({ id: 'l1b', productName: 'Whole Milk', chargedPriceCents: 349 }),
      line({ id: 'l2', productName: 'Large Eggs', chargedPriceCents: 399 }),
    ]),
  ]);
  const milk = ledger.lines.filter((entry) => /Milk/.test(entry.productName));
  assert.equal(milk.length, 1, 'one planned line, whatever the receipt repeats');
  // Two identical lines are genuinely ambiguous — the engine asks rather than guesses.
  assert.ok(
    ledger.claimability.blockers.includes('matches_unconfirmed') ||
      milk[0]?.state === 'receipt_verified',
  );
  assert.equal(ledger.actualCents, 1097, 'both charges are still in the total');
});

test('a partial receipt withholds the claim and names the reason', () => {
  const stores = [store('near', 1), store('far', 3)];
  const products = [
    priced({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 349, title: 'Whole Milk' }),
    priced({ id: 'far-rice', concept: 'rice', storeId: 'far', price: 300, title: 'Rice' }),
    priced({ id: 'near-rice', concept: 'rice', storeId: 'near', price: 1500, title: 'Rice' }),
    priced({ id: 'far-milk', concept: 'milk', storeId: 'far', price: 900, title: 'Whole Milk' }),
  ];
  const list = basket([
    { concept: 'milk', displayName: 'Milk' },
    { concept: 'rice', displayName: 'Rice' },
  ]);
  const { trip, plan } = start(list, stores, products);
  assert.equal(trip.stops.length, 2, 'the fixture is a two-stop trip');

  // Only one stop's receipt was added.
  const ledger = ledgerFor(trip, plan, [
    receipt('near', [line({ id: 'l1', productName: 'Whole Milk', chargedPriceCents: 349 })]),
  ]);
  assert.equal(ledger.claimability.claimable, false);
  assert.ok(ledger.claimability.blockers.includes('receipt_missing'));
  assert.equal(ledger.claimability.state, 'pending', 'the shopper can still fix this');
  assert.equal(ledger.verifiedSavingsCents, undefined);
});

test('multi-store receipts reconcile per store and sum into one actual', () => {
  const stores = [store('near', 1), store('far', 3)];
  const products = [
    priced({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 349, title: 'Whole Milk' }),
    priced({ id: 'far-rice', concept: 'rice', storeId: 'far', price: 300, title: 'Rice' }),
    priced({ id: 'near-rice', concept: 'rice', storeId: 'near', price: 1500, title: 'Rice' }),
    priced({ id: 'far-milk', concept: 'milk', storeId: 'far', price: 900, title: 'Whole Milk' }),
  ];
  const list = basket([
    { concept: 'milk', displayName: 'Milk' },
    { concept: 'rice', displayName: 'Rice' },
  ]);
  const { trip, plan } = start(list, stores, products);

  const ledger = ledgerFor(trip, plan, [
    receipt('near', [line({ id: 'l1', productName: 'Whole Milk', chargedPriceCents: 349 })]),
    receipt('far', [line({ id: 'l2', productName: 'Rice', chargedPriceCents: 300 })]),
  ]);
  assert.equal(ledger.actualCents, 649);
  assert.equal(ledger.claimability.blockers.includes('receipt_missing'), false);
});

test('a receipt from the wrong retailer explains nothing and is not counted', () => {
  const { stores, products, list } = singleStoreMarket();
  const { trip, plan } = start(list, stores, products);
  // The trip stopped at `near`; this receipt is from a store not on the route. Its
  // lines explain nothing, and the stop is treated as having no receipt at all — which
  // falls back to the planned figure so the shopper still sees a provisional total,
  // while `receipt_missing` blocks any claim built on it.
  const ledger = ledgerFor(trip, plan, [
    receipt('elsewhere', [line({ id: 'l1', productName: 'Whole Milk', chargedPriceCents: 999 })]),
  ]);
  assert.ok(ledger.claimability.blockers.includes('receipt_missing'));
  assert.equal(ledger.verifiedSavingsCents, undefined, 'no claim from a receipt for another shop');
  assert.notEqual(ledger.actualCents, 999, 'the foreign line never entered the total');
  for (const entry of ledger.lines) {
    assert.notEqual(entry.state, 'receipt_verified', 'nothing was verified by it');
  }
});

// ── Manual substitutes ──────────────────────────────────────────────────────

test('a manual substitute is user_reported and blocks the claim until confirmed', () => {
  const { stores, products, list } = singleStoreMarket();
  const { trip, plan } = start(list, stores, products);

  const event: ShopEvent = {
    kind: 'substitute',
    groceryItemId: 'i1',
    manualSubstitute: { title: 'Shop-brand milk', priceCents: 289 },
  };
  const decision = adaptTrip({ trip, event, preferences: prefs, now: NOW });
  assert.ok(decision);
  const applied = applyAdaptation({
    trip,
    decision,
    chosenOptionId: 'manual_substitute',
    now: NOW,
  });
  assert.ok(applied);

  const ledger = ledgerFor(applied.trip, plan, [
    receipt('near', [line({ id: 'l2', productName: 'Large Eggs', chargedPriceCents: 399 })]),
  ]);

  const substitute = ledger.lines.find((entry) => entry.manualSubstitute);
  assert.ok(substitute, 'the hand-typed line is flagged');
  assert.equal(substitute.sourceType, 'user_reported');
  assert.notEqual(substitute.state, 'receipt_verified');
  assert.ok(ledger.claimability.blockers.includes('unverified_substitute'));
  assert.equal(ledger.verifiedSavingsCents, undefined, 'the shopper’s own figure is not proof');
});

test('a manual substitute becomes receipt-verified once a line matches it', () => {
  const { stores, products, list } = singleStoreMarket();
  const { trip, plan } = start(list, stores, products);
  const decision = adaptTrip({
    trip,
    event: {
      kind: 'substitute',
      groceryItemId: 'i1',
      manualSubstitute: { title: 'Shop-brand milk', priceCents: 289 },
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

  const ledger = ledgerFor(applied.trip, plan, [
    receipt('near', [
      line({ id: 'l1', productName: 'Shop-brand milk', chargedPriceCents: 289 }),
      line({ id: 'l2', productName: 'Large Eggs', chargedPriceCents: 399 }),
    ]),
  ]);

  const substitute = ledger.lines.find((entry) => entry.manualSubstitute);
  assert.ok(substitute);
  if (substitute.state === 'receipt_verified') {
    assert.equal(substitute.sourceType, 'receipt_verified', 'the receipt is now the source');
    assert.equal(
      ledger.claimability.blockers.includes('unverified_substitute'),
      false,
      'and it no longer blocks the claim',
    );
  } else {
    // If the description match was not confident enough, it must be surfaced for review
    // rather than quietly accepted.
    assert.equal(substitute.state, 'needs_review');
  }
});

// ── Late corrections ────────────────────────────────────────────────────────

test('a late correction adjusts the ledger without touching the adaptation log', () => {
  const { stores, products, list } = singleStoreMarket();
  const { trip, plan } = start(list, stores, products);
  const before = JSON.stringify(trip.adaptations);

  const corrections: ReconciliationCorrection[] = [
    {
      id: 'c1',
      at: NOW.toISOString(),
      tripItemId: 'i1',
      kind: 'price_differed',
      beforeCents: 349,
      actualCents: 429,
      note: 'noticed at the checkout',
    },
  ];
  const ledger = ledgerFor(
    trip,
    plan,
    [
      receipt('near', [
        line({ id: 'l1', productName: 'Whole Milk', chargedPriceCents: 429 }),
        line({ id: 'l2', productName: 'Large Eggs', chargedPriceCents: 399 }),
      ]),
    ],
    corrections,
  );

  assert.equal(ledger.finalExpectedCents, 828, 'the expected figure moved');
  assert.equal(ledger.corrections.length, 1);
  assert.equal(
    JSON.stringify(trip.adaptations),
    before,
    'the in-store history is append-only and untouched',
  );
});

test('a never-purchased correction removes the line from expected', () => {
  const { stores, products, list } = singleStoreMarket();
  const { trip, plan } = start(list, stores, products);
  const ledger = ledgerFor(
    trip,
    plan,
    [receipt('near', [line({ id: 'l2', productName: 'Large Eggs', chargedPriceCents: 399 })])],
    [
      {
        id: 'c1',
        at: NOW.toISOString(),
        tripItemId: 'i1',
        kind: 'never_purchased',
        beforeCents: 349,
      },
    ],
  );
  assert.equal(ledger.finalExpectedCents, 399, 'the unbought line contributes nothing');
  const milk = ledger.lines.find((entry) => entry.tripItemId === 'i1');
  assert.equal(milk?.expectedCents, 0);
});

test('every correction kind is representable and recorded', () => {
  const { stores, products, list } = singleStoreMarket();
  const { trip, plan } = start(list, stores, products);
  const corrections: ReconciliationCorrection[] = [
    {
      id: 'c1',
      at: NOW.toISOString(),
      tripItemId: 'i1',
      kind: 'price_differed',
      beforeCents: 349,
      actualCents: 400,
    },
    {
      id: 'c2',
      at: NOW.toISOString(),
      tripItemId: 'i2',
      kind: 'quantity_differed',
      beforeCents: 399,
      actualCents: 399,
      actualQuantity: 2,
    },
  ];
  const ledger = ledgerFor(trip, plan, [], corrections);
  assert.equal(ledger.corrections.length, 2);
  assert.equal(ledger.lines.find((entry) => entry.tripItemId === 'i2')?.expectedCents, 798);
});

// ── Zero, negative and dropped ──────────────────────────────────────────────

test('paying exactly the baseline is a zero saving, not a rounding artefact', () => {
  const stores = [store('near', 1)];
  const products = [
    priced({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 349, title: 'Whole Milk' }),
  ];
  const list = basket([{ concept: 'milk', displayName: 'Milk' }]);
  const { trip, plan } = start(list, stores, products);
  // One store, so the plan *is* the baseline and there is nothing to save.
  const ledger = ledgerFor(trip, plan, [
    receipt('near', [line({ id: 'l1', productName: 'Whole Milk', chargedPriceCents: 349 })]),
  ]);
  assert.equal(ledger.baselineCents, ledger.actualCents);
  assert.equal(ledger.claimability.state, 'verified');
  assert.equal(ledger.verifiedSavingsCents, 0, 'a real, checked answer of nothing saved');
});

test('paying more than the baseline is an overspend, never a negative saving', () => {
  const { stores, products, list } = singleStoreMarket();
  const { trip, plan } = start(list, stores, products);
  const ledger = ledgerFor(trip, plan, [
    receipt('near', [
      line({ id: 'l1', productName: 'Whole Milk', chargedPriceCents: 2000 }),
      line({ id: 'l2', productName: 'Large Eggs', chargedPriceCents: 2000 }),
    ]),
  ]);
  assert.ok(ledger.actualCents > ledger.baselineCents);
  assert.equal(ledger.claimability.state, 'verified', 'an overspend is still a verified result');
  assert.equal(ledger.verifiedSavingsCents, 0, 'floored at zero');
  assert.ok(ledger.differenceCents > 0, 'and the overspend is reported as a difference');
});

test('a dropped item makes the trip non-comparable and blocks the claim', () => {
  const { stores, products, list } = singleStoreMarket();
  const { trip, plan } = start(list, stores, products);
  const decision = adaptTrip({
    trip,
    event: { kind: 'unavailable', groceryItemId: 'i1' },
    preferences: prefs,
    now: NOW,
  });
  assert.ok(decision);
  const applied = applyAdaptation({ trip, decision, chosenOptionId: 'drop', now: NOW });
  assert.ok(applied);

  const ledger = ledgerFor(applied.trip, plan, [
    receipt('near', [line({ id: 'l2', productName: 'Large Eggs', chargedPriceCents: 399 })]),
  ]);
  assert.equal(ledger.verifiedSavingsCents, undefined);
  assert.equal(ledger.claimability.state, 'blocked', 'this basket will never be comparable');
  assert.ok(ledger.claimability.blockers.includes('items_dropped'));
  assert.ok(ledger.claimability.blockers.includes('baseline_not_comparable'));
});

// ── Baseline integrity and determinism ──────────────────────────────────────

test('the baseline in the ledger is always the frozen one', () => {
  const { stores, products, list } = singleStoreMarket();
  const { trip, plan } = start(list, stores, products);
  const adapted = (() => {
    const decision = adaptTrip({
      trip,
      event: { kind: 'different_price', groceryItemId: 'i1', observedPriceCents: 900 },
      preferences: prefs,
      now: NOW,
    });
    assert.ok(decision);
    const applied = applyAdaptation({ trip, decision, chosenOptionId: 'buy_here', now: NOW });
    assert.ok(applied);
    return applied.trip;
  })();

  const ledger = ledgerFor(adapted, plan, [
    receipt('near', [
      line({ id: 'l1', productName: 'Whole Milk', chargedPriceCents: 900 }),
      line({ id: 'l2', productName: 'Large Eggs', chargedPriceCents: 399 }),
    ]),
  ]);
  assert.equal(ledger.baselineCents, trip.origin.comparedBaselineCents);
  assert.equal(ledger.originalPlannedCents, trip.origin.basketCostCents);
  assert.equal(ledger.integrity.ok, true);
});

test('the ledger is deterministic and every figure is an integer', () => {
  const { stores, products, list } = singleStoreMarket();
  const { trip, plan } = start(list, stores, products);
  const receipts = [
    receipt('near', [
      line({ id: 'l1', productName: 'Whole Milk', chargedPriceCents: 349 }),
      line({ id: 'l2', productName: 'Large Eggs', chargedPriceCents: 399 }),
    ]),
  ];
  assert.equal(
    JSON.stringify(ledgerFor(trip, plan, receipts)),
    JSON.stringify(ledgerFor(trip, plan, receipts)),
  );

  const ledger = ledgerFor(trip, plan, receipts);
  for (const value of [
    ledger.baselineCents,
    ledger.originalPlannedCents,
    ledger.finalExpectedCents,
    ledger.actualCents,
    ledger.differenceCents,
    ledger.verifiedSavingsCents,
    ledger.estimatedSavingsCents,
  ]) {
    assert.ok(Number.isInteger(value), 'money is integer cents');
  }
});

test('a barcode on both sides outranks the description match', () => {
  // Feeds do not publish barcodes today, but the moment one does the hierarchy has to
  // put identity above words — the same rule the optimizer's matcher follows.
  const stores = [store('near', 1)];
  const products = [
    priced({
      id: 'near-milk',
      concept: 'milk',
      storeId: 'near',
      price: 349,
      title: 'Whole Milk',
      barcode: '019068100232',
    }),
  ];
  const list = basket([{ concept: 'milk', displayName: 'Milk' }]);
  const { trip, plan } = start(list, stores, products);

  const ledger = ledgerFor(trip, plan, [
    receipt('near', [
      // Words that would never match; the barcode settles it.
      line({
        id: 'l1',
        productName: 'LAIT ENTIER 3.78L',
        chargedPriceCents: 349,
        barcode: '0019068100232',
      }),
    ]),
  ]);
  const milk = ledger.lines[0];
  assert.ok(milk);
  assert.equal(milk.state, 'receipt_verified');
  assert.equal(milk.actualCents, 349);
});
