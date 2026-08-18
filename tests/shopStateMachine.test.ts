import assert from 'node:assert/strict';
import { test } from 'node:test';

import { demoPreferences } from '../src/domain/demoMarket';
import { optimizeBasket } from '../src/domain/optimizer';
import { adaptTrip, applyAdaptation, tripProgress, type ShopEvent } from '../src/domain/shopAdapt';
import { createTrip } from '../src/domain/trip';
import { originFingerprint, tripOriginIntact } from '../src/domain/tripOrigin';
import type {
  GroceryList,
  GroceryListItem,
  MarketSnapshot,
  Promotion,
  RetailerProduct,
  ShoppingTrip,
  Store,
  UserPreferences,
} from '../src/domain/types';

/**
 * The Shop Mode state machine, case by case.
 *
 * Every test here ends with the same assertion — the origin fingerprint is unchanged —
 * because the point of an adaptive trip is that the route may move freely while the
 * baseline does not. The rest of each test is about the specific transition: what the
 * line becomes, what it costs, and which promotions survive the change.
 */

const NOW = new Date('2026-08-18T10:00:00Z');

const prefs: UserPreferences = {
  ...demoPreferences,
  onboarded: true,
  maxStores: 3,
  radiusMiles: 25,
  loyaltyRetailers: [],
  couponIds: [],
  conveniencePreference: 0.5,
  timeValueCentsPerMinute: 25,
  extraStopPenaltyCents: 75,
};

function store(id: string, distanceMiles: number): Store {
  return {
    id,
    retailerId: id,
    retailerName: id.toUpperCase(),
    displayName: id,
    address: `${id} lane`,
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
  brand?: string;
  title?: string;
  size?: string;
  promotionId?: string;
}): RetailerProduct {
  return {
    id: spec.id,
    canonicalConcept: spec.concept,
    storeId: spec.storeId,
    title: spec.title ?? `${spec.concept} at ${spec.storeId}`,
    brand: spec.brand ?? 'Generic',
    sizeLabel: spec.size ?? '1 ct',
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
      ...(spec.promotionId === undefined ? {} : { promotionId: spec.promotionId }),
    },
  };
}

function basket(items: Partial<GroceryListItem>[]): GroceryList {
  return {
    id: 'list-1',
    title: 'Basket',
    prompt: 'basket',
    currency: 'USD',
    createdAt: NOW.toISOString(),
    items: items.map((item, index) => ({
      id: item.id ?? `i${index + 1}`,
      concept: item.concept ?? 'cereal',
      displayName: item.displayName ?? item.concept ?? 'Cereal',
      quantity: item.quantity ?? 1,
      unit: item.unit ?? '18 oz',
      ...(item.requestedBrand === undefined ? {} : { requestedBrand: item.requestedBrand }),
      ...(item.requestedVariant === undefined ? {} : { requestedVariant: item.requestedVariant }),
      ...(item.brandPolicy === undefined ? {} : { brandPolicy: item.brandPolicy }),
    })),
  };
}

function startTrip(
  list: GroceryList,
  stores: Store[],
  products: RetailerProduct[],
  promotions: Promotion[] = [],
): ShoppingTrip {
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
  return createTrip(plan, list, snapshot, NOW);
}

function decide(trip: ShoppingTrip, event: ShopEvent) {
  const decision = adaptTrip({ trip, event, preferences: prefs, now: NOW });
  assert.ok(decision, `a decision is expected for ${event.kind}`);
  return decision;
}

function apply(trip: ShoppingTrip, event: ShopEvent, chosenOptionId?: string): ShoppingTrip {
  const decision = decide(trip, event);
  const applied = applyAdaptation({
    trip,
    decision,
    chosenOptionId: chosenOptionId ?? decision.recommended.id,
    now: NOW,
  });
  assert.ok(applied, 'the adaptation must apply');
  return applied.trip;
}

