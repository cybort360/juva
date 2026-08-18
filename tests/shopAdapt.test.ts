import assert from 'node:assert/strict';
import { test } from 'node:test';

import { demoPreferences } from '../src/domain/demoMarket';
import { optimizeBasket } from '../src/domain/optimizer';
import {
  ADAPT_SWITCH_MARGIN_CENTS,
  adaptTrip,
  applyAdaptation,
  tripProgress,
  type ShopEvent,
} from '../src/domain/shopAdapt';
import { createTrip } from '../src/domain/trip';
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
 * Adaptive Shop Mode.
 *
 * The loop under test is PLAN → SHOP → OBSERVE CHANGE → REPLAN → CONTINUE, and the
 * property that matters most is the one in the completion gate: a change inside the
 * store can alter the recommendation *without corrupting the original plan or the
 * savings baseline*. Several tests below do nothing but assert that `trip.origin` came
 * out the far side untouched.
 *
 * Everything here runs with no network by construction — `adaptTrip` reads only
 * `trip.market`, which is cached on the trip itself.
 */

const NOW = new Date('2026-08-17T10:00:00Z');

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
  missingItemPenaltyCents: 400,
};

function store(id: string, distanceMiles: number): Store {
  return {
    id,
    retailerId: id,
    retailerName: id.toUpperCase(),
    displayName: id,
    address: `${id} street`,
    distanceMiles,
    etaMinutes: Math.round(distanceMiles * 4),
    colorToken: 'forest',
  };
}

interface Spec {
  id: string;
  concept: string;
  storeId: string;
  price: number;
  brand?: string;
  title?: string;
  size?: string;
  promotionId?: string;
  available?: boolean;
}

function priced(spec: Spec): RetailerProduct {
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
      available: spec.available ?? true,
      availability: 'in_stock',
      ...(spec.promotionId === undefined ? {} : { promotionId: spec.promotionId }),
    },
  };
}

function basket(items: Partial<GroceryListItem>[]): GroceryList {
  return {
    id: 'list-1',
    title: 'Weekly basket',
    prompt: 'weekly',
    currency: 'USD',
    createdAt: NOW.toISOString(),
    items: items.map((item, index) => ({
      id: item.id ?? `i${index + 1}`,
      concept: item.concept ?? 'milk',
      displayName: item.displayName ?? item.concept ?? 'Milk',
      quantity: item.quantity ?? 1,
      unit: item.unit ?? '1 ct',
      ...(item.requestedBrand === undefined ? {} : { requestedBrand: item.requestedBrand }),
      ...(item.brandPolicy === undefined ? {} : { brandPolicy: item.brandPolicy }),
    })),
  };
}

function snapshotOf(
  stores: Store[],
  products: RetailerProduct[],
  promotions: Promotion[] = [],
): MarketSnapshot {
  return { mode: 'demo', fetchedAt: NOW.toISOString(), stores, products, promotions };
}

/**
 * Plans a basket and starts the trip, exactly as the app does.
 *
 * Using the real optimizer rather than a hand-built trip matters: it means these tests
 * exercise the same plan shape, the same promotion evaluation and the same frozen
 * origin that a shopper would actually carry into a store.
 */
function startTrip(
  list: GroceryList,
  stores: Store[],
  products: RetailerProduct[],
  promotions: Promotion[] = [],
  overrides: Partial<UserPreferences> = {},
): ShoppingTrip {
  const preferences = { ...prefs, ...overrides };
  const plans = optimizeBasket({ list, stores, products, promotions, preferences, now: NOW });
  const plan = plans.find((entry) => entry.kind === 'recommended') ?? plans[0];
  assert.ok(plan, 'the fixture must produce a plan');
  return createTrip(plan, list, snapshotOf(stores, products, promotions), NOW);
}

function decide(trip: ShoppingTrip, event: ShopEvent, overrides: Partial<UserPreferences> = {}) {
  const decision = adaptTrip({
    trip,
    event,
    preferences: { ...prefs, ...overrides },
    now: NOW,
  });
  assert.ok(decision, 'an adaptation decision is expected');
  return decision;
}

/**
 * Two stores, three lines. `near` is 1 mile out, `far` is 7. Both stock everything, so
 * the replanner always has somewhere to move a line to.
 */
