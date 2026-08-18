import assert from 'node:assert/strict';
import { test } from 'node:test';

import { demoPreferences } from '../src/domain/demoMarket';
import {
  MIN_EFFORT_WEIGHT,
  effortWeightFor,
  estimateGeometry,
  optimizeBasket,
} from '../src/domain/optimizer';
import type {
  GroceryList,
  GroceryListItem,
  OptimizedPlan,
  PlanKind,
  Promotion,
  RetailerProduct,
  Store,
  UserPreferences,
} from '../src/domain/types';

/**
 * Purpose-built fixtures rather than the demo market, so each scenario isolates
 * exactly one behaviour. The demo market has its own regression tests.
 */

const NOW = new Date('2026-08-11T12:00:00Z');

const prefs: UserPreferences = {
  ...demoPreferences,
  onboarded: true,
  maxStores: 3,
  radiusMiles: 10,
  loyaltyRetailers: [],
  conveniencePreference: 0.5,
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

interface ProductSpec {
  id: string;
  concept: string;
  storeId: string;
  price: number;
  brand?: string;
  size?: string;
  promotionId?: string;
  available?: boolean;
  freshness?: RetailerProduct['observation']['freshness'];
  currency?: 'USD' | 'EUR';
  soldByWeight?: boolean;
}

function makeProduct(spec: ProductSpec): RetailerProduct {
  return {
    id: spec.id,
    canonicalConcept: spec.concept,
    storeId: spec.storeId,
    title: `${spec.concept} at ${spec.storeId}`,
    brand: spec.brand ?? 'Generic',
    sizeLabel: spec.size ?? '1 ct',
    ...(spec.soldByWeight === undefined ? {} : { soldByWeight: spec.soldByWeight }),
    observation: {
      id: `obs-${spec.id}`,
      storeId: spec.storeId,
      retailerId: spec.storeId,
      retailerProductId: spec.id,
      scope: 'store',
      priceCents: spec.price,
      currency: spec.currency ?? 'USD',
      source: 'demo',
      observedAt: NOW.toISOString(),
      freshness: spec.freshness ?? 'demo',
      confidence: 0.9,
      available: spec.available ?? true,
      availability: 'in_stock',
      ...(spec.promotionId === undefined ? {} : { promotionId: spec.promotionId }),
    },
  };
}

function listOf(items: Partial<GroceryListItem>[], budgetCents?: number): GroceryList {
  return {
    id: 'list',
    title: 'Test basket',
    prompt: 'test',
    currency: 'USD',
    createdAt: NOW.toISOString(),
    ...(budgetCents === undefined ? {} : { budgetCents }),
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

function plan(
  list: GroceryList,
  stores: Store[],
  products: RetailerProduct[],
  overrides: Partial<UserPreferences> = {},
  promotions: Promotion[] = [],
): OptimizedPlan[] {
  return optimizeBasket({
    list,
    stores,
    products,
    promotions,
    preferences: { ...prefs, ...overrides },
    now: NOW,
  });
}

function kindOf(plans: OptimizedPlan[], kind: PlanKind): OptimizedPlan | undefined {
  return plans.find((entry) => entry.kind === kind);
}

// ── Plan set generation ─────────────────────────────────────────────────────

test('a two-store market with split bargains yields both single and multi plans', () => {
  const stores = [store('a', 1), store('b', 2)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 }),
    makeProduct({ id: 'a-bread', concept: 'bread', storeId: 'a', price: 500 }),
    makeProduct({ id: 'b-milk', concept: 'milk', storeId: 'b', price: 500 }),
    makeProduct({ id: 'b-bread', concept: 'bread', storeId: 'b', price: 200 }),
  ];
  const plans = plan(listOf([{ concept: 'milk' }, { concept: 'bread' }]), stores, products);

  const single = kindOf(plans, 'cheapest_single_store');
  // Found by shape: when the cheapest multi-store trip is also the recommended
  // one, Juva shows a single card rather than two identically-priced ones.
  const multi = plans.find((entry) => entry.complete && entry.stops.length > 1);
  assert.ok(single, 'a complete single-store plan exists');
  assert.ok(multi, 'a complete multi-store plan exists');
  assert.equal(single.basketCostCents, 700, 'store b: 500 + 200');
  assert.equal(multi.basketCostCents, 500, 'milk at a, bread at b');
  assert.equal(multi.stops.length, 2);
});

test('a multi-store trip that is also the recommendation is shown once', () => {
  const stores = [store('a', 1), store('b', 2)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 }),
    makeProduct({ id: 'a-bread', concept: 'bread', storeId: 'a', price: 500 }),
    makeProduct({ id: 'b-milk', concept: 'milk', storeId: 'b', price: 500 }),
    makeProduct({ id: 'b-bread', concept: 'bread', storeId: 'b', price: 200 }),
  ];
  const plans = plan(listOf([{ concept: 'milk' }, { concept: 'bread' }]), stores, products);

  const multi = plans.find((entry) => entry.stops.length > 1);
  assert.ok(multi);
  assert.equal(multi.kind, 'recommended', 'the more useful label wins');
  assert.match(
    multi.explanation.rationale,
    /cheapest multi-store plan/,
    'the collapsed role is still disclosed',
  );
});