/** The origin assertion every case shares. */
function assertOriginHeld(after: ShoppingTrip, before: ShoppingTrip, why: string): void {
  assert.equal(after.origin.fingerprint, before.origin.fingerprint, `${why}: hash moved`);
  assert.equal(originFingerprint(after.origin), before.origin.fingerprint, `${why}: fields moved`);
  assert.equal(tripOriginIntact(after), true, `${why}: origin not intact`);
}

function lineOf(trip: ShoppingTrip, groceryItemId: string) {
  return trip.stops
    .flatMap((stop) => stop.items)
    .find((item) => item.groceryItemId === groceryItemId);
}

/** One store, one cereal line, plus a same-brand and an off-brand alternative. */
function shelfMarket(promotionId?: string) {
  const stores = [store('near', 1)];
  const products = [
    priced({
      id: 'askew-flakes',
      concept: 'cereal',
      storeId: 'near',
      price: 500,
      brand: 'Askew',
      title: 'Askew Corn Flakes',
      ...(promotionId === undefined ? {} : { promotionId }),
    }),
    priced({
      id: 'askew-bran',
      concept: 'cereal',
      storeId: 'near',
      price: 460,
      brand: 'Askew',
      title: 'Askew Bran Squares',
    }),
    priced({
      id: 'value-flakes',
      concept: 'cereal',
      storeId: 'near',
      price: 380,
      brand: 'Value',
      title: 'Value Corn Flakes',
    }),
  ];
  return { stores, products };
}

/**
 * One store, one product, no alternatives.
 *
 * The quantity and package cases are about arithmetic on a known line, so a shelf with
 * competing products would only make the assertions depend on which one got planned.
 */
function simpleMarket(promotionId?: string) {
  const stores = [store('near', 1)];
  const products = [
    priced({
      id: 'flakes',
      concept: 'cereal',
      storeId: 'near',
      price: 500,
      brand: 'Askew',
      title: 'Askew Corn Flakes',
      size: '18 oz',
      ...(promotionId === undefined ? {} : { promotionId }),
    }),
  ];
  return { stores, products };
}

// ── Substitutes ─────────────────────────────────────────────────────────────

test('substitute accepted replaces the product and records it as a substitution', () => {
  const { stores, products } = shelfMarket();
  const list = basket([
    {
      concept: 'cereal',
      requestedBrand: 'Askew',
      brandPolicy: 'flexible',
      displayName: 'Corn Flakes',
    },
  ]);
  const trip = startTrip(list, stores, products);
  const decision = decide(trip, { kind: 'substitute', groceryItemId: 'i1' });

  const option = decision.options.find((entry) => entry.kind === 'change_substitute');
  assert.ok(option, 'alternatives on the same shelf are offered');
  const after = apply(trip, { kind: 'substitute', groceryItemId: 'i1' }, option.id);

  const line = lineOf(after, 'i1');
  assert.equal(line?.status, 'substituted');
  assert.equal(line?.substituteProductId, option.retailerProductId);
  assert.equal(line?.lineTotalCents, option.lineTotalCents);
  assertOriginHeld(after, trip, 'substitute accepted');
});

test('substitute rejected leaves the planned product in place and logs the override', () => {
  const { stores, products } = shelfMarket();
  const list = basket([
    {
      concept: 'cereal',
      requestedBrand: 'Askew',
      brandPolicy: 'flexible',
      displayName: 'Corn Flakes',
    },
  ]);
  const trip = startTrip(list, stores, products);
  const decision = decide(trip, { kind: 'substitute', groceryItemId: 'i1' });
  const applied = applyAdaptation({ trip, decision, chosenOptionId: 'buy_here', now: NOW });
  assert.ok(applied);

  const planned = lineOf(trip, 'i1')?.retailerProductId;
  const line = lineOf(applied.trip, 'i1');
  assert.equal(line?.retailerProductId, planned, 'the planned product stands');
  assert.equal(line?.substituteProductId, undefined);

  const record = applied.trip.adaptations[0];
  assert.ok(record);
  assert.equal(record.chosenOptionId, 'buy_here');
  if (record.recommendedOptionId !== 'buy_here') {
    assert.equal(record.overrodeRecommendation, true, 'the override is recorded, not absorbed');
  }
  assertOriginHeld(applied.trip, trip, 'substitute rejected');
});