function twoStoreMarket() {
  const stores = [store('near', 1), store('far', 7)];
  const products = [
    priced({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 349 }),
    priced({ id: 'near-eggs', concept: 'eggs', storeId: 'near', price: 399 }),
    priced({ id: 'near-bread', concept: 'bread', storeId: 'near', price: 279 }),
    priced({ id: 'far-milk', concept: 'milk', storeId: 'far', price: 259 }),
    priced({ id: 'far-eggs', concept: 'eggs', storeId: 'far', price: 999 }),
    priced({ id: 'far-bread', concept: 'bread', storeId: 'far', price: 999 }),
  ];
  const list = basket([{ concept: 'milk' }, { concept: 'eggs' }, { concept: 'bread' }]);
  return { stores, products, list };
}

// ── 1. Price change ─────────────────────────────────────────────────────────

test('a price change is recorded as a live observation and re-prices the line', () => {
  const { stores, products, list } = twoStoreMarket();
  const trip = startTrip(list, stores, products, [], { maxStores: 1 });
  const decision = decide(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 429,
  });

  assert.equal(decision.headline, 'PRICE CHANGED');
  const buyHere = decision.options.find((option) => option.id === 'buy_here');
  assert.ok(buyHere);
  assert.equal(buyHere.lineTotalCents, 429, 'the shelf price, not the planned one');
  assert.equal(buyHere.basketDeltaCents, 80, '$4.29 against the planned $3.49');
  assert.match(decision.detail, /\$0\.80 higher/);
});

test('a small price rise does not move the shopper', () => {
  // The requirement in one test: an 80c rise on one line must not reroute a trip.
  const { stores, products, list } = twoStoreMarket();
  const trip = startTrip(list, stores, products, [], { maxStores: 1 });
  const decision = decide(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 429,
  });

  assert.equal(decision.recommended.kind, 'buy_here');
  assert.equal(decision.recommendation, 'Buy here.');
});

test('a price fall is reported as a fall, not silently accepted', () => {
  const { stores, products, list } = twoStoreMarket();
  const trip = startTrip(list, stores, products, [], { maxStores: 1 });
  const decision = decide(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 299,
  });
  assert.match(decision.detail, /\$0\.50 lower/);
  assert.equal(decision.recommended.kind, 'buy_here');
});

test('a price change never touches the frozen origin', () => {
  const { stores, products, list } = twoStoreMarket();
  const trip = startTrip(list, stores, products, [], { maxStores: 1 });
  const before = JSON.stringify(trip.origin);

  const decision = decide(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 1299,
  });
  const applied = applyAdaptation({
    trip,
    decision,
    chosenOptionId: decision.recommended.id,
    now: NOW,
  });
  assert.ok(applied);
  assert.equal(JSON.stringify(applied.trip.origin), before, 'the baseline cannot move');
  assert.equal(JSON.stringify(trip.origin), before, 'and the input trip is not mutated');
});

// ── 2. Unavailable item ─────────────────────────────────────────────────────

test('an unavailable item is never offered as buyable here', () => {
  const { stores, products, list } = twoStoreMarket();
  const trip = startTrip(list, stores, products, [], { maxStores: 1 });
  const decision = decide(trip, { kind: 'unavailable', groceryItemId: 'i1' });

  assert.equal(decision.headline, 'NOT ON THE SHELF');
  assert.equal(
    decision.options.some((option) => option.id === 'buy_here'),
    false,
    'the shelf is empty, so buying it here is not an option Juva may offer',
  );
});

test('an unavailable item offers alternatives at the same store and further out', () => {
  // Requirement 8's shape: alternative A at the same store, alternative B at the next.
  const stores = [store('near', 1), store('far', 3)];
  const products = [
    priced({ id: 'near-cereal', concept: 'cereal', storeId: 'near', price: 400, brand: 'A' }),
    priced({ id: 'near-cereal-b', concept: 'cereal', storeId: 'near', price: 420, brand: 'B' }),
    priced({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 300 }),
    priced({ id: 'far-cereal', concept: 'cereal', storeId: 'far', price: 360, brand: 'C' }),
    priced({ id: 'far-milk', concept: 'milk', storeId: 'far', price: 900 }),
  ];
  const list = basket([{ concept: 'cereal' }, { concept: 'milk' }]);
  const trip = startTrip(list, stores, products, [], { maxStores: 1 });
  const decision = decide(trip, { kind: 'unavailable', groceryItemId: 'i1' });

  const sameStore = decision.options.find((option) => option.kind === 'change_substitute');
  assert.ok(sameStore, 'an alternative on the same shelf');
  assert.equal(sameStore.extraMinutes, 0);

  const elsewhere = decision.options.find(
    (option) => option.kind === 'add_stop' || option.kind === 'buy_at_existing_stop',
  );
  assert.ok(elsewhere, 'an alternative at another store');
  assert.ok(elsewhere.storeId !== 'near');
});