test('the baseline is the cheapest complete single-store basket', () => {
  const stores = [store('a', 1), store('b', 2)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 }),
    makeProduct({ id: 'a-bread', concept: 'bread', storeId: 'a', price: 500 }),
    makeProduct({ id: 'b-milk', concept: 'milk', storeId: 'b', price: 500 }),
    makeProduct({ id: 'b-bread', concept: 'bread', storeId: 'b', price: 200 }),
  ];
  const plans = plan(listOf([{ concept: 'milk' }, { concept: 'bread' }]), stores, products);

  for (const entry of plans) {
    assert.equal(entry.comparedBaselineCents, 700);
    assert.equal(entry.explanation.baselineKind, 'cheapest_complete_single_store');
  }
  const multi = plans.find((entry) => entry.complete && entry.stops.length > 1);
  assert.equal(multi?.savingsVsBaselineCents, 200, '700 baseline minus a 500 split basket');
});

test('every plan explains itself with the required figures', () => {
  const stores = [store('a', 1), store('b', 2.5)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 }),
    makeProduct({ id: 'b-milk', concept: 'milk', storeId: 'b', price: 250 }),
  ];
  const plans = plan(listOf([{ concept: 'milk' }]), stores, products);

  for (const entry of plans) {
    const explanation = entry.explanation;
    assert.equal(explanation.basketCostCents, entry.basketCostCents);
    assert.equal(explanation.storeCount, entry.stops.length);
    assert.equal(explanation.travelMiles, entry.travelMiles);
    assert.equal(explanation.etaMinutes, entry.etaMinutes);
    assert.equal(explanation.baselineCents, entry.comparedBaselineCents);
    assert.equal(explanation.estimatedSavingsCents, entry.savingsVsBaselineCents);
    assert.ok(explanation.rationale.length > 20, 'a real sentence, not a placeholder');
    assert.ok(explanation.score.totalCents > 0);
  }
});

test('the recommended plan is the lowest weighted score', () => {
  const stores = [store('near', 0.5), store('far', 8)];
  const products = [
    makeProduct({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 400 }),
    // Cheaper basket, but 8 miles away.
    makeProduct({ id: 'far-milk', concept: 'milk', storeId: 'far', price: 300 }),
  ];
  const plans = plan(listOf([{ concept: 'milk' }]), stores, products);
  const recommended = kindOf(plans, 'recommended');
  assert.ok(recommended);

  const lowest = [...plans].sort(
    (a, b) => a.explanation.score.totalCents - b.explanation.score.totalCents,
  )[0];
  assert.equal(recommended.effectiveCostCents, lowest?.effectiveCostCents);
  assert.equal(recommended.stops[0]?.store.id, 'near', 'a dollar saved is not worth 15 miles');
});

test('a lowest-effort plan is always offered', () => {
  const stores = [store('near', 0.4), store('far', 6)];
  const products = [
    makeProduct({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 900 }),
    makeProduct({ id: 'far-milk', concept: 'milk', storeId: 'far', price: 100 }),
  ];
  const plans = plan(listOf([{ concept: 'milk' }]), stores, products);
  const effort = kindOf(plans, 'lowest_effort');
  assert.ok(effort);
  assert.equal(effort.stops[0]?.store.id, 'near', 'least travel wins regardless of price');
});

test('a strict-budget plan appears only when a budget exists', () => {
  const stores = [store('a', 1)];
  const products = [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 })];

  const noBudget = plan(listOf([{ concept: 'milk' }]), stores, products);
  assert.equal(kindOf(noBudget, 'strict_budget'), undefined);

  const withBudget = plan(listOf([{ concept: 'milk' }], 500), stores, products);
  const strict = kindOf(withBudget, 'strict_budget');
  // Only one trip exists, so the budget plan collapses onto it.
  assert.ok(strict ?? kindOf(withBudget, 'recommended'));
});

test('nothing inside the budget yields no budget plan rather than a near miss', () => {
  const stores = [store('a', 1)];
  const products = [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 900 })];
  const plans = plan(listOf([{ concept: 'milk' }], 500), stores, products);

  assert.equal(kindOf(plans, 'strict_budget'), undefined, 'no plan fits, so none is claimed to');
  assert.ok(plans.length > 0, 'the shopper still gets the real options');
});

test('the budget plan maximises coverage before minimising price', () => {
  const stores = [store('a', 1), store('b', 1.2)];
  const products = [
    // Store a: both items, total 500, inside the budget.
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 }),
    makeProduct({ id: 'a-bread', concept: 'bread', storeId: 'a', price: 200 }),
    // Store b: only milk, cheaper, but leaves the basket incomplete.
    makeProduct({ id: 'b-milk', concept: 'milk', storeId: 'b', price: 100 }),
  ];
  const plans = plan(listOf([{ concept: 'milk' }, { concept: 'bread' }], 600), stores, products);
  const strict = kindOf(plans, 'strict_budget') ?? kindOf(plans, 'recommended');
  assert.ok(strict);
  assert.equal(strict.complete, true, 'a cheap half-basket does not answer "keep me under budget"');
});

