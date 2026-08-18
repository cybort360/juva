import assert from 'node:assert/strict';
import { test } from 'node:test';

import { demoPreferences } from '../src/domain/demoMarket';
import { optimizeBasket } from '../src/domain/optimizer';
import { adaptTrip, applyAdaptation, type ShopEvent } from '../src/domain/shopAdapt';
import { createTrip } from '../src/domain/trip';
import {
  fingerprint,
  originFingerprint,
  originIntact,
  snapshotOrigin,
  tripOriginIntact,
} from '../src/domain/tripOrigin';
import type {
  GroceryList,
  GroceryListItem,
  MarketSnapshot,
  Promotion,
  RetailerProduct,
  ShoppingTrip,
  Store,
  TripOrigin,
  UserPreferences,
} from '../src/domain/types';

/**
 * The permanent economic baseline.
 *
 * `trip.origin` is what every savings claim is measured against, so the property under
 * test is blunt: after any sequence of adaptations, the origin says exactly what it said
 * when the trip began. Each test below ends by comparing the stored fingerprint against
 * one recomputed from the live fields.
 *
 * Three mechanisms are tested separately because each catches what the others miss — a
 * value snapshot (no shared structure), a freeze (catches writes in development), and a
 * fingerprint (the only one that survives `JSON.parse`).
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
    address: `${id} road`,
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
      concept: item.concept ?? 'milk',
      displayName: item.displayName ?? item.concept ?? 'Milk',
      quantity: item.quantity ?? 1,
      unit: item.unit ?? '1 ct',
      ...(item.requestedBrand === undefined ? {} : { requestedBrand: item.requestedBrand }),
      ...(item.brandPolicy === undefined ? {} : { brandPolicy: item.brandPolicy }),
    })),
  };
}

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
  assert.ok(plan);
  const snapshot: MarketSnapshot = {
    mode: 'demo',
    fetchedAt: NOW.toISOString(),
    stores,
    products,
    promotions,
  };
  return createTrip(plan, list, snapshot, NOW);
}

/** Runs one event through the engine and applies the recommendation. */
function adapt(
  trip: ShoppingTrip,
  event: ShopEvent,
  chosenOptionId?: string,
): { trip: ShoppingTrip; chosen: string } {
  const decision = adaptTrip({ trip, event, preferences: prefs, now: NOW });
  assert.ok(decision, `a decision is expected for ${event.kind}`);
  const optionId = chosenOptionId ?? decision.recommended.id;
  const applied = applyAdaptation({ trip, decision, chosenOptionId: optionId, now: NOW });
  assert.ok(applied, `applying ${optionId} must succeed`);
  return { trip: applied.trip, chosen: optionId };
}

/** Two stores, both stocking everything, so every kind of replan is reachable. */
function market() {
  const stores = [store('near', 1), store('far', 2)];
  const products = [
    priced({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 349, brand: 'Alpine' }),
    priced({ id: 'near-milk-b', concept: 'milk', storeId: 'near', price: 309, brand: 'Value' }),
    priced({ id: 'near-eggs', concept: 'eggs', storeId: 'near', price: 200 }),
    priced({ id: 'far-milk', concept: 'milk', storeId: 'far', price: 360 }),
    priced({ id: 'far-rice', concept: 'rice', storeId: 'far', price: 300 }),
    priced({ id: 'near-rice', concept: 'rice', storeId: 'near', price: 1500 }),
  ];
  const list = basket([{ concept: 'milk' }, { concept: 'eggs' }, { concept: 'rice' }]);
  return { stores, products, list };
}

/** Asserts the origin is byte-identical and still self-consistent. */
function assertOriginUnmoved(after: ShoppingTrip, before: TripOrigin, why: string): void {
  assert.equal(after.origin.fingerprint, before.fingerprint, `${why}: fingerprint moved`);
  assert.equal(originFingerprint(after.origin), before.fingerprint, `${why}: fields moved`);
  assert.equal(tripOriginIntact(after), true, `${why}: origin no longer intact`);
  assert.equal(JSON.stringify(after.origin), JSON.stringify(before), `${why}: origin differs`);
}

// ── The fingerprint itself ──────────────────────────────────────────────────