test('doing without an item is always offered but never recommended on price', () => {
  // A basket missing a line is cheaper for the wrong reason. It must be reachable —
  // sometimes there is genuinely nothing — but Juva may never advise it to save money.
  const { stores, products, list } = twoStoreMarket();
  const trip = startTrip(list, stores, products, [], { maxStores: 1 });
  const decision = decide(trip, { kind: 'unavailable', groceryItemId: 'i1' });

  const drop = decision.options.find((option) => option.id === 'drop');
  assert.ok(drop, 'the shopper can always choose to do without');
  assert.ok(drop.basketDeltaCents < 0, 'it is arithmetically cheaper');
  assert.notEqual(decision.recommended.id, 'drop', 'and is still not the recommendation');
});

test('dropping an item makes the trip uncomparable rather than more profitable', () => {
  const { stores, products, list } = twoStoreMarket();
  const trip = startTrip(list, stores, products, [], { maxStores: 1 });
  const decision = decide(trip, { kind: 'unavailable', groceryItemId: 'i1' });
  const applied = applyAdaptation({ trip, decision, chosenOptionId: 'drop', now: NOW });
  assert.ok(applied);

  const progress = tripProgress(applied.trip);
  assert.equal(progress.droppedItemCount, 1);
  assert.equal(progress.comparisonEligible, false);
  assert.equal(progress.estimatedSavingsCents, 0, 'a thinner basket is not a saving');
  assert.equal(progress.baselineCents, trip.origin.comparedBaselineCents, 'baseline unmoved');
});

// ── 3 & 4. Accepted and rejected substitutes ────────────────────────────────

test('an accepted substitute replaces the product and records the substitution', () => {
  const stores = [store('near', 1)];
  const products = [
    priced({ id: 'near-a', concept: 'cereal', storeId: 'near', price: 500, brand: 'Askew' }),
    priced({ id: 'near-b', concept: 'cereal', storeId: 'near', price: 380, brand: 'Value' }),
  ];
  const list = basket([{ concept: 'cereal', requestedBrand: 'Askew', brandPolicy: 'flexible' }]);
  const trip = startTrip(list, stores, products, [], { maxStores: 1 });
  const decision = decide(trip, { kind: 'unavailable', groceryItemId: 'i1' });

  const substitute = decision.options.find((option) => option.kind === 'change_substitute');
  assert.ok(substitute);
  const applied = applyAdaptation({ trip, decision, chosenOptionId: substitute.id, now: NOW });
  assert.ok(applied);

  const line = applied.trip.stops[0]?.items[0];
  assert.ok(line);
  assert.equal(line.status, 'substituted');
  assert.equal(line.retailerProductId, substitute.retailerProductId);
  assert.equal(line.substituteProductId, substitute.retailerProductId);
  assert.equal(line.lineTotalCents, substitute.lineTotalCents);
});

test('a rejected substitute leaves the plan alone and is still recorded', () => {
  // The shopper says no. Juva records that it recommended otherwise and moves on —
  // requirement 9's audit trail, which exists so an override is visible rather than
  // silently absorbed.
  const stores = [store('near', 1)];
  const products = [
    priced({ id: 'near-a', concept: 'cereal', storeId: 'near', price: 500, brand: 'Askew' }),
    priced({ id: 'near-b', concept: 'cereal', storeId: 'near', price: 380, brand: 'Value' }),
  ];
  const list = basket([{ concept: 'cereal', requestedBrand: 'Askew', brandPolicy: 'flexible' }]);
  const trip = startTrip(list, stores, products, [], { maxStores: 1 });
  const decision = decide(trip, { kind: 'unavailable', groceryItemId: 'i1' });

  const applied = applyAdaptation({ trip, decision, chosenOptionId: 'drop', now: NOW });
  assert.ok(applied);
  const record = applied.adaptation;

  assert.equal(record.chosenOptionId, 'drop');
  assert.notEqual(record.recommendedOptionId, 'drop');
  assert.equal(record.overrodeRecommendation, true);
  assert.equal(record.after, null, 'the line left the basket');
  assert.ok(record.options.length > 1, 'every option Juva weighed is kept');
});