test('plan ids are unique and identical trips are not shown twice', () => {
  const stores = [store('a', 1)];
  const products = [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 })];
  const plans = plan(listOf([{ concept: 'milk' }]), stores, products);

  assert.equal(new Set(plans.map((entry) => entry.id)).size, plans.length);
  const trips = plans.map(
    (entry) => `${entry.stops.map((s) => s.store.id).join()}-${entry.basketCostCents}`,
  );
  assert.equal(new Set(trips).size, trips.length, 'one trip is never listed under two cards');
});

test('a collapsed plan says which other roles it fills', () => {
  const stores = [store('a', 1)];
  const products = [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 })];
  const plans = plan(listOf([{ concept: 'milk' }]), stores, products);
  assert.equal(plans.length, 1, 'one store, one possible trip');
  assert.match(plans[0]?.explanation.rationale ?? '', /also the/);
});

// ── User controls ───────────────────────────────────────────────────────────

test('maxStores bounds every plan offered', () => {
  const stores = [store('a', 1), store('b', 1.5), store('c', 2)];
  const products = [
    makeProduct({ id: 'a-1', concept: 'milk', storeId: 'a', price: 100 }),
    makeProduct({ id: 'b-2', concept: 'bread', storeId: 'b', price: 100 }),
    makeProduct({ id: 'c-3', concept: 'eggs', storeId: 'c', price: 100 }),
    makeProduct({ id: 'a-2', concept: 'bread', storeId: 'a', price: 900 }),
    makeProduct({ id: 'a-3', concept: 'eggs', storeId: 'a', price: 900 }),
  ];
  const list = listOf([{ concept: 'milk' }, { concept: 'bread' }, { concept: 'eggs' }]);

  for (const limit of [1, 2, 3]) {
    const plans = plan(list, stores, products, { maxStores: limit });
    for (const entry of plans) {
      assert.ok(
        entry.stops.length <= limit,
        `${entry.kind} used ${entry.stops.length} of ${limit}`,
      );
    }
  }
});

test('raising maxStores genuinely finds a cheaper basket', () => {
  const stores = [store('a', 1), store('b', 1.5), store('c', 2)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 100 }),
    makeProduct({ id: 'a-bread', concept: 'bread', storeId: 'a', price: 900 }),
    makeProduct({ id: 'a-eggs', concept: 'eggs', storeId: 'a', price: 900 }),
    makeProduct({ id: 'b-bread', concept: 'bread', storeId: 'b', price: 100 }),
    makeProduct({ id: 'b-milk', concept: 'milk', storeId: 'b', price: 900 }),
    makeProduct({ id: 'b-eggs', concept: 'eggs', storeId: 'b', price: 900 }),
    makeProduct({ id: 'c-eggs', concept: 'eggs', storeId: 'c', price: 100 }),
    makeProduct({ id: 'c-milk', concept: 'milk', storeId: 'c', price: 900 }),
    makeProduct({ id: 'c-bread', concept: 'bread', storeId: 'c', price: 900 }),
  ];
  const list = listOf([{ concept: 'milk' }, { concept: 'bread' }, { concept: 'eggs' }]);

  const cheapestAt = (limit: number): number =>
    Math.min(...plan(list, stores, products, { maxStores: limit }).map((p) => p.basketCostCents));

  assert.equal(cheapestAt(1), 1900, 'one store: 100 + 900 + 900');
  assert.equal(cheapestAt(2), 1100, 'two stores: 100 + 100 + 900');
  assert.equal(cheapestAt(3), 300, 'three stores: 100 each');
});

test('the search radius excludes distant stores entirely', () => {
  const stores = [store('near', 1), store('far', 9)];
  const products = [
    makeProduct({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 900 }),
    makeProduct({ id: 'far-milk', concept: 'milk', storeId: 'far', price: 100 }),
  ];
  const list = listOf([{ concept: 'milk' }]);

  const tight = plan(list, stores, products, { radiusMiles: 5 });
  assert.ok(tight.every((entry) => entry.stops.every((stop) => stop.store.id === 'near')));

  const wide = plan(list, stores, products, { radiusMiles: 10 });
  assert.ok(wide.some((entry) => entry.stops.some((stop) => stop.store.id === 'far')));
});

test('no store inside the radius yields no plans', () => {
  const plans = plan(
    listOf([{ concept: 'milk' }]),
    [store('far', 40)],
    [makeProduct({ id: 'f', concept: 'milk', storeId: 'far', price: 100 })],
    { radiusMiles: 5 },
  );
  assert.deepEqual(plans, []);
});