test('the fingerprint is deterministic and stable across runs', () => {
  assert.equal(fingerprint('juva'), fingerprint('juva'));
  assert.notEqual(fingerprint('juva'), fingerprint('juvb'));
  // Hex, fixed width, so it is comparable as a plain string.
  assert.match(fingerprint('anything'), /^[0-9a-f]{8}$/);
});

test('every economically relevant field changes the fingerprint', () => {
  const base = snapshotOrigin({
    planId: 'plan-1',
    planKind: 'recommended',
    basketCostCents: 5000,
    comparedBaselineCents: 5800,
    baselineKind: 'cheapest_complete_single_store',
    savingsVsBaselineCents: 800,
    storeIds: ['a', 'b'],
    capturedAt: NOW.toISOString(),
    comparisonEligible: true,
  });

  const variants: TripOrigin[] = [
    { ...base, basketCostCents: 5001 },
    { ...base, comparedBaselineCents: 5801 },
    { ...base, baselineKind: 'usual_store' },
    { ...base, savingsVsBaselineCents: 801 },
    { ...base, comparisonEligible: false },
    { ...base, storeIds: ['a', 'c'] },
    { ...base, planId: 'plan-2' },
  ];
  for (const variant of variants) {
    assert.notEqual(
      originFingerprint(variant),
      base.fingerprint,
      'a changed economic field must change the hash',
    );
  }
});

test('reordering the store list is not treated as tampering', () => {
  // A stop reorder is a route detail, not an economic change. A changed *set* still is.
  const base = snapshotOrigin({
    planId: 'plan-1',
    planKind: 'recommended',
    basketCostCents: 5000,
    comparedBaselineCents: 5800,
    baselineKind: 'cheapest_complete_single_store',
    savingsVsBaselineCents: 800,
    storeIds: ['a', 'b'],
    capturedAt: NOW.toISOString(),
    comparisonEligible: true,
  });
  assert.equal(originFingerprint({ ...base, storeIds: ['b', 'a'] }), base.fingerprint);
  assert.notEqual(originFingerprint({ ...base, storeIds: ['a', 'b', 'c'] }), base.fingerprint);
});

test('provenance fields are outside the fingerprint', () => {
  // `capturedAt` and `planKind` are labels, not money. Including them would make the
  // hash fire on changes that cost the shopper nothing.
  const base = snapshotOrigin({
    planId: 'plan-1',
    planKind: 'recommended',
    basketCostCents: 5000,
    comparedBaselineCents: 5800,
    baselineKind: 'none',
    savingsVsBaselineCents: 0,
    storeIds: ['a'],
    capturedAt: NOW.toISOString(),
    comparisonEligible: true,
  });
  assert.equal(
    originFingerprint({ ...base, capturedAt: '2020-01-01T00:00:00.000Z' }),
    base.fingerprint,
  );
  assert.equal(originFingerprint({ ...base, planKind: 'lowest_effort' }), base.fingerprint);
});

// ── Snapshot semantics ──────────────────────────────────────────────────────

test('the origin shares no structure with the plan it came from', () => {
  const { stores, products, list } = market();
  const plans = optimizeBasket({
    list,
    stores,
    products,
    promotions: [],
    preferences: prefs,
    now: NOW,
  });
  const plan = plans[0];
  assert.ok(plan);
  const trip = createTrip(
    plan,
    list,
    {
      mode: 'demo',
      fetchedAt: NOW.toISOString(),
      stores,
      products,
      promotions: [],
    },
    NOW,
  );

  // The store id array in particular: a spread would have shared it with the plan.
  assert.notEqual(
    trip.origin.storeIds,
    plan.stops.map((stop) => stop.store.id),
    'a fresh array, not a borrowed one',
  );
  assert.deepEqual(
    trip.origin.storeIds,
    plan.stops.map((stop) => stop.store.id),
    'with the same contents',
  );
});

test('a trip starts with an intact, self-consistent origin', () => {
  const { stores, products, list } = market();
  const trip = startTrip(list, stores, products);
  assert.equal(tripOriginIntact(trip), true);
  assert.ok(trip.origin.fingerprint.length > 0);
});

// ── Mutation is rejected or detected ────────────────────────────────────────