test('a substitute may never break the line brand policy', () => {
  // `exact_product` in the aisle is still `exact_product`. Shop Mode has no looser path
  // to a substitute than the optimizer does.
  const stores = [store('near', 1)];
  const products = [
    priced({
      id: 'near-a',
      concept: 'cereal',
      storeId: 'near',
      price: 500,
      brand: 'Askew',
      title: 'Askew Corn Flakes',
    }),
    priced({ id: 'near-b', concept: 'cereal', storeId: 'near', price: 380, brand: 'Value' }),
  ];
  const list = basket([
    {
      concept: 'cereal',
      requestedBrand: 'Askew',
      brandPolicy: 'exact_product',
      displayName: 'Askew Corn Flakes',
    },
  ]);
  const trip = startTrip(list, stores, products, [], { maxStores: 1 });
  const decision = decide(trip, { kind: 'unavailable', groceryItemId: 'i1' });

  for (const option of decision.options) {
    assert.notEqual(
      option.retailerProductId,
      'near-b',
      'an off-brand product is not a legal substitute for an exact_product line',
    );
  }
});

// ── 5. Offline update ───────────────────────────────────────────────────────

test('the trip carries everything a replan needs, so it works with no network', () => {
  const { stores, products, list } = twoStoreMarket();
  const trip = startTrip(list, stores, products);

  assert.ok(trip.market.stores.length > 0, 'stores cached');
  assert.ok(trip.market.products.length > 0, 'products and their expected prices cached');
  assert.equal(trip.market.list.items.length, 3, 'the basket and its rules cached');
  assert.equal(trip.market.mode, 'demo', 'and the data mode travels with it');
  for (const stop of trip.stops) {
    assert.ok(stop.expectedSubtotalCents > 0, 'expected subtotals cached');
    for (const item of stop.items) {
      assert.ok(item.source.length > 0, 'provenance cached');
      assert.ok(item.freshness.length > 0);
      assert.ok(!Number.isNaN(Date.parse(item.observedAt)));
      assert.equal(item.status, 'pending', 'checklist state cached');
    }
  }
});

test('an offline adaptation is decided from the cache alone and says so', () => {
  const { stores, products, list } = twoStoreMarket();
  const trip = startTrip(list, stores, products);

  // Nothing but the trip is passed in — no snapshot, no network, no market argument.
  const decision = decide(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 500,
  });
  const applied = applyAdaptation({
    trip,
    decision,
    chosenOptionId: decision.recommended.id,
    now: NOW,
  });
  assert.ok(applied);
  assert.equal(applied.adaptation.usedCachedMarket, true);
  assert.equal(applied.adaptation.networkRequired, false);
  assert.equal(applied.trip.adaptations.length, 1);
});

test('offline decisions survive a serialization round trip', () => {
  // The trip is persisted as JSON, so a relaunch at the checkout must find a trip that
  // still replans identically.
  const { stores, products, list } = twoStoreMarket();
  const trip = startTrip(list, stores, products);
  const rehydrated = JSON.parse(JSON.stringify(trip)) as ShoppingTrip;

  const event: ShopEvent = {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 700,
  };
  assert.equal(
    JSON.stringify(decide(rehydrated, event)),
    JSON.stringify(decide(trip, event)),
    'a rehydrated trip decides exactly the same way',
  );
});

// ── 6. Replan with the same route ───────────────────────────────────────────

test('a change that does not beat the churn margin leaves the route alone', () => {
  // `far` is 30c cheaper on the milk and already on the route, so there is no travel
  // cost at all — and it is still not worth moving the line for.
  const stores = [store('near', 1), store('far', 2)];
  const products = [
    priced({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 349 }),
    priced({ id: 'near-eggs', concept: 'eggs', storeId: 'near', price: 200 }),
    priced({ id: 'far-milk', concept: 'milk', storeId: 'far', price: 360 }),
    priced({ id: 'far-eggs', concept: 'eggs', storeId: 'far', price: 900 }),
    priced({ id: 'far-rice', concept: 'rice', storeId: 'far', price: 300 }),
    priced({ id: 'near-rice', concept: 'rice', storeId: 'near', price: 1500 }),
  ];
  const list = basket([{ concept: 'milk' }, { concept: 'eggs' }, { concept: 'rice' }]);
  const trip = startTrip(list, stores, products);
  assert.equal(trip.stops.length, 2, 'the fixture is a two-stop trip');

  const decision = decide(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 380,
  });
  assert.equal(decision.recommended.kind, 'buy_here');

  const applied = applyAdaptation({
    trip,
    decision,
    chosenOptionId: decision.recommended.id,
    now: NOW,
  });
  assert.ok(applied);
  assert.deepEqual(
    applied.trip.stops.map((stop) => stop.store.id),
    trip.stops.map((stop) => stop.store.id),
    'the route is unchanged',
  );
});

test('the churn margin is what holds a near-tie in place', () => {
  const { stores, products, list } = twoStoreMarket();
  const trip = startTrip(list, stores, products);
  const decision = decide(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 349 + ADAPT_SWITCH_MARGIN_CENTS - 10,
  });
  assert.equal(decision.recommended.kind, 'buy_here', 'inside the margin, stay put');
});