test('exact_product blocks every substitute, same brand or not', () => {
  const { stores, products } = shelfMarket();
  const list = basket([
    {
      concept: 'cereal',
      requestedBrand: 'Askew',
      requestedVariant: 'corn flakes',
      brandPolicy: 'exact_product',
      displayName: 'Askew Corn Flakes',
    },
  ]);
  const trip = startTrip(list, stores, products);
  const decision = decide(trip, { kind: 'substitute', groceryItemId: 'i1' });

  for (const option of decision.options) {
    assert.notEqual(option.retailerProductId, 'askew-bran', 'same brand, different product');
    assert.notEqual(option.retailerProductId, 'value-flakes', 'different brand');
  }
  assert.equal(
    decision.options.some((option) => option.kind === 'change_substitute'),
    false,
    'exact_product has no legal substitute',
  );
});

test('exact_brand allows a same-brand variant but no other brand', () => {
  const { stores, products } = shelfMarket();
  const list = basket([
    {
      concept: 'cereal',
      requestedBrand: 'Askew',
      brandPolicy: 'exact_brand',
      displayName: 'Askew Cereal',
    },
  ]);
  const trip = startTrip(list, stores, products);
  const decision = decide(trip, { kind: 'substitute', groceryItemId: 'i1' });

  const ids = decision.options.map((option) => option.retailerProductId);
  assert.ok(ids.includes('askew-bran'), 'a compatible same-brand product is offered');
  assert.equal(ids.includes('value-flakes'), false, 'another brand is not');
});

test('a manual substitute is priced from the shopper and marked unverified', () => {
  // Juva has no observation for this product, so the figure is the shopper's. The flag
  // travels with the line so reconciliation can tell the difference at the receipt.
  const { stores, products } = shelfMarket();
  const list = basket([{ concept: 'cereal', displayName: 'Corn Flakes' }]);
  const trip = startTrip(list, stores, products);

  const event: ShopEvent = {
    kind: 'substitute',
    groceryItemId: 'i1',
    manualSubstitute: { title: 'Shop-brand flakes 20 oz', priceCents: 275 },
  };
  const decision = decide(trip, event);
  const manual = decision.options.find((option) => option.id === 'manual_substitute');
  assert.ok(manual, 'the typed substitute is offered as an option');
  assert.equal(manual.manualEntry, true);
  assert.equal(manual.retailerProductId, null, 'there is no retailer product behind it');
  assert.deepEqual(manual.promotionImpacts, [], 'and no promotion may be promised on it');

  const after = apply(trip, event, 'manual_substitute');
  const line = lineOf(after, 'i1');
  assert.equal(line?.status, 'substituted');
  assert.equal(line?.substituteUnverified, true);
  assert.equal(line?.substituteTitle, 'Shop-brand flakes 20 oz');
  assert.equal(line?.lineTotalCents, 275);
  assertOriginHeld(after, trip, 'manual substitute');
});

// ── Quantity ────────────────────────────────────────────────────────────────

test('quantity increased multiplies the line through the pack maths', () => {
  const { stores, products } = simpleMarket();
  const list = basket([{ concept: 'cereal', quantity: 1, unit: '18 oz' }]);
  const trip = startTrip(list, stores, products);
  const before = lineOf(trip, 'i1')?.lineTotalCents;
  assert.equal(before, 500);

  const after = apply(trip, { kind: 'quantity_changed', groceryItemId: 'i1', observedQuantity: 3 });
  const line = lineOf(after, 'i1');
  assert.equal(line?.status, 'quantity_changed');
  assert.equal(line?.actualQuantity, 3);
  assert.equal(line?.lineTotalCents, 1500);
  assertOriginHeld(after, trip, 'quantity increased');
});