test('transport mode changes time and travel cost', () => {
  const stores = [store('a', 3)];
  const products = [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 })];
  const list = listOf([{ concept: 'milk' }]);

  const drive = plan(list, stores, products, { transportMode: 'drive' })[0];
  const walk = plan(list, stores, products, { transportMode: 'walk' })[0];
  assert.ok(drive && walk);
  assert.ok(walk.etaMinutes > drive.etaMinutes, 'walking six miles takes longer');
  assert.ok(drive.travelCostCents > 0, 'driving has a per-mile cost');
  assert.equal(walk.travelCostCents, 0, 'walking has no fare, and none is invented');
  assert.equal(drive.basketCostCents, walk.basketCostCents, 'transport never changes the basket');
});

test('transit fare is not invented', () => {
  const plans = plan(
    listOf([{ concept: 'milk' }]),
    [store('a', 3)],
    [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 })],
    { transportMode: 'transit' },
  );
  assert.equal(plans[0]?.travelCostCents, 0, 'no fare model means no fare figure');
});

test('the convenience preference reweights effort without touching prices', () => {
  const stores = [store('near', 0.5), store('far', 7)];
  const products = [
    makeProduct({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 500 }),
    makeProduct({ id: 'far-milk', concept: 'milk', storeId: 'far', price: 300 }),
  ];
  const list = listOf([{ concept: 'milk' }]);

  const priceFirst = kindOf(
    plan(list, stores, products, { conveniencePreference: 0 }),
    'recommended',
  );
  const convenienceFirst = kindOf(
    plan(list, stores, products, { conveniencePreference: 1 }),
    'recommended',
  );

  assert.equal(priceFirst?.stops[0]?.store.id, 'far', 'ignoring effort chases the cheapest basket');
  assert.equal(convenienceFirst?.stops[0]?.store.id, 'near', 'valuing convenience stays close');
});

test('the effort weight is derived from the preference', () => {
  // Both documented anchors: 0.5 weights effort at face value, 1 weights it double.
  assert.equal(effortWeightFor({ ...prefs, conveniencePreference: 0.5 }), 1);
  assert.equal(effortWeightFor({ ...prefs, conveniencePreference: 1 }), 2);
  assert.equal(effortWeightFor({ ...prefs, conveniencePreference: 5 }), 2, 'clamped');
  assert.equal(effortWeightFor({ ...prefs, conveniencePreference: 0.35 }), 0.7);
});

test('the effort weight never reaches zero, so a trip is never free to the ranking', () => {
  // At weight zero a 12-mile round trip cost the ranking nothing, and a 30c cheaper
  // line won it. "The lowest total, always" has to include the driving.
  assert.equal(effortWeightFor({ ...prefs, conveniencePreference: 0 }), MIN_EFFORT_WEIGHT);
  assert.equal(effortWeightFor({ ...prefs, conveniencePreference: -3 }), MIN_EFFORT_WEIGHT);
  assert.ok(MIN_EFFORT_WEIGHT > 0);
  // The floor binds only at the very bottom; above 0.1 the linear rule takes over.
  assert.equal(effortWeightFor({ ...prefs, conveniencePreference: 0.1 }), MIN_EFFORT_WEIGHT);
  assert.equal(effortWeightFor({ ...prefs, conveniencePreference: 0.2 }), 0.4);
});

test('brand flexibility changes what the plan buys', () => {
  const stores = [store('a', 1)];
  const products = [
    makeProduct({ id: 'a-name', concept: 'milk', storeId: 'a', price: 500, brand: 'Grove' }),
    makeProduct({ id: 'a-own', concept: 'milk', storeId: 'a', price: 300, brand: 'Store Own' }),
  ];
  const list = listOf([{ concept: 'milk', requestedBrand: 'Grove' }]);

  const exact = plan(list, stores, products, { brandPolicy: 'exact_product' })[0];
  const cheapest = plan(list, stores, products, { brandPolicy: 'cheapest' })[0];
  assert.equal(exact?.basketCostCents, 500, 'exact honours the request');
  assert.equal(cheapest?.basketCostCents, 300, 'cheapest substitutes freely');
});

test('flexible brand policy prefers the request unless the saving beats the penalty', () => {
  const stores = [store('a', 1)];
  const list = listOf([{ concept: 'milk', requestedBrand: 'Grove' }]);

  // 40c cheaper: less than the 60c preference penalty, so the brand is kept.
  const smallSaving = plan(
    list,
    stores,
    [
      makeProduct({ id: 'a-name', concept: 'milk', storeId: 'a', price: 500, brand: 'Grove' }),
      makeProduct({ id: 'a-own', concept: 'milk', storeId: 'a', price: 460, brand: 'Own' }),
    ],
    { brandPolicy: 'flexible' },
  )[0];
  assert.equal(smallSaving?.stops[0]?.items[0]?.productBrand, 'Grove');
  assert.equal(smallSaving?.basketCostCents, 500);

  // 100c cheaper: beats the penalty, so Juva substitutes.
  const bigSaving = plan(
    list,
    stores,
    [
      makeProduct({ id: 'a-name', concept: 'milk', storeId: 'a', price: 500, brand: 'Grove' }),
      makeProduct({ id: 'a-own', concept: 'milk', storeId: 'a', price: 400, brand: 'Own' }),
    ],
    { brandPolicy: 'flexible' },
  )[0];
  assert.equal(bigSaving?.stops[0]?.items[0]?.substitution, true);
  assert.equal(bigSaving?.basketCostCents, 400);
});