// ── 7. Replan changes store ─────────────────────────────────────────────────

test('a large price rise moves the line to a stop already on the route', () => {
  // The milk trebles in price here, and the shopper is going to `far` anyway. Moving it
  // costs no travel at all, so the only question is the money — and the money is clear.
  const stores = [store('near', 1), store('far', 2)];
  const products = [
    priced({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 349 }),
    priced({ id: 'near-eggs', concept: 'eggs', storeId: 'near', price: 200 }),
    priced({ id: 'far-milk', concept: 'milk', storeId: 'far', price: 360 }),
    priced({ id: 'far-eggs', concept: 'eggs', storeId: 'far', price: 900 }),
    priced({ id: 'far-rice', concept: 'rice', storeId: 'far', price: 300 }),
    priced({ id: 'near-rice', concept: 'rice', storeId: 'near', price: 1500 }),
  ];
  const list = basket([{ concept: 'milk' }, { concept: 'eggs' }, { concept: 'rice' }]);
  const trip = startTrip(list, stores, products);

  const decision = decide(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 1200,
  });
  assert.equal(decision.recommended.kind, 'buy_at_existing_stop');
  assert.equal(decision.recommended.storeId, 'far');
  assert.equal(decision.recommended.extraMinutes, 0, 'no extra travel: already going there');
  assert.match(decision.recommendation, /next stop/i);

  const applied = applyAdaptation({
    trip,
    decision,
    chosenOptionId: decision.recommended.id,
    now: NOW,
  });
  assert.ok(applied);
  const atFar = applied.trip.stops.find((stop) => stop.store.id === 'far');
  assert.ok(
    atFar?.items.some((item) => item.groceryItemId === 'i1'),
    'the line moved',
  );
  const atNear = applied.trip.stops.find((stop) => stop.store.id === 'near');
  assert.equal(atNear?.items.find((item) => item.groceryItemId === 'i1')?.movedToStoreId, 'far');
});

test('moving a line updates both stores’ expected subtotals', () => {
  const stores = [store('near', 1), store('far', 2)];
  const products = [
    priced({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 349 }),
    priced({ id: 'near-eggs', concept: 'eggs', storeId: 'near', price: 200 }),
    priced({ id: 'far-milk', concept: 'milk', storeId: 'far', price: 360 }),
    priced({ id: 'far-eggs', concept: 'eggs', storeId: 'far', price: 900 }),
    priced({ id: 'far-rice', concept: 'rice', storeId: 'far', price: 300 }),
    priced({ id: 'near-rice', concept: 'rice', storeId: 'near', price: 1500 }),
  ];
  const list = basket([{ concept: 'milk' }, { concept: 'eggs' }, { concept: 'rice' }]);
  const trip = startTrip(list, stores, products);
  const decision = decide(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 1200,
  });
  const applied = applyAdaptation({
    trip,
    decision,
    chosenOptionId: `existing:far`,
    now: NOW,
  });
  assert.ok(applied);

  for (const stop of applied.trip.stops) {
    const computed = stop.items
      .filter((item) => item.status !== 'skipped' && item.status !== 'unavailable')
      .reduce((sum, item) => sum + (item.actualPriceCents ?? item.lineTotalCents) * 1, 0);
    assert.equal(
      stop.expectedSubtotalCents,
      computed,
      `${stop.store.id} subtotal must be the sum of its own lines`,
    );
  }
});

// ── 8. Change not worth the trip ────────────────────────────────────────────

test('a saving that needs a detour is offered but not recommended', () => {
  // `detour` is 20 miles away and 90c cheaper. The optimizer's own effort model prices
  // that drive far above 90c, so the option exists and loses.
  const stores = [store('near', 1), store('detour', 20)];
  const products = [
    priced({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 349 }),
    priced({ id: 'near-eggs', concept: 'eggs', storeId: 'near', price: 399 }),
    priced({ id: 'detour-milk', concept: 'milk', storeId: 'detour', price: 259 }),
  ];
  const list = basket([{ concept: 'milk' }, { concept: 'eggs' }]);
  const trip = startTrip(list, stores, products, [], { maxStores: 1 });

  const decision = decide(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 429,
  });
  const detour = decision.options.find((option) => option.kind === 'add_stop');
  assert.ok(detour, 'the detour is evaluated and shown');
  assert.ok(detour.effortDeltaCents > detour.basketDeltaCents * -1, 'and costs more than it saves');
  assert.equal(decision.recommended.kind, 'buy_here');
  assert.match(decision.detail, /adds \d+ minutes/);
});