test('quantity decreased shrinks the line and the store subtotal', () => {
  const { stores, products } = simpleMarket();
  const list = basket([{ concept: 'cereal', quantity: 4, unit: '18 oz' }]);
  const trip = startTrip(list, stores, products);
  assert.equal(lineOf(trip, 'i1')?.lineTotalCents, 2000);

  const after = apply(trip, { kind: 'quantity_changed', groceryItemId: 'i1', observedQuantity: 1 });
  assert.equal(lineOf(after, 'i1')?.lineTotalCents, 500);
  assert.equal(after.stops[0]?.expectedSubtotalCents, 500, 'the stop total follows');
  assertOriginHeld(after, trip, 'quantity decreased');
});

test('a multibuy becomes eligible once the quantity reaches its threshold', () => {
  // Planned at one pack, so "2 for $7" did not apply. Taking a second makes it apply,
  // and the replan has to notice — this is the promotion re-evaluation contract.
  const promotions: Promotion[] = [
    {
      id: 'two-for',
      retailerId: 'near',
      label: '2 for $7',
      requiredQuantity: 2,
      overridePriceCents: 350,
    },
  ];
  const { stores, products } = simpleMarket('two-for');
  const list = basket([{ concept: 'cereal', quantity: 1, unit: '18 oz' }]);
  const trip = startTrip(list, stores, products, promotions);
  assert.equal(lineOf(trip, 'i1')?.lineTotalCents, 500, 'one pack, shelf price');

  const decision = decide(trip, {
    kind: 'quantity_changed',
    groceryItemId: 'i1',
    observedQuantity: 2,
  });
  const buyHere = decision.options.find((option) => option.id === 'buy_here');
  assert.ok(buyHere);
  assert.equal(buyHere.lineTotalCents, 700, 'two at the offer price, not 2 × $5.00');

  const after = apply(trip, { kind: 'quantity_changed', groceryItemId: 'i1', observedQuantity: 2 });
  assert.equal(lineOf(after, 'i1')?.lineTotalCents, 700);
  assertOriginHeld(after, trip, 'multibuy became eligible');
});

test('a multibuy becomes ineligible when the quantity drops below its threshold', () => {
  const promotions: Promotion[] = [
    {
      id: 'two-for',
      retailerId: 'near',
      label: '2 for $7',
      requiredQuantity: 2,
      overridePriceCents: 350,
    },
  ];
  const { stores, products } = simpleMarket('two-for');
  const list = basket([{ concept: 'cereal', quantity: 2, unit: '18 oz' }]);
  const trip = startTrip(list, stores, products, promotions);
  assert.equal(lineOf(trip, 'i1')?.lineTotalCents, 700, 'planned with the offer applied');

  const decision = decide(trip, {
    kind: 'quantity_changed',
    groceryItemId: 'i1',
    observedQuantity: 1,
  });
  const buyHere = decision.options.find((option) => option.id === 'buy_here');
  assert.ok(buyHere);
  assert.equal(buyHere.lineTotalCents, 500, 'one pack loses the offer and pays shelf price');

  const after = apply(trip, { kind: 'quantity_changed', groceryItemId: 'i1', observedQuantity: 1 });
  assert.equal(lineOf(after, 'i1')?.lineTotalCents, 500);
  assertOriginHeld(after, trip, 'multibuy became ineligible');
});