// ── Missing items ───────────────────────────────────────────────────────────

test('an item no store stocks is reported, not priced', () => {
  const stores = [store('a', 1)];
  const products = [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 })];
  const plans = plan(listOf([{ concept: 'milk' }, { concept: 'saffron' }]), stores, products);

  const recommended = kindOf(plans, 'recommended');
  assert.ok(recommended);
  assert.equal(recommended.complete, false);
  assert.equal(recommended.basketCostCents, 300, 'the missing item adds nothing to the total');
  assert.equal(recommended.missingItems.length, 1);
  assert.equal(recommended.missingItems[0]?.reason, 'not_stocked_nearby');
  assert.equal(recommended.missingItems[0]?.availableElsewhere, false);
});

test('an incomplete plan claims no saving', () => {
  const stores = [store('a', 1)];
  const products = [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 })];
  const plans = plan(listOf([{ concept: 'milk' }, { concept: 'saffron' }]), stores, products);

  for (const entry of plans) {
    assert.equal(entry.savingsVsBaselineCents, 0);
    assert.equal(entry.explanation.baselineKind, 'none');
    assert.match(entry.explanation.rationale, /no saving is claimed|could not be priced/);
  }
});

test('the missing-item penalty tips a close call toward completeness', () => {
  const stores = [store('complete', 2), store('partial', 1)];
  const products = [
    makeProduct({ id: 'c-milk', concept: 'milk', storeId: 'complete', price: 250 }),
    makeProduct({ id: 'c-bread', concept: 'bread', storeId: 'complete', price: 250 }),
    // Cheaper and closer, but cannot supply bread at all.
    makeProduct({ id: 'x-milk', concept: 'milk', storeId: 'partial', price: 200 }),
  ];
  const plans = plan(listOf([{ concept: 'milk' }, { concept: 'bread' }]), stores, products, {
    maxStores: 1,
  });
  const recommended = kindOf(plans, 'recommended');
  assert.ok(recommended);
  assert.equal(recommended.complete, true, 'the cost of a second trip decides it');
  assert.equal(recommended.stops[0]?.store.id, 'complete');
});

test('no price gap lets a partial basket win the recommendation', () => {
  // A partial basket is cheaper for the wrong reason — it is missing something. So
  // however large the gap, it cannot be Juva's Pick while a complete basket exists.
  // Previously the missing-item penalty made this a merely-expensive outcome rather
  // than an impossible one, and a $79 gap was enough to recommend a basket with no
  // bread in it. Completeness is now a gate, not a weight.
  const stores = [store('complete', 2), store('partial', 1)];
  const products = [
    makeProduct({ id: 'c-milk', concept: 'milk', storeId: 'complete', price: 4000 }),
    makeProduct({ id: 'c-bread', concept: 'bread', storeId: 'complete', price: 4000 }),
    makeProduct({ id: 'x-milk', concept: 'milk', storeId: 'partial', price: 100 }),
  ];
  const plans = plan(listOf([{ concept: 'milk' }, { concept: 'bread' }]), stores, products, {
    maxStores: 1,
  });
  const recommended = kindOf(plans, 'recommended');
  assert.ok(recommended);
  assert.equal(recommended.complete, true, 'a complete basket exists, so it wins by rule');
  assert.equal(recommended.stops[0]?.store.id, 'complete');
  // The penalty still exists and is still visible — it is simply no longer what
  // decides this case.
  assert.equal(recommended.explanation.score.missingItemPenaltyCents, 0);
  assert.equal(recommended.completeness.comparisonEligible, true);
});

test('a partial plan is the recommendation only when nothing complete exists', () => {
  const stores = [store('partial', 1)];
  const products = [makeProduct({ id: 'x-milk', concept: 'milk', storeId: 'partial', price: 100 })];
  const plans = plan(listOf([{ concept: 'milk' }, { concept: 'bread' }]), stores, products, {
    maxStores: 1,
  });
  const recommended = kindOf(plans, 'recommended');
  assert.ok(recommended, 'a partial answer beats no answer');
  assert.equal(recommended.complete, false);
  // But it may not take part in any price comparison.
  assert.equal(recommended.completeness.comparisonEligible, false);
  assert.equal(recommended.savingsVsBaselineCents, 0);
  assert.equal(recommended.explanation.baselineKind, 'none');
  assert.match(recommended.explanation.rationale, /could not be priced/);
});

test('the missing-item penalty scales with how many lines are unfilled', () => {
  const stores = [store('a', 1)];
  const products = [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 })];
  const plans = plan(
    listOf([{ concept: 'milk' }, { concept: 'saffron' }, { concept: 'truffle' }]),
    stores,
    products,
  );
  assert.equal(plans[0]?.explanation.score.missingItemPenaltyCents, 800, 'two missing at 400 each');
});