test('an 80c rise never justifies a 20-mile drive at any convenience setting', () => {
  // The absurd-reroute guard, swept across the whole preference range including the
  // lowest-price end, where the effort weight is at its floor rather than at zero.
  const stores = [store('near', 1), store('detour', 20)];
  const products = [
    priced({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 349 }),
    priced({ id: 'near-eggs', concept: 'eggs', storeId: 'near', price: 399 }),
    priced({ id: 'detour-milk', concept: 'milk', storeId: 'detour', price: 259 }),
  ];
  const list = basket([{ concept: 'milk' }, { concept: 'eggs' }]);

  for (const conveniencePreference of [0, 0.25, 0.5, 1]) {
    const trip = startTrip(list, stores, products, [], {
      maxStores: 1,
      conveniencePreference,
    });
    const decision = decide(
      trip,
      { kind: 'different_price', groceryItemId: 'i1', observedPriceCents: 429 },
      { conveniencePreference },
    );
    assert.equal(
      decision.recommended.kind,
      'buy_here',
      `at conveniencePreference ${conveniencePreference} the detour must lose`,
    );
  }
});

test('a large enough saving does justify a detour', () => {
  // The guard must not be a blanket refusal: $18 is worth a drive, and Juva says so.
  const stores = [store('near', 1), store('detour', 4)];
  const products = [
    priced({ id: 'near-roast', concept: 'chicken breast', storeId: 'near', price: 2400 }),
    priced({ id: 'near-eggs', concept: 'eggs', storeId: 'near', price: 399 }),
    priced({ id: 'detour-roast', concept: 'chicken breast', storeId: 'detour', price: 600 }),
  ];
  const list = basket([{ concept: 'chicken breast' }, { concept: 'eggs' }]);
  const trip = startTrip(list, stores, products, [], { maxStores: 1 });

  const decision = decide(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 2400,
  });
  assert.equal(decision.recommended.kind, 'add_stop');
  assert.equal(decision.recommended.storeId, 'detour');
  assert.ok(decision.recommended.extraMinutes > 0, 'and the cost is stated, not hidden');
});

// ── 9. Sync after reconnect ─────────────────────────────────────────────────

test('offline adaptations survive and stay ordered after reconnecting', () => {
  // "Sync" here is the trip being persisted and reloaded: the adaptation log is the
  // record that has to survive, in order, with its offline flags intact.
  const { stores, products, list } = twoStoreMarket();
  let trip = startTrip(list, stores, products, [], { maxStores: 1 });

  const first = decide(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 429,
  });
  const afterFirst = applyAdaptation({
    trip,
    decision: first,
    chosenOptionId: first.recommended.id,
    now: NOW,
  });
  assert.ok(afterFirst);
  trip = JSON.parse(JSON.stringify(afterFirst.trip)) as ShoppingTrip;

  const second = decide(trip, {
    kind: 'different_price',
    groceryItemId: 'i2',
    observedPriceCents: 450,
  });
  const afterSecond = applyAdaptation({
    trip,
    decision: second,
    chosenOptionId: second.recommended.id,
    now: new Date(NOW.getTime() + 60_000),
  });
  assert.ok(afterSecond);

  const log = afterSecond.trip.adaptations;
  assert.equal(log.length, 2, 'both survive the round trip');
  assert.equal(log[0]?.usedCachedMarket, true, 'still recorded as decided from the cache');
  assert.equal(log[0]?.networkRequired, false);
  assert.equal(log[1]?.usedCachedMarket, true);
  assert.ok(Date.parse(log[0]?.at ?? '') < Date.parse(log[1]?.at ?? ''), 'and stay in order');
  assert.equal(afterSecond.trip.origin.comparedBaselineCents, trip.origin.comparedBaselineCents);
});

// ── Promotion integrity across a replan ─────────────────────────────────────