test('a quantity change re-resolves a minimum-spend offer at the same store', () => {
  const promotions: Promotion[] = [
    {
      id: 'spend10',
      retailerId: 'near',
      label: '$1 off when you spend $10',
      amountOffCents: 100,
      minimumBasketSpendCents: 1000,
    },
  ];
  const { stores, products } = simpleMarket('spend10');
  const list = basket([{ concept: 'cereal', quantity: 1, unit: '18 oz' }]);
  const trip = startTrip(list, stores, products, promotions);
  assert.equal(lineOf(trip, 'i1')?.lineTotalCents, 500, 'one pack is under the threshold');

  const decision = decide(trip, {
    kind: 'quantity_changed',
    groceryItemId: 'i1',
    observedQuantity: 3,
  });
  const buyHere = decision.options.find((option) => option.id === 'buy_here');
  assert.ok(buyHere);
  // Three packs is $15, over the $10 threshold, so the dollar comes off.
  assert.equal(buyHere.lineTotalCents, 1200, '3 × $5.00 less the $1.00 that now applies');
});

// ── Package and size ────────────────────────────────────────────────────────

test('a package change re-prices the line at the shelf price for that pack', () => {
  const { stores, products } = simpleMarket();
  const list = basket([{ concept: 'cereal', quantity: 1, unit: '18 oz' }]);
  const trip = startTrip(list, stores, products);

  const after = apply(
    trip,
    {
      kind: 'different_package',
      groceryItemId: 'i1',
      observedPriceCents: 780,
      observedSizeLabel: '36 oz',
    },
    'buy_here',
  );
  const line = lineOf(after, 'i1');
  assert.equal(line?.status, 'different_package');
  assert.equal(line?.actualSizeLabel, '36 oz');
  assert.equal(line?.actualPriceCents, 780);
  assert.equal(line?.unitsNormalized, undefined, 'oz against oz normalizes cleanly');
  assertOriginHeld(after, trip, 'package change');
});

test('a package change alters unit economics, and the comparison follows the shelf', () => {
  // 36 oz at $7.80 is 21.7c/oz against 18 oz at $5.00, which is 27.8c/oz. The bigger
  // pack is dearer per line and cheaper per ounce, and both figures have to be right.
  const { stores, products } = simpleMarket();
  const list = basket([{ concept: 'cereal', quantity: 1, unit: '18 oz' }]);
  const trip = startTrip(list, stores, products);
  const plannedLine = lineOf(trip, 'i1');
  assert.ok(plannedLine);

  const decision = decide(trip, {
    kind: 'different_package',
    groceryItemId: 'i1',
    observedPriceCents: 780,
    observedSizeLabel: '36 oz',
  });
  const buyHere = decision.options.find((option) => option.id === 'buy_here');
  assert.ok(buyHere);
  assert.ok(buyHere.lineTotalCents > plannedLine.lineTotalCents, 'the line costs more');
  assert.equal(buyHere.unitsNormalized, true, 'and the units did normalize');
});

test('a package Juva cannot normalize is recorded, not equated', () => {
  // "Family size" has no conversion to ounces. Juva keeps both labels and refuses to
  // claim they are equivalent rather than inventing a ratio.
  const { stores, products } = simpleMarket();
  const list = basket([{ concept: 'cereal', quantity: 1, unit: '18 oz' }]);
  const trip = startTrip(list, stores, products);

  const event: ShopEvent = {
    kind: 'different_package',
    groceryItemId: 'i1',
    observedPriceCents: 640,
    observedSizeLabel: 'family size',
  };
  const decision = decide(trip, event);
  const buyHere = decision.options.find((option) => option.id === 'buy_here');
  assert.ok(buyHere);
  assert.equal(buyHere.unitsNormalized, false, 'no honest conversion exists');

  const after = apply(trip, event, 'buy_here');
  const line = lineOf(after, 'i1');
  assert.equal(line?.unitsNormalized, false, 'and the line says so');
  assert.equal(line?.actualSizeLabel, 'family size', 'both labels are kept');
  assert.equal(line?.sizeLabel, '18 oz');
  assertOriginHeld(after, trip, 'unnormalizable package');
});

// ── Dropping and comparability ──────────────────────────────────────────────