test('an item stocked elsewhere is flagged as available elsewhere', () => {
  const stores = [store('a', 1), store('b', 2)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 }),
    makeProduct({ id: 'b-bread', concept: 'bread', storeId: 'b', price: 300 }),
  ];
  const plans = plan(listOf([{ concept: 'milk' }, { concept: 'bread' }]), stores, products, {
    maxStores: 1,
  });
  const withGap = plans.find((entry) => entry.missingItems.length > 0);
  assert.ok(withGap);
  assert.equal(withGap.missingItems[0]?.availableElsewhere, true);
});

test('an out-of-stock product is reported as unavailable, not absent', () => {
  const stores = [store('a', 1)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 }),
    makeProduct({ id: 'a-bread', concept: 'bread', storeId: 'a', price: 300, available: false }),
  ];
  const plans = plan(listOf([{ concept: 'milk' }, { concept: 'bread' }]), stores, products);
  const recommended = kindOf(plans, 'recommended');
  assert.equal(recommended?.missingItems[0]?.reason, 'unavailable');
});

test('an unfulfillable exact brand is reported as a brand requirement', () => {
  const stores = [store('a', 1)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300, brand: 'Other' }),
  ];
  const plans = plan(
    listOf([{ concept: 'milk', requestedBrand: 'Grove', brandPolicy: 'exact_product' }]),
    stores,
    products,
  );
  assert.deepEqual(plans, [], 'a basket with no fillable line yields no plan');
});

test('a currency mismatch is reported rather than converted', () => {
  const stores = [store('a', 1)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 }),
    makeProduct({ id: 'a-bread', concept: 'bread', storeId: 'a', price: 300, currency: 'EUR' }),
  ];
  const plans = plan(listOf([{ concept: 'milk' }, { concept: 'bread' }]), stores, products);
  const recommended = kindOf(plans, 'recommended');
  assert.equal(recommended?.missingItems[0]?.reason, 'currency_mismatch');
  assert.equal(recommended?.basketCostCents, 300, 'a euro price never enters a dollar basket');
});

// ── Stale data ──────────────────────────────────────────────────────────────

test('a stale bargain can lose to a fresh price', () => {
  const stores = [store('a', 1), store('b', 1)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 400, freshness: 'live' }),
    // 100c cheaper but needs verifying: the 150c risk penalty outweighs it.
    makeProduct({ id: 'b-milk', concept: 'milk', storeId: 'b', price: 300, freshness: 'verify' }),
  ];
  const plans = plan(listOf([{ concept: 'milk' }]), stores, products);
  const recommended = kindOf(plans, 'recommended');
  assert.equal(recommended?.stops[0]?.store.id, 'a', 'a price that may have moved is discounted');
  assert.equal(recommended?.explanation.score.staleDataPenaltyCents, 0);
});

test('a big enough saving still beats the staleness penalty', () => {
  const stores = [store('a', 1), store('b', 1)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 400, freshness: 'live' }),
    makeProduct({ id: 'b-milk', concept: 'milk', storeId: 'b', price: 100, freshness: 'verify' }),
  ];
  const recommended = kindOf(plan(listOf([{ concept: 'milk' }]), stores, products), 'recommended');
  assert.equal(recommended?.stops[0]?.store.id, 'b');
  assert.equal(recommended?.explanation.score.staleDataPenaltyCents, 150);
});

test('a plan reports its weakest freshness, not its best', () => {
  const stores = [store('a', 1)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300, freshness: 'live' }),
    makeProduct({ id: 'a-bread', concept: 'bread', storeId: 'a', price: 300, freshness: 'older' }),
  ];
  const plans = plan(listOf([{ concept: 'milk' }, { concept: 'bread' }]), stores, products);
  assert.equal(plans[0]?.weakestFreshness, 'older');
  assert.match(plans[0]?.explanation.rationale ?? '', /need checking in store/);
});

test('the stale penalty never enters the basket cost or the saving', () => {
  const stores = [store('a', 1)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300, freshness: 'verify' }),
  ];
  const plans = plan(listOf([{ concept: 'milk' }]), stores, products);
  assert.equal(plans[0]?.basketCostCents, 300);
  assert.ok((plans[0]?.explanation.score.staleDataPenaltyCents ?? 0) > 0);
});

// ── Score composition ───────────────────────────────────────────────────────

test('the score is the weighted sum of its published components', () => {
  const stores = [store('a', 1), store('b', 2)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300, freshness: 'recent' }),
    makeProduct({ id: 'b-bread', concept: 'bread', storeId: 'b', price: 300, freshness: 'older' }),
  ];
  const plans = plan(listOf([{ concept: 'milk' }, { concept: 'bread' }]), stores, products);

  for (const entry of plans) {
    const score = entry.explanation.score;
    const effort = score.travelCostCents + score.travelTimeCostCents + score.extraStopPenaltyCents;
    const expected = Math.round(
      score.basketCostCents +
        effort * score.effortWeight +
        score.staleDataPenaltyCents +
        score.missingItemPenaltyCents +
        score.uncertaintyPenaltyCents,
    );
    assert.equal(score.totalCents, expected, `${entry.kind} score must be reproducible`);
  }
});