test('an accidental write to the origin throws rather than corrupting it', () => {
  // Modules are strict, and the snapshot is deep-frozen in development and test builds,
  // so a stray assignment fails at the point of the mistake.
  const { stores, products, list } = market();
  const trip = startTrip(list, stores, products);

  assert.throws(() => {
    (trip.origin as { basketCostCents: number }).basketCostCents = 1;
  }, TypeError);
  assert.throws(() => {
    trip.origin.storeIds.push('smuggled');
  }, TypeError);
  assert.equal(tripOriginIntact(trip), true, 'and nothing got through');
});

test('a mutation that does get through is detected by the fingerprint', () => {
  // The case that matters after persistence: a rehydrated trip is a plain mutable
  // object, so freezing protects nothing and the hash is the only remaining guard.
  const { stores, products, list } = market();
  const trip = startTrip(list, stores, products);
  const thawed = JSON.parse(JSON.stringify(trip)) as ShoppingTrip;

  assert.equal(tripOriginIntact(thawed), true, 'an untouched reload is intact');
  thawed.origin.comparedBaselineCents = 999_999;
  assert.equal(tripOriginIntact(thawed), false, 'a tampered baseline is caught');
});

test('a tampered origin refuses further adaptations rather than compounding', () => {
  // Continuing would produce a correct-looking adaptation on top of a corrupt record —
  // a savings figure that reconciles perfectly against the wrong number.
  const { stores, products, list } = market();
  const trip = startTrip(list, stores, products);
  const thawed = JSON.parse(JSON.stringify(trip)) as ShoppingTrip;
  thawed.origin.comparedBaselineCents = 1;

  const decision = adaptTrip({
    trip: thawed,
    event: { kind: 'different_price', groceryItemId: 'i1', observedPriceCents: 500 },
    preferences: prefs,
    now: NOW,
  });
  assert.ok(decision, 'the decision itself can still be computed');
  assert.equal(
    applyAdaptation({ trip: thawed, decision, chosenOptionId: 'buy_here', now: NOW }),
    undefined,
    'but nothing may be applied to it',
  );
});

test('originIntact is exposed for a single origin as well as a trip', () => {
  const base = snapshotOrigin({
    planId: 'p',
    planKind: 'recommended',
    basketCostCents: 100,
    comparedBaselineCents: 200,
    baselineKind: 'none',
    savingsVsBaselineCents: 0,
    storeIds: [],
    capturedAt: NOW.toISOString(),
    comparisonEligible: false,
  });
  assert.equal(originIntact(base), true);
  assert.equal(originIntact({ ...base, basketCostCents: 101 }), false);
});

// ── Every adaptation leaves the origin alone ────────────────────────────────

test('a price correction cannot move the origin', () => {
  const { stores, products, list } = market();
  const trip = startTrip(list, stores, products);
  const before = JSON.parse(JSON.stringify(trip.origin)) as TripOrigin;

  const result = adapt(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 899,
  });
  assertOriginUnmoved(result.trip, before, 'price correction');
});

test('a store change cannot move the origin', () => {
  const { stores, products, list } = market();
  const trip = startTrip(list, stores, products);
  const before = JSON.parse(JSON.stringify(trip.origin)) as TripOrigin;

  // Chosen explicitly rather than taken from the recommendation: this market also has a
  // cheaper own-brand on the same shelf, so the *recommended* answer is a substitute.
  // What is under test is that moving a line between stores leaves the origin alone.
  const result = adapt(
    trip,
    { kind: 'different_price', groceryItemId: 'i1', observedPriceCents: 1500 },
    'existing:far',
  );
  const movedTo = result.trip.stops
    .find((stop) => stop.store.id === 'far')
    ?.items.some((item) => item.groceryItemId === 'i1');
  assert.equal(movedTo, true, 'the line really did move');
  assertOriginUnmoved(result.trip, before, 'store change');
});

test('a substitution cannot move the origin', () => {
  const { stores, products, list } = market();
  const trip = startTrip(list, stores, products);
  const before = JSON.parse(JSON.stringify(trip.origin)) as TripOrigin;

  const decision = adaptTrip({
    trip,
    event: { kind: 'substitute', groceryItemId: 'i1' },
    preferences: prefs,
    now: NOW,
  });
  assert.ok(decision);
  const substitute = decision.options.find((option) => option.kind === 'change_substitute');
  assert.ok(substitute, 'the fixture offers a same-store alternative');
  const applied = applyAdaptation({
    trip,
    decision,
    chosenOptionId: substitute.id,
    now: NOW,
  });
  assert.ok(applied);
  assertOriginUnmoved(applied.trip, before, 'substitution');
});