test('moving a line re-evaluates minimum spend at the store it leaves', () => {
  // The optimizer contract that is easiest to break in Shop Mode: `near` has a $2 off
  // offer that needs $15 of spend. Taking the milk away drops the store below it, and
  // the shopper has to be told the discount goes with it.
  const promotions: Promotion[] = [
    {
      id: 'spend15',
      retailerId: 'near',
      label: '$2 off when you spend $15',
      amountOffCents: 200,
      minimumBasketSpendCents: 1500,
    },
  ];
  const stores = [store('near', 1), store('far', 2)];
  const products = [
    priced({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 800 }),
    priced({
      id: 'near-eggs',
      concept: 'eggs',
      storeId: 'near',
      price: 800,
      promotionId: 'spend15',
    }),
    priced({ id: 'far-milk', concept: 'milk', storeId: 'far', price: 900 }),
    priced({ id: 'far-rice', concept: 'rice', storeId: 'far', price: 300 }),
    priced({ id: 'near-rice', concept: 'rice', storeId: 'near', price: 1500 }),
  ];
  const list = basket([{ concept: 'milk' }, { concept: 'eggs' }, { concept: 'rice' }]);
  const trip = startTrip(list, stores, products, promotions);

  const decision = decide(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 2000,
  });
  const move = decision.options.find((option) => option.kind === 'buy_at_existing_stop');
  assert.ok(move, 'moving the milk to far is evaluated');
  const lost = move.promotionImpacts.find((impact) => impact.storeId === 'near');
  assert.ok(lost, 'the offer left behind at near is reported');
  assert.ok(
    lost.before === 'applied' || lost.after !== 'applied',
    'the minimum-spend offer is re-evaluated, not carried over',
  );
});

test('a promotion loss is surfaced in the explanation, not buried in the arithmetic', () => {
  const promotions: Promotion[] = [
    {
      id: 'spend15',
      retailerId: 'near',
      label: '$2 off when you spend $15',
      amountOffCents: 200,
      minimumBasketSpendCents: 1500,
    },
  ];
  const stores = [store('near', 1), store('far', 2)];
  const products = [
    priced({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 800 }),
    priced({
      id: 'near-eggs',
      concept: 'eggs',
      storeId: 'near',
      price: 800,
      promotionId: 'spend15',
    }),
    priced({ id: 'far-milk', concept: 'milk', storeId: 'far', price: 900 }),
    priced({ id: 'far-rice', concept: 'rice', storeId: 'far', price: 300 }),
    priced({ id: 'near-rice', concept: 'rice', storeId: 'near', price: 1500 }),
  ];
  const list = basket([{ concept: 'milk' }, { concept: 'eggs' }, { concept: 'rice' }]);
  const trip = startTrip(list, stores, products, promotions);
  const decision = decide(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 2000,
  });

  if (decision.recommended.promotionImpacts.some((impact) => impact.before === 'applied')) {
    assert.match(decision.detail, /no longer applies/);
  }
  // Whatever it recommends, the figures behind it reconcile.
  assert.equal(
    decision.recommended.netDeltaCents,
    decision.recommended.basketDeltaCents + decision.recommended.effortDeltaCents,
  );
});

// ── Quantity and package changes ────────────────────────────────────────────

test('a quantity change re-prices the line through the pack maths', () => {
  const { stores, products, list } = twoStoreMarket();
  const trip = startTrip(list, stores, products, [], { maxStores: 1 });
  const decision = decide(trip, {
    kind: 'quantity_changed',
    groceryItemId: 'i1',
    observedQuantity: 3,
  });

  assert.equal(decision.headline, 'QUANTITY CHANGED');
  const buyHere = decision.options.find((option) => option.id === 'buy_here');
  assert.ok(buyHere);
  assert.equal(buyHere.lineTotalCents, 349 * 3, 'three packs, priced by the pack maths');
});

test('a different package is priced at the shelf price for that package', () => {
  const { stores, products, list } = twoStoreMarket();
  const trip = startTrip(list, stores, products, [], { maxStores: 1 });
  const decision = decide(trip, {
    kind: 'different_package',
    groceryItemId: 'i1',
    observedPriceCents: 599,
    observedSizeLabel: '2 ct',
  });

  assert.equal(decision.headline, 'DIFFERENT PACK');
  const applied = applyAdaptation({
    trip,
    decision,
    chosenOptionId: decision.recommended.id,
    now: NOW,
  });
  assert.ok(applied);
  const line = applied.trip.stops[0]?.items.find((item) => item.groceryItemId === 'i1');
  assert.equal(line?.status, 'different_package');
  assert.equal(line?.actualSizeLabel, '2 ct');
  assert.equal(line?.actualPriceCents, 599);
});

// ── Determinism and integrity ───────────────────────────────────────────────

test('the same trip and event always produce the same decision', () => {
  const { stores, products, list } = twoStoreMarket();
  const trip = startTrip(list, stores, products);
  const event: ShopEvent = {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 900,
  };
  assert.equal(JSON.stringify(decide(trip, event)), JSON.stringify(decide(trip, event)));
});