test('the extra-stop penalty scales with the number of stops', () => {
  const stores = [store('a', 1), store('b', 1.1)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 100 }),
    makeProduct({ id: 'b-bread', concept: 'bread', storeId: 'b', price: 100 }),
    makeProduct({ id: 'a-bread', concept: 'bread', storeId: 'a', price: 300 }),
  ];
  const plans = plan(listOf([{ concept: 'milk' }, { concept: 'bread' }]), stores, products);
  const single = plans.find((entry) => entry.stops.length === 1);
  const multi = plans.find((entry) => entry.stops.length === 2);
  assert.ok(single && multi);
  assert.equal(single.explanation.score.extraStopPenaltyCents, 0);
  assert.equal(multi.explanation.score.extraStopPenaltyCents, prefs.extraStopPenaltyCents);
});

test('geometry is out and back, plus a hop per extra stop', () => {
  const stops = [
    { store: store('a', 1), items: [], subtotalCents: 0 },
    { store: store('b', 3), items: [], subtotalCents: 0 },
  ];
  const geometry = estimateGeometry(stops, prefs);
  assert.equal(geometry.travelMiles, 7.35, '3 x 2 furthest, plus 1.35 for the extra stop');
  assert.ok(geometry.etaMinutes > 0);
  assert.equal(estimateGeometry([], prefs).travelMiles, 0);
});

// ── Determinism and edge cases ──────────────────────────────────────────────

test('planning is deterministic for identical input', () => {
  const stores = [store('a', 1), store('b', 2), store('c', 3)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 }),
    makeProduct({ id: 'b-milk', concept: 'milk', storeId: 'b', price: 300 }),
    makeProduct({ id: 'c-milk', concept: 'milk', storeId: 'c', price: 300 }),
    makeProduct({ id: 'a-bread', concept: 'bread', storeId: 'a', price: 200 }),
    makeProduct({ id: 'b-bread', concept: 'bread', storeId: 'b', price: 200 }),
  ];
  const list = listOf([{ concept: 'milk' }, { concept: 'bread' }]);
  assert.deepEqual(plan(list, stores, products), plan(list, stores, products));
});

test('identically priced options resolve stably rather than arbitrarily', () => {
  const stores = [store('a', 1), store('b', 1)];
  const products = [
    makeProduct({ id: 'z-milk', concept: 'milk', storeId: 'a', price: 300 }),
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'b', price: 300 }),
  ];
  const list = listOf([{ concept: 'milk' }]);
  const first = plan(list, stores, products);
  const second = plan(list, stores, products);
  assert.equal(first[0]?.id, second[0]?.id);
});

test('an empty basket yields no plans', () => {
  assert.deepEqual(plan(listOf([]), [store('a', 1)], []), []);
});

test('a market with no products yields no plans', () => {
  assert.deepEqual(plan(listOf([{ concept: 'milk' }]), [store('a', 1)], []), []);
});

test('every money figure is an integer number of cents', () => {
  const stores = [store('a', 1.3), store('b', 2.7)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 333, size: '750 ml' }),
    makeProduct({ id: 'b-bread', concept: 'bread', storeId: 'b', price: 177, size: '17 oz' }),
  ];
  const plans = plan(
    listOf([{ concept: 'milk', unit: '1 l' }, { concept: 'bread' }]),
    stores,
    products,
  );

  for (const entry of plans) {
    for (const value of [
      entry.basketCostCents,
      entry.travelCostCents,
      entry.effectiveCostCents,
      entry.savingsVsBaselineCents,
      entry.comparedBaselineCents,
    ]) {
      assert.ok(Number.isInteger(value), `${entry.kind}: ${value} must be integer cents`);
    }
    for (const stop of entry.stops) {
      assert.ok(Number.isInteger(stop.subtotalCents));
      for (const line of stop.items) {
        assert.ok(Number.isInteger(line.lineTotalCents));
        assert.ok(Number.isInteger(line.listTotalCents));
        assert.ok(Number.isInteger(line.unitPriceCents));
      }
    }
  }
});

test('stop subtotals always sum to the basket cost', () => {
  const stores = [store('a', 1), store('b', 2), store('c', 3)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 311 }),
    makeProduct({ id: 'b-bread', concept: 'bread', storeId: 'b', price: 217 }),
    makeProduct({ id: 'c-eggs', concept: 'eggs', storeId: 'c', price: 419 }),
  ];
  const plans = plan(
    listOf([{ concept: 'milk' }, { concept: 'bread' }, { concept: 'eggs' }]),
    stores,
    products,
  );
  for (const entry of plans) {
    const sum = entry.stops.reduce((total, stop) => total + stop.subtotalCents, 0);
    assert.equal(entry.basketCostCents, sum, entry.kind);
  }
});