test('a quantity change cannot move the origin', () => {
  const { stores, products, list } = market();
  const trip = startTrip(list, stores, products);
  const before = JSON.parse(JSON.stringify(trip.origin)) as TripOrigin;

  const result = adapt(trip, {
    kind: 'quantity_changed',
    groceryItemId: 'i1',
    observedQuantity: 4,
  });
  assertOriginUnmoved(result.trip, before, 'quantity change');
});

test('a package change cannot move the origin', () => {
  const { stores, products, list } = market();
  const trip = startTrip(list, stores, products);
  const before = JSON.parse(JSON.stringify(trip.origin)) as TripOrigin;

  const result = adapt(trip, {
    kind: 'different_package',
    groceryItemId: 'i1',
    observedPriceCents: 599,
    observedSizeLabel: '2 ct',
  });
  assertOriginUnmoved(result.trip, before, 'package change');
});

test('dropping an item cannot move the origin', () => {
  const { stores, products, list } = market();
  const trip = startTrip(list, stores, products);
  const before = JSON.parse(JSON.stringify(trip.origin)) as TripOrigin;

  const result = adapt(trip, { kind: 'unavailable', groceryItemId: 'i1' }, 'drop');
  assertOriginUnmoved(result.trip, before, 'drop');
});

test('a long sequence of adaptations leaves the origin exactly where it started', () => {
  // The property stated end to end: five different corrections, one after another, each
  // feeding the next trip in.
  const { stores, products, list } = market();
  let trip = startTrip(list, stores, products);
  const before = JSON.parse(JSON.stringify(trip.origin)) as TripOrigin;

  const events: ShopEvent[] = [
    { kind: 'different_price', groceryItemId: 'i1', observedPriceCents: 380 },
    { kind: 'quantity_changed', groceryItemId: 'i2', observedQuantity: 2 },
    {
      kind: 'different_package',
      groceryItemId: 'i1',
      observedPriceCents: 420,
      observedSizeLabel: '2 ct',
    },
    { kind: 'substitute', groceryItemId: 'i1' },
    // Stays on lines at the *current* stop: `i3` is bought at the second store, and a
    // shopper cannot report a shelf they are not standing at.
    { kind: 'different_price', groceryItemId: 'i2', observedPriceCents: 240 },
  ];

  for (const event of events) {
    trip = adapt(trip, event).trip;
    assertOriginUnmoved(trip, before, `after ${event.kind}`);
  }
  assert.equal(trip.adaptations.length, events.length, 'every one was recorded');
});

// ── Persistence ─────────────────────────────────────────────────────────────

test('a persisted and reloaded trip retains an identical origin', () => {
  const { stores, products, list } = market();
  const trip = startTrip(list, stores, products);
  const adapted = adapt(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 500,
  }).trip;

  const reloaded = JSON.parse(JSON.stringify(adapted)) as ShoppingTrip;
  assert.equal(JSON.stringify(reloaded.origin), JSON.stringify(trip.origin));
  assert.equal(reloaded.origin.fingerprint, trip.origin.fingerprint);
  assert.equal(tripOriginIntact(reloaded), true);
});

test('a reloaded trip keeps adapting from the same baseline', () => {
  const { stores, products, list } = market();
  const trip = startTrip(list, stores, products);
  const before = JSON.parse(JSON.stringify(trip.origin)) as TripOrigin;

  const first = adapt(trip, {
    kind: 'different_price',
    groceryItemId: 'i1',
    observedPriceCents: 500,
  }).trip;
  const reloaded = JSON.parse(JSON.stringify(first)) as ShoppingTrip;
  const second = adapt(reloaded, {
    kind: 'different_price',
    groceryItemId: 'i2',
    observedPriceCents: 260,
  }).trip;

  assertOriginUnmoved(second, before, 'after a reload');
  assert.equal(second.adaptations.length, 2, 'and the log carried through');
});