test('every option reconciles its own arithmetic', () => {
  const { stores, products, list } = twoStoreMarket();
  const trip = startTrip(list, stores, products);
  const decision = decide(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 900,
  });
  for (const option of decision.options) {
    assert.equal(
      option.netDeltaCents,
      option.basketDeltaCents + option.effortDeltaCents,
      `${option.id} must be basket plus effort`,
    );
    assert.ok(Number.isInteger(option.lineTotalCents));
    assert.ok(Number.isInteger(option.basketDeltaCents));
    assert.ok(Number.isInteger(option.effortDeltaCents));
  }
});

test('rankable options come first and cheapest first; the rest keep a stable place', () => {
  const { stores, products, list } = twoStoreMarket();
  const trip = startTrip(list, stores, products);
  const decision = decide(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 900,
  });

  const rankable = decision.options.filter((option) => option.rankable);
  const deltas = rankable.map((option) => option.netDeltaCents);
  assert.deepEqual(
    deltas,
    [...deltas].sort((a, b) => a - b),
    'competing options ascend',
  );

  const firstNonRankable = decision.options.findIndex((option) => !option.rankable);
  if (firstNonRankable >= 0) {
    assert.ok(
      decision.options.slice(firstNonRankable).every((option) => !option.rankable),
      'nothing rankable appears after a non-rankable option',
    );
  }
});

test('no option carries a sentinel score that could reach arithmetic', () => {
  // The "do without" option used to rank at Number.MAX_SAFE_INTEGER. Any subtraction
  // involving that produces nonsense, and any savings figure derived from it produces a
  // plausible-looking lie, which is worse.
  const { stores, products, list } = twoStoreMarket();
  const trip = startTrip(list, stores, products);
  const decision = decide(trip, { kind: 'unavailable', groceryItemId: 'i1' });

  for (const option of decision.options) {
    assert.ok(Number.isSafeInteger(option.netDeltaCents));
    assert.ok(
      Math.abs(option.netDeltaCents) < 1_000_000,
      `${option.id} must carry a real figure, not a sentinel`,
    );
    assert.equal(
      option.netDeltaCents,
      option.basketDeltaCents + option.effortDeltaCents,
      `${option.id} reconciles, including the non-rankable ones`,
    );
  }

  const drop = decision.options.find((option) => option.id === 'drop');
  assert.ok(drop);
  assert.equal(drop.rankable, false, 'excluded by state, not by score');
});

test('an unknown item or option id is refused rather than guessed', () => {
  const { stores, products, list } = twoStoreMarket();
  const trip = startTrip(list, stores, products);
  assert.equal(
    adaptTrip({
      trip,
      event: { kind: 'different_price', groceryItemId: 'nope', observedPriceCents: 100 },
      preferences: prefs,
      now: NOW,
    }),
    undefined,
  );

  const decision = decide(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 900,
  });
  assert.equal(
    applyAdaptation({ trip, decision, chosenOptionId: 'not-an-option', now: NOW }),
    undefined,
  );
});

test('trip progress reports drift against the frozen original, both ways', () => {
  const { stores, products, list } = twoStoreMarket();
  const trip = startTrip(list, stores, products, [], { maxStores: 1 });
  const before = tripProgress(trip);
  assert.equal(before.driftCents, 0, 'an untouched trip has not drifted');
  assert.equal(before.expectedTotalCents, trip.origin.basketCostCents);

  const decision = decide(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 449,
  });
  const applied = applyAdaptation({
    trip,
    decision,
    chosenOptionId: 'buy_here',
    now: NOW,
  });
  assert.ok(applied);
  const after = tripProgress(applied.trip);
  assert.equal(after.driftCents, 100, 'a dollar dearer than planned');
  assert.equal(after.originalTotalCents, trip.origin.basketCostCents, 'the original is fixed');
  assert.equal(after.baselineCents, before.baselineCents, 'the baseline did not move');
  assert.ok(
    after.estimatedSavingsCents <= before.estimatedSavingsCents,
    'paying more can only shrink the saving, never grow it',
  );
});

test('a trip that started from a partial plan never becomes comparable', () => {
  // Nothing that happens in the aisle can earn a savings claim the plan never had.
  const stores = [store('near', 1)];
  const products = [priced({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 349 })];
  const list = basket([{ concept: 'milk' }, { concept: 'saffron' }]);
  const trip = startTrip(list, stores, products, [], { maxStores: 1 });
  assert.equal(trip.origin.comparisonEligible, false);

  const decision = decide(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 100,
  });
  const applied = applyAdaptation({ trip, decision, chosenOptionId: 'buy_here', now: NOW });
  assert.ok(applied);
  const progress = tripProgress(applied.trip);
  assert.equal(progress.comparisonEligible, false);
  assert.equal(progress.estimatedSavingsCents, 0);
});