test('a store contributing nothing never appears as a stop', () => {
  const stores = [store('a', 1), store('idle', 2)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 100 }),
    // Present but always dearer, so it should never earn a stop.
    makeProduct({ id: 'idle-milk', concept: 'milk', storeId: 'idle', price: 900 }),
  ];
  const plans = plan(listOf([{ concept: 'milk' }]), stores, products);
  for (const entry of plans) {
    assert.ok(entry.stops.every((stop) => stop.items.length > 0));
    assert.ok(!entry.stops.some((stop) => stop.store.id === 'idle'));
  }
});

test('quantities above one multiply the line, not the basket', () => {
  const stores = [store('a', 1)];
  const products = [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 250 })];
  const plans = plan(listOf([{ concept: 'milk', quantity: 3 }]), stores, products);
  assert.equal(plans[0]?.basketCostCents, 750);
  assert.equal(plans[0]?.stops[0]?.items[0]?.quantity, 3);
});

test('pack-size comparison picks the cheaper way to reach the requested amount', () => {
  const stores = [store('a', 1)];
  const products = [
    // A single gallon at 4.99, or two half-gallons at 2.20 each (4.40 total).
    makeProduct({ id: 'a-gal', concept: 'milk', storeId: 'a', price: 499, size: '1 gal' }),
    makeProduct({ id: 'a-half', concept: 'milk', storeId: 'a', price: 220, size: '64 fl oz' }),
  ];
  const plans = plan(listOf([{ concept: 'milk', unit: '1 gal' }]), stores, products);
  const line = plans[0]?.stops[0]?.items[0];
  assert.equal(line?.retailerProductId, 'a-half');
  assert.equal(line?.quantity, 2);
  assert.equal(plans[0]?.basketCostCents, 440);
});

test('a comparison unit price is exposed for the shopper', () => {
  const stores = [store('a', 1)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 250, size: '500 g' }),
  ];
  const line = plan(listOf([{ concept: 'milk', unit: '500 g' }]), stores, products)[0]?.stops[0]
    ?.items[0];
  assert.equal(line?.comparisonUnitPriceCents, 500);
  assert.equal(line?.comparisonUnitLabel, 'per kg');
});

test('weighed goods are billed by the amount taken', () => {
  const stores = [store('a', 1)];
  const products = [
    makeProduct({
      id: 'a-chicken',
      concept: 'chicken breast',
      storeId: 'a',
      price: 399,
      size: '1 lb',
      soldByWeight: true,
    }),
  ];
  const plans = plan(listOf([{ concept: 'chicken breast', unit: '~2.5 lb' }]), stores, products);
  const line = plans[0]?.stops[0]?.items[0];
  assert.equal(line?.packBasis, 'weighed');
  assert.equal(line?.quantity, 2.5);
  assert.equal(plans[0]?.basketCostCents, 998, '399 x 2.5 = 997.5, rounded once');
});

test('promotions reduce the basket and are reported per line', () => {
  const promo: Promotion = {
    id: 'p-loyal',
    retailerId: 'a',
    label: '$1 off with card',
    loyaltyRequired: true,
    amountOffCents: 100,
  };
  const stores = [store('a', 1)];
  const products = [
    makeProduct({
      id: 'a-milk',
      concept: 'milk',
      storeId: 'a',
      price: 400,
      promotionId: 'p-loyal',
    }),
  ];
  const list = listOf([{ concept: 'milk' }]);

  const without = plan(list, stores, products, { loyaltyRetailers: [] }, [promo]);
  assert.equal(without[0]?.basketCostCents, 400);
  assert.match(without[0]?.stops[0]?.items[0]?.promotionLabel ?? '', /requires a loyalty card/);

  const holding = plan(list, stores, products, { loyaltyRetailers: ['a'] }, [promo]);
  assert.equal(holding[0]?.basketCostCents, 300);
  assert.equal(holding[0]?.stops[0]?.items[0]?.promotionSavingsCents, 100);
});

test('substitution savings are measured against the requested brand at that store', () => {
  const stores = [store('a', 1)];
  const products = [
    makeProduct({ id: 'a-name', concept: 'milk', storeId: 'a', price: 600, brand: 'Grove' }),
    makeProduct({ id: 'a-own', concept: 'milk', storeId: 'a', price: 400, brand: 'Own' }),
  ];
  const plans = plan(listOf([{ concept: 'milk', requestedBrand: 'Grove' }]), stores, products, {
    brandPolicy: 'flexible',
  });
  const line = plans[0]?.stops[0]?.items[0];
  assert.equal(line?.substitution, true);
  assert.equal(line?.substitutionSavingsCents, 200, '600 requested minus 400 chosen');
});

test('no substitution saving is claimed when the requested brand was never seen', () => {
  const stores = [store('a', 1)];
  const products = [
    makeProduct({ id: 'a-own', concept: 'milk', storeId: 'a', price: 400, brand: 'Own' }),
  ];
  const plans = plan(listOf([{ concept: 'milk', requestedBrand: 'Grove' }]), stores, products, {
    brandPolicy: 'flexible',
  });
  const line = plans[0]?.stops[0]?.items[0];
  assert.equal(line?.substitution, true);
  assert.equal(line?.substitutionSavingsCents, 0, 'an unobserved brand yields no saving');
});