test('a dropped item makes the trip non-comparable and claims nothing', () => {
  const stores = [store('near', 1)];
  const products = [
    priced({ id: 'near-cereal', concept: 'cereal', storeId: 'near', price: 500 }),
    priced({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 300 }),
  ];
  const list = basket([{ concept: 'cereal' }, { concept: 'milk', unit: '1 gal' }]);
  const trip = startTrip(list, stores, products);

  const after = apply(trip, { kind: 'unavailable', groceryItemId: 'i1' }, 'drop');
  const progress = tripProgress(after);
  assert.equal(progress.droppedItemCount, 1);
  assert.equal(progress.comparisonEligible, false);
  assert.equal(progress.estimatedSavingsCents, 0, 'a thinner basket is not a saving');
  assert.equal(progress.baselineCents, trip.origin.comparedBaselineCents, 'baseline unmoved');
  assertOriginHeld(after, trip, 'dropped item');
});

test('dropping never produces a savings result through its own arithmetic', () => {
  const stores = [store('near', 1)];
  const products = [
    priced({ id: 'near-cereal', concept: 'cereal', storeId: 'near', price: 5000 }),
    priced({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 300 }),
  ];
  const list = basket([{ concept: 'cereal' }, { concept: 'milk', unit: '1 gal' }]);
  const trip = startTrip(list, stores, products);

  // A $50 line leaving the basket is a huge arithmetic "saving". It must yield none.
  const after = apply(trip, { kind: 'unavailable', groceryItemId: 'i1' }, 'drop');
  const progress = tripProgress(after);
  assert.equal(progress.estimatedSavingsCents, 0);
  assert.ok(progress.expectedTotalCents < progress.originalTotalCents, 'the total did fall');
  assert.equal(progress.comparisonEligible, false, 'and the fall is not comparable');
});

// ── Persistence of the whole machine ────────────────────────────────────────

test('a full reload preserves every adaptation and its schema', () => {
  const { stores, products } = simpleMarket();
  const list = basket([{ concept: 'cereal', quantity: 1, unit: '18 oz' }]);
  let trip = startTrip(list, stores, products);

  trip = apply(trip, { kind: 'different_price', groceryItemId: 'i1', observedPriceCents: 560 });
  trip = apply(trip, { kind: 'quantity_changed', groceryItemId: 'i1', observedQuantity: 2 });
  const reloaded = JSON.parse(JSON.stringify(trip)) as ShoppingTrip;

  assert.equal(reloaded.adaptations.length, 2);
  for (const adaptation of reloaded.adaptations) {
    assert.equal(adaptation.usedCachedMarket, true);
    assert.equal(adaptation.networkRequired, false);
    assert.ok(adaptation.options.length > 0, 'the options weighed are kept');
    assert.ok(adaptation.recommendedOptionId.length > 0);
    assert.ok(adaptation.chosenOptionId.length > 0);
  }
  assert.equal(tripOriginIntact(reloaded), true);
  assert.equal(reloaded.origin.fingerprint, trip.origin.fingerprint);
});

test('a reloaded trip keeps adapting, and the log keeps growing in order', () => {
  const { stores, products } = simpleMarket();
  const list = basket([{ concept: 'cereal', quantity: 1, unit: '18 oz' }]);
  const trip = startTrip(list, stores, products);
  const first = apply(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 560,
  });

  const reloaded = JSON.parse(JSON.stringify(first)) as ShoppingTrip;
  const second = apply(reloaded, {
    kind: 'quantity_changed',
    groceryItemId: 'i1',
    observedQuantity: 2,
  });

  assert.equal(second.adaptations.length, 2);
  assert.ok(
    Date.parse(second.adaptations[0]?.at ?? '') <= Date.parse(second.adaptations[1]?.at ?? ''),
    'in order',
  );
  assertOriginHeld(second, trip, 'reload and continue');
});
