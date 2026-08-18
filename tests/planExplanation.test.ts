import assert from 'node:assert/strict';
import { test } from 'node:test';

import { demoPreferences } from '../src/domain/demoMarket';
import {
  CONFIDENCE_BASE_PERMILLE,
  UNKNOWN_AVAILABILITY_PENALTY_CENTS,
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
 * The explanation half of the optimizer: completeness, confidence, baselines,
 * tradeoffs, rejected candidates and route inputs.
 *
 * These are the tests that keep Juva honest rather than the ones that keep it
 * cheap. `planning.test.ts` covers what the engine picks; this file covers whether
 * it can justify the pick, and — more importantly — whether it refuses to make a
 * savings claim it has not earned.
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
  confidence?: number;
  freshness?: RetailerProduct['observation']['freshness'];
  availability?: RetailerProduct['observation']['availability'];
  promotionId?: string;
  currency?: 'USD' | 'EUR';
}

function makeProduct(spec: ProductSpec): RetailerProduct {
  return {
    id: spec.id,
    canonicalConcept: spec.concept,
    storeId: spec.storeId,
    title: `${spec.concept} at ${spec.storeId}`,
    brand: spec.brand ?? 'Generic',
    sizeLabel: '1 ct',
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
      confidence: spec.confidence ?? 0.9,
      available: true,
      availability: spec.availability ?? 'in_stock',
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
  extra: { promotions?: Promotion[]; usualStoreId?: string; previousBasketCents?: number } = {},
): OptimizedPlan[] {
  return optimizeBasket({
    list,
    stores,
    products,
    promotions: extra.promotions ?? [],
    preferences: { ...prefs, ...overrides },
    now: NOW,
    ...(extra.usualStoreId === undefined ? {} : { usualStoreId: extra.usualStoreId }),
    ...(extra.previousBasketCents === undefined
      ? {}
      : { previousRecurringBasketCents: extra.previousBasketCents }),
  });
}

/**
 * Finds a plan by kind, falling back to the only plan when a market has just one.
 *
 * A market with a single viable trip produces a single plan, and `dedupePlans`
 * labels it with the highest-priority kind that selected it — `recommended`. So
 * asking for `cheapest_single_store` in a one-store fixture would find nothing even
 * though that trip *is* the cheapest single store. The fallback is only safe
 * because it requires there to be exactly one plan.
 */
function kindOf(plans: OptimizedPlan[], kind: PlanKind): OptimizedPlan | undefined {
  return plans.find((entry) => entry.kind === kind) ?? (plans.length === 1 ? plans[0] : undefined);
}

/** A two-item basket one store can fill completely. */
function completeMarket(): { stores: Store[]; products: RetailerProduct[]; list: GroceryList } {
  return {
    stores: [store('a', 1), store('b', 3)],
    products: [
      makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 }),
      makeProduct({ id: 'a-bread', concept: 'bread', storeId: 'a', price: 400 }),
      makeProduct({ id: 'b-milk', concept: 'milk', storeId: 'b', price: 250 }),
      makeProduct({ id: 'b-bread', concept: 'bread', storeId: 'b', price: 300 }),
    ],
    list: listOf([{ concept: 'milk' }, { concept: 'bread' }]),
  };
}

// ── Completeness: COMPLETE vs PARTIAL ───────────────────────────────────────

test('a complete plan reports every line priced and is comparable', () => {
  const { stores, products, list } = completeMarket();
  const entry = kindOf(plan(list, stores, products), 'cheapest_single_store');
  assert.ok(entry);
  const { completeness } = entry;
  assert.equal(completeness.requestedItemCount, 2);
  assert.equal(completeness.pricedItemCount, 2);
  assert.equal(completeness.complete, true);
  assert.equal(completeness.comparisonEligible, true);
  assert.deepEqual(completeness.unresolvedConcepts, []);
  assert.deepEqual(completeness.remediations, []);
  assert.equal(completeness.ineligibleReason, undefined);
});

test('a partial plan reports X of Y and names what it could not price', () => {
  const plans = plan(
    listOf([{ concept: 'milk' }, { concept: 'bread', displayName: 'Sourdough' }]),
    [store('a', 1)],
    [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 })],
  );
  const entry = plans[0];
  assert.ok(entry);
  assert.equal(entry.completeness.requestedItemCount, 2);
  assert.equal(entry.completeness.pricedItemCount, 1);
  assert.equal(entry.completeness.complete, false);
  assert.deepEqual(entry.completeness.unresolvedConcepts, ['Sourdough']);
});

test('a partial plan is never comparison eligible, and says why', () => {
  const plans = plan(
    listOf([{ concept: 'milk' }, { concept: 'saffron' }]),
    [store('a', 1)],
    [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 })],
  );
  const entry = plans[0];
  assert.ok(entry);
  assert.equal(entry.completeness.comparisonEligible, false);
  assert.match(String(entry.completeness.ineligibleReason), /1 of 2 items/);
  assert.match(String(entry.completeness.ineligibleReason), /priced subtotal/);
});

test('a partial plan claims no saving even when a complete baseline exists elsewhere', () => {
  // The dangerous case: store `b` can fill the basket for $9, store `a` prices only
  // the milk at $1. Subtracting those two numbers would advertise an $8 saving on a
  // basket that is missing the bread.
  const stores = [store('a', 1), store('b', 2)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 100 }),
    makeProduct({ id: 'b-milk', concept: 'milk', storeId: 'b', price: 500 }),
    makeProduct({ id: 'b-bread', concept: 'bread', storeId: 'b', price: 400 }),
  ];
  const plans = plan(listOf([{ concept: 'milk' }, { concept: 'bread' }]), stores, products, {
    maxStores: 1,
  });
  for (const entry of plans) {
    if (entry.completeness.complete) continue;
    assert.equal(entry.savingsVsBaselineCents, 0, 'a partial plan never claims a saving');
    for (const baseline of entry.baselines) {
      assert.equal(baseline.savingsCents, 0, 'not against any baseline, not just the default');
    }
  }
});

test('the priced subtotal equals the basket total only for a complete plan', () => {
  const { stores, products, list } = completeMarket();
  const complete = kindOf(plan(list, stores, products), 'cheapest_single_store');
  assert.ok(complete);
  assert.equal(complete.pricedSubtotalCents, complete.basketCostCents);

  const partial = plan(
    listOf([{ concept: 'milk' }, { concept: 'saffron' }]),
    [store('a', 1)],
    [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 })],
  )[0];
  assert.ok(partial);
  // The figure is the same number; what differs is that it is labelled a subtotal
  // and the plan is barred from comparison.
  assert.equal(partial.pricedSubtotalCents, 300);
  assert.equal(partial.completeness.comparisonEligible, false);
});

test('a partial plan states its subtotal is not a basket total', () => {
  const plans = plan(
    listOf([{ concept: 'milk' }, { concept: 'saffron' }]),
    [store('a', 1)],
    [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 })],
  );
  const entry = plans[0];
  assert.ok(entry);
  assert.match(entry.explanation.rationale, /1 of 2 items/);
  assert.match(entry.explanation.rationale, /priced subtotal, not a basket total/);
  assert.match(entry.explanation.rationale, /no saving is claimed/);
});

test('remediations point at the radius when the item is stocked out of reach', () => {
  const stores = [store('near', 1), store('far', 40)];
  const products = [
    makeProduct({ id: 'near-milk', concept: 'milk', storeId: 'near', price: 300 }),
    makeProduct({ id: 'far-bread', concept: 'bread', storeId: 'far', price: 300 }),
  ];
  const plans = plan(listOf([{ concept: 'milk' }, { concept: 'bread' }]), stores, products, {
    radiusMiles: 5,
  });
  const entry = plans[0];
  assert.ok(entry);
  assert.ok(entry.completeness.remediations.includes('widen_radius'));
});

test('remediations offer substitutions when an exact brand rule caused the gap', () => {
  const plans = plan(
    listOf([{ concept: 'milk' }, { concept: 'bread', requestedBrand: 'Nonesuch' }]),
    [store('a', 1)],
    [
      makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 }),
      makeProduct({ id: 'a-bread', concept: 'bread', storeId: 'a', price: 300, brand: 'Other' }),
    ],
    { brandPolicy: 'exact_product' },
  );
  const entry = plans[0];
  assert.ok(entry);
  assert.ok(entry.completeness.remediations.includes('allow_substitutions'));
});

test('retrying providers is always offered last, never first', () => {
  const plans = plan(
    listOf([{ concept: 'milk' }, { concept: 'saffron' }]),
    [store('a', 1)],
    [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 })],
  );
  const remediations = plans[0]?.completeness.remediations ?? [];
  assert.ok(remediations.includes('retry_providers'));
  assert.notEqual(remediations[0], 'retry_providers', 'thin coverage is not the shopper’s fault');
  assert.ok(remediations.includes('remove_unpriced_items'));
});

// ── Baselines ───────────────────────────────────────────────────────────────

test('the default baseline is the cheapest complete single store', () => {
  const { stores, products, list } = completeMarket();
  const entry = kindOf(plan(list, stores, products), 'recommended');
  assert.ok(entry);
  const chosen = entry.baselines.find((baseline) => baseline.isDefault);
  assert.ok(chosen);
  assert.equal(chosen.kind, 'cheapest_complete_single_store');
  // Store `b` fills the basket for $5.50 against `a`'s $7.00.
  assert.equal(chosen.cents, 550);
  assert.equal(chosen.storeId, 'b');
});

test('exactly one baseline is ever the default', () => {
  const { stores, products, list } = completeMarket();
  const plans = plan(list, stores, products, {}, { usualStoreId: 'a', previousBasketCents: 2000 });
  for (const entry of plans) {
    assert.equal(entry.baselines.filter((baseline) => baseline.isDefault).length, 1);
  }
});

test('the usual store is offered as an alternate baseline, not as the default', () => {
  const { stores, products, list } = completeMarket();
  const entry = kindOf(
    plan(list, stores, products, {}, { usualStoreId: 'a' }),
    'cheapest_single_store',
  );
  assert.ok(entry);
  const usual = entry.baselines.find((baseline) => baseline.kind === 'usual_store');
  assert.ok(usual, 'the usual store baseline is present');
  assert.equal(usual.cents, 700, 'store a fills the basket for $7.00');
  assert.equal(usual.isDefault, false);
});

test('the largest available saving is never silently chosen as the baseline', () => {
  // Store `a` at $7.00 would produce a $1.50 saving against the $5.50 winner, and
  // the previous basket at $20.00 would produce $14.50. The default stays the
  // cheapest-single-store rule regardless, which is the entire point.
  const { stores, products, list } = completeMarket();
  const entry = kindOf(
    plan(list, stores, products, {}, { usualStoreId: 'a', previousBasketCents: 2000 }),
    'cheapest_single_store',
  );
  assert.ok(entry);
  assert.equal(entry.explanation.baselineKind, 'cheapest_complete_single_store');
  assert.equal(entry.savingsVsBaselineCents, 0, 'the winner is the baseline, so no saving');

  const biggest = [...entry.baselines].sort((a, b) => b.savingsCents - a.savingsCents)[0];
  assert.ok(biggest);
  assert.equal(biggest.kind, 'previous_recurring_basket');
  assert.equal(biggest.savingsCents, 1450);
  assert.equal(biggest.isDefault, false, 'the flattering number is visible but not the headline');
});

test('a previous recurring basket becomes an alternate baseline', () => {
  const { stores, products, list } = completeMarket();
  const entry = kindOf(
    plan(list, stores, products, {}, { previousBasketCents: 900 }),
    'cheapest_single_store',
  );
  assert.ok(entry);
  const previous = entry.baselines.find(
    (baseline) => baseline.kind === 'previous_recurring_basket',
  );
  assert.ok(previous);
  assert.equal(previous.cents, 900);
  assert.equal(previous.savingsCents, 350, '$9.00 last time against $5.50 now');
});

test('a usual store that cannot fill the basket is not offered as a baseline', () => {
  // Comparing against a shop that would have sent the shopper home without the
  // bread is not a comparison.
  const stores = [store('a', 1), store('b', 2)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 }),
    makeProduct({ id: 'b-milk', concept: 'milk', storeId: 'b', price: 320 }),
    makeProduct({ id: 'b-bread', concept: 'bread', storeId: 'b', price: 300 }),
  ];
  const plans = plan(
    listOf([{ concept: 'milk' }, { concept: 'bread' }]),
    stores,
    products,
    {},
    {
      usualStoreId: 'a',
    },
  );
  assert.ok(plans.length > 0);
  for (const entry of plans) {
    assert.equal(
      entry.baselines.some((baseline) => baseline.kind === 'usual_store'),
      false,
      'store a cannot supply bread, so it is not a basket to compare against',
    );
  }
});

test('an unpriceable basket yields the none baseline and no saving anywhere', () => {
  const plans = plan(
    listOf([{ concept: 'milk' }, { concept: 'saffron' }]),
    [store('a', 1)],
    [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 })],
  );
  const entry = plans[0];
  assert.ok(entry);
  assert.equal(entry.explanation.baselineKind, 'none');
  assert.equal(entry.comparedBaselineCents, 0);
  assert.equal(entry.savingsVsBaselineCents, 0);
});

test('every baseline carries its own savings figure for the same plan', () => {
  const { stores, products, list } = completeMarket();
  const entry = kindOf(
    plan(list, stores, products, {}, { usualStoreId: 'a', previousBasketCents: 1000 }),
    'cheapest_single_store',
  );
  assert.ok(entry);
  assert.equal(entry.baselines.length, 3);
  for (const baseline of entry.baselines) {
    assert.equal(
      baseline.savingsCents,
      Math.max(0, baseline.cents - entry.basketCostCents),
      `${baseline.kind} savings must be its own subtraction`,
    );
  }
});

test('a saving is never negative, however dear the plan', () => {
  const { stores, products, list } = completeMarket();
  const entry = kindOf(
    plan(list, stores, products, {}, { previousBasketCents: 100 }),
    'cheapest_single_store',
  );
  assert.ok(entry);
  const previous = entry.baselines.find((b) => b.kind === 'previous_recurring_basket');
  assert.ok(previous);
  assert.equal(previous.savingsCents, 0, 'paying more than last time is not a negative saving');
});

// ── Juva Plan Confidence ────────────────────────────────────────────────────

test('confidence is exactly the base plus every published factor', () => {
  const { stores, products, list } = completeMarket();
  for (const entry of plan(list, stores, products)) {
    const detail = entry.confidenceDetail;
    const sum = detail.factors.reduce((total, factor) => total + factor.deltaPermille, 0);
    const expected = Math.min(1, Math.max(0, (detail.basePermille + sum) / 1000));
    assert.equal(detail.score, expected, `${entry.kind} confidence must reconstruct`);
    assert.equal(entry.confidence, detail.score, 'the shown number is the computed one');
  }
});

test('a fully exact, fresh basket reaches full confidence', () => {
  const entry = kindOf(
    plan(
      listOf([{ concept: 'milk' }]),
      [store('a', 1)],
      [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 })],
    ),
    'cheapest_single_store',
  );
  assert.ok(entry);
  assert.equal(entry.confidence, 1);
  assert.equal(entry.confidenceDetail.basePermille, CONFIDENCE_BASE_PERMILLE);
});

test('confidence counts exact matches against the total', () => {
  const { stores, products, list } = completeMarket();
  const entry = kindOf(plan(list, stores, products), 'cheapest_single_store');
  assert.ok(entry);
  const exact = entry.confidenceDetail.factors.find((f) => f.kind === 'exact_matches');
  assert.ok(exact);
  assert.equal(exact.count, 2);
  assert.match(exact.detail, /2 of 2 matched exactly/);
});

test('exact matches are counted against the whole request, not the priced part', () => {
  // Otherwise a partial plan claims "12 of 12 matched exactly" directly above "1
  // item could not be priced", which are both true and read as a contradiction.
  const plans = plan(
    listOf([{ concept: 'milk' }, { concept: 'bread' }, { concept: 'saffron' }]),
    [store('a', 1)],
    [
      makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 }),
      makeProduct({ id: 'a-bread', concept: 'bread', storeId: 'a', price: 300 }),
    ],
  );
  const exact = plans[0]?.confidenceDetail.factors.find((f) => f.kind === 'exact_matches');
  assert.ok(exact);
  assert.equal(exact.count, 2);
  assert.match(exact.detail, /2 of 3 matched exactly/);
});

test('stale prices lower confidence and say how many', () => {
  const entry = kindOf(
    plan(
      listOf([{ concept: 'milk' }, { concept: 'bread' }]),
      [store('a', 1)],
      [
        makeProduct({
          id: 'a-milk',
          concept: 'milk',
          storeId: 'a',
          price: 300,
          freshness: 'verify',
        }),
        makeProduct({
          id: 'a-bread',
          concept: 'bread',
          storeId: 'a',
          price: 300,
          freshness: 'demo',
        }),
      ],
    ),
    'cheapest_single_store',
  );
  assert.ok(entry);
  const stale = entry.confidenceDetail.factors.find((f) => f.kind === 'stale_prices');
  assert.ok(stale);
  assert.equal(stale.count, 1);
  assert.ok(stale.deltaPermille < 0);
  assert.ok(entry.confidence < 1);
});

test('an unpriced item is the heaviest single confidence factor', () => {
  const plans = plan(
    listOf([{ concept: 'milk' }, { concept: 'saffron' }]),
    [store('a', 1)],
    [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 })],
  );
  const detail = plans[0]?.confidenceDetail;
  assert.ok(detail);
  const unpriced = detail.factors.find((f) => f.kind === 'unpriced_items');
  assert.ok(unpriced);
  assert.equal(unpriced.count, 1);
  const heaviest = [...detail.factors].sort((a, b) => a.deltaPermille - b.deltaPermille)[0];
  assert.equal(heaviest?.kind, 'unpriced_items');
});

test('unknown availability lowers confidence without inventing stock', () => {
  const entry = kindOf(
    plan(
      listOf([{ concept: 'milk' }]),
      [store('a', 1)],
      [
        makeProduct({
          id: 'a-milk',
          concept: 'milk',
          storeId: 'a',
          price: 300,
          availability: 'unknown',
        }),
      ],
    ),
    'cheapest_single_store',
  );
  assert.ok(entry);
  const factor = entry.confidenceDetail.factors.find((f) => f.kind === 'unknown_availability');
  assert.ok(factor);
  assert.equal(factor.count, 1);
  assert.ok(entry.confidence < 1);
});

test('confidence never leaves the zero to one range', () => {
  // Nine unpriced lines at −150 permille each would take a raw score well negative.
  const plans = plan(
    listOf(
      Array.from({ length: 10 }, (_unused, index) => ({
        id: `i${index}`,
        concept: index === 0 ? 'milk' : `mystery${index}`,
      })),
    ),
    [store('a', 1)],
    [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 })],
  );
  const entry = plans[0];
  assert.ok(entry);
  assert.equal(entry.confidence, 0);
  assert.ok(entry.confidence >= 0 && entry.confidence <= 1);
});

test('every confidence factor states a count and a readable detail', () => {
  const plans = plan(
    listOf([{ concept: 'milk' }, { concept: 'saffron' }]),
    [store('a', 1)],
    [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300, freshness: 'older' })],
  );
  const detail = plans[0]?.confidenceDetail;
  assert.ok(detail);
  assert.ok(detail.factors.length > 0);
  for (const factor of detail.factors) {
    assert.ok(factor.count > 0, `${factor.kind} must count something`);
    assert.ok(factor.detail.length > 0, `${factor.kind} must be explainable`);
    assert.ok(Number.isInteger(factor.deltaPermille));
  }
});

// ── The uncertainty penalty ─────────────────────────────────────────────────

test('an uncertain match costs more to rank than a certain one', () => {
  const certain = kindOf(
    plan(
      listOf([{ concept: 'milk' }]),
      [store('a', 1)],
      [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 1000, confidence: 1 })],
    ),
    'cheapest_single_store',
  );
  const doubtful = kindOf(
    plan(
      listOf([{ concept: 'milk' }]),
      [store('a', 1)],
      [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 1000, confidence: 0.5 })],
    ),
    'cheapest_single_store',
  );
  assert.ok(certain && doubtful);
  assert.equal(certain.explanation.score.uncertaintyPenaltyCents, 0);
  // 1000c × 0.5 doubt × 0.35 rate = 175c.
  assert.equal(doubtful.explanation.score.uncertaintyPenaltyCents, 175);
  assert.equal(
    certain.basketCostCents,
    doubtful.basketCostCents,
    'the penalty never touches the price',
  );
  assert.ok(doubtful.effectiveCostCents > certain.effectiveCostCents);
});

test('the uncertainty penalty scales with the money on the line', () => {
  const cheap = kindOf(
    plan(
      listOf([{ concept: 'milk' }]),
      [store('a', 1)],
      [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 100, confidence: 0.5 })],
    ),
    'cheapest_single_store',
  );
  const dear = kindOf(
    plan(
      listOf([{ concept: 'milk' }]),
      [store('a', 1)],
      [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 2400, confidence: 0.5 })],
    ),
    'cheapest_single_store',
  );
  assert.ok(cheap && dear);
  assert.ok(
    dear.explanation.score.uncertaintyPenaltyCents >
      cheap.explanation.score.uncertaintyPenaltyCents,
    'being wrong about a $24 roast matters more than about a $1 onion',
  );
});

test('a store with no stock feed carries a fixed uncertainty penalty', () => {
  const entry = kindOf(
    plan(
      listOf([{ concept: 'milk' }]),
      [store('a', 1)],
      [
        makeProduct({
          id: 'a-milk',
          concept: 'milk',
          storeId: 'a',
          price: 300,
          confidence: 1,
          availability: 'unknown',
        }),
      ],
    ),
    'cheapest_single_store',
  );
  assert.ok(entry);
  assert.equal(entry.explanation.score.uncertaintyPenaltyCents, UNKNOWN_AVAILABILITY_PENALTY_CENTS);
});

test('the uncertainty penalty is a ranking term and never a price', () => {
  const entry = kindOf(
    plan(
      listOf([{ concept: 'milk' }]),
      [store('a', 1)],
      [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 1000, confidence: 0.4 })],
    ),
    'cheapest_single_store',
  );
  assert.ok(entry);
  assert.ok(entry.explanation.score.uncertaintyPenaltyCents > 0);
  assert.equal(entry.basketCostCents, 1000);
  assert.equal(entry.stops[0]?.subtotalCents, 1000);
  assert.equal(entry.savingsVsBaselineCents, 0);
});

// ── Rejected candidates ─────────────────────────────────────────────────────

test('a dearer product at the same store is recorded as rejected for being dearer', () => {
  const entry = kindOf(
    plan(
      listOf([{ concept: 'milk' }]),
      [store('a', 1)],
      [
        makeProduct({ id: 'a-milk-cheap', concept: 'milk', storeId: 'a', price: 300 }),
        makeProduct({ id: 'a-milk-dear', concept: 'milk', storeId: 'a', price: 500 }),
      ],
    ),
    'cheapest_single_store',
  );
  assert.ok(entry);
  const rejected = entry.explanation.rejectedCandidates;
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.retailerProductId, 'a-milk-dear');
  assert.equal(rejected[0]?.reason, 'dearer');
  assert.equal(rejected[0]?.lineTotalCents, 500);
});

test('another store in the same plan that could have supplied a line is recorded', () => {
  const stores = [store('a', 1), store('b', 1.1)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 }),
    makeProduct({ id: 'b-milk', concept: 'milk', storeId: 'b', price: 400 }),
    makeProduct({ id: 'b-bread', concept: 'bread', storeId: 'b', price: 100 }),
    makeProduct({ id: 'a-bread', concept: 'bread', storeId: 'a', price: 900 }),
  ];
  const multi = plan(listOf([{ concept: 'milk' }, { concept: 'bread' }]), stores, products).find(
    (entry) => entry.stops.length === 2,
  );
  assert.ok(multi);
  const ids = multi.explanation.rejectedCandidates.map((entry) => entry.retailerProductId);
  assert.ok(ids.includes('b-milk'), 'the milk Juva did not buy at the other stop');
  assert.ok(ids.includes('a-bread'));
});

test('a cheaper product excluded by brand policy is named as brand policy, not dearer', () => {
  const entry = kindOf(
    plan(
      listOf([{ concept: 'milk', requestedBrand: 'Alpine' }]),
      [store('a', 1)],
      [
        makeProduct({ id: 'a-alpine', concept: 'milk', storeId: 'a', price: 400, brand: 'Alpine' }),
        makeProduct({ id: 'a-store', concept: 'milk', storeId: 'a', price: 250, brand: 'Value' }),
      ],
      { brandPolicy: 'flexible' },
    ),
    'cheapest_single_store',
  );
  assert.ok(entry);
  const cheaper = entry.explanation.rejectedCandidates.find(
    (candidate) => candidate.retailerProductId === 'a-store',
  );
  if (cheaper) {
    assert.equal(
      cheaper.reason,
      'brand_policy',
      'calling a cheaper product "dearer" would be a lie',
    );
  } else {
    // The cheaper own-brand won on price; then the requested brand is the reject.
    const requested = entry.explanation.rejectedCandidates.find(
      (candidate) => candidate.retailerProductId === 'a-alpine',
    );
    assert.ok(requested);
    assert.equal(requested.reason, 'dearer');
  }
});

test('a wrong-currency product is recorded as rejected rather than converted', () => {
  const entry = kindOf(
    plan(
      listOf([{ concept: 'milk' }]),
      [store('a', 1)],
      [
        makeProduct({ id: 'a-usd', concept: 'milk', storeId: 'a', price: 300 }),
        makeProduct({ id: 'a-eur', concept: 'milk', storeId: 'a', price: 100, currency: 'EUR' }),
      ],
    ),
    'cheapest_single_store',
  );
  assert.ok(entry);
  const euro = entry.explanation.rejectedCandidates.find(
    (candidate) => candidate.retailerProductId === 'a-eur',
  );
  assert.ok(euro, 'the euro price must be visible as rejected, not silently gone');
  assert.equal(euro.reason, 'wrong_currency');
  assert.equal(entry.basketCostCents, 300);
});

test('an unrelated product is not listed as a rejected candidate', () => {
  // Every other item in the shop is not a decision Juva made. Listing them would
  // bury the ones that matter.
  const entry = kindOf(
    plan(
      listOf([{ concept: 'milk' }]),
      [store('a', 1)],
      [
        makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 }),
        makeProduct({ id: 'a-anvil', concept: 'anvil', storeId: 'a', price: 9900 }),
      ],
    ),
    'cheapest_single_store',
  );
  assert.ok(entry);
  assert.equal(entry.explanation.rejectedCandidates.length, 0);
});

test('rejected candidates are capped per line and ordered cheapest first', () => {
  const products = Array.from({ length: 9 }, (_unused, index) =>
    makeProduct({
      id: `a-milk-${index}`,
      concept: 'milk',
      storeId: 'a',
      price: 300 + index * 10,
    }),
  );
  const entry = kindOf(
    plan(listOf([{ concept: 'milk' }]), [store('a', 1)], products),
    'cheapest_single_store',
  );
  assert.ok(entry);
  const rejected = entry.explanation.rejectedCandidates;
  assert.equal(rejected.length, 4, 'capped so an explanation stays readable');
  const totals = rejected.map((candidate) => candidate.lineTotalCents);
  assert.deepEqual(
    totals,
    [...totals].sort((a, b) => a - b),
    'cheapest rejects are the interesting ones',
  );
});

test('every rejected candidate is traceable to a line, a store and a product', () => {
  const entry = kindOf(
    plan(
      listOf([{ concept: 'milk' }]),
      [store('a', 1)],
      [
        makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 }),
        makeProduct({ id: 'a-milk2', concept: 'milk', storeId: 'a', price: 400 }),
      ],
    ),
    'cheapest_single_store',
  );
  assert.ok(entry);
  for (const candidate of entry.explanation.rejectedCandidates) {
    assert.equal(candidate.groceryItemId, 'i1');
    assert.equal(candidate.storeId, 'a');
    assert.ok(candidate.retailerProductId.length > 0);
    assert.ok(candidate.productTitle.length > 0);
  }
});

// ── The rest of the explanation object ──────────────────────────────────────

test('the explanation names every store and every product chosen', () => {
  const { stores, products, list } = completeMarket();
  const entry = kindOf(plan(list, stores, products), 'cheapest_single_store');
  assert.ok(entry);
  assert.deepEqual(entry.explanation.storesSelected, ['b']);
  assert.equal(entry.explanation.productsChosen.length, 2);
  for (const chosen of entry.explanation.productsChosen) {
    assert.ok(chosen.groceryItemId.length > 0);
    assert.equal(chosen.storeId, 'b');
    assert.ok(chosen.retailerProductId.length > 0);
  }
});

test('products chosen line up exactly with the plan stops', () => {
  const { stores, products, list } = completeMarket();
  for (const entry of plan(list, stores, products)) {
    const fromStops = entry.stops
      .flatMap((stop) => stop.items)
      .map((item) => `${item.groceryItemId}@${item.storeId}:${item.retailerProductId}`)
      .sort();
    const fromExplanation = entry.explanation.productsChosen
      .map((chosen) => `${chosen.groceryItemId}@${chosen.storeId}:${chosen.retailerProductId}`)
      .sort();
    assert.deepEqual(fromExplanation, fromStops, `${entry.kind} explanation must match its trip`);
  }
});

test('route inputs publish the distance and time assumptions', () => {
  const { stores, products, list } = completeMarket();
  const entry = kindOf(plan(list, stores, products, { transportMode: 'walk' }), 'recommended');
  assert.ok(entry);
  const route = entry.explanation.routeInputs;
  assert.equal(route.transportMode, 'walk');
  assert.ok(route.minutesPerMile > 0);
  assert.ok(route.tripOverheadMinutes > 0);
  assert.deepEqual(
    route.stopOrder,
    entry.stops.map((stop) => stop.store.id),
  );
});

test('route inputs change with the transport mode', () => {
  const { stores, products, list } = completeMarket();
  const drive = kindOf(plan(list, stores, products, { transportMode: 'drive' }), 'recommended');
  const walk = kindOf(plan(list, stores, products, { transportMode: 'walk' }), 'recommended');
  assert.ok(drive && walk);
  assert.notEqual(
    drive.explanation.routeInputs.minutesPerMile,
    walk.explanation.routeInputs.minutesPerMile,
  );
});

test('only promotions that actually applied appear as applied', () => {
  const promotions: Promotion[] = [
    {
      id: 'promo-loyalty',
      retailerId: 'a',
      label: 'Members save 50c',
      loyaltyRequired: true,
      amountOffCents: 50,
    },
  ];
  const products = [
    makeProduct({
      id: 'a-milk',
      concept: 'milk',
      storeId: 'a',
      price: 300,
      promotionId: 'promo-loyalty',
    }),
  ];
  const withoutCard = kindOf(
    plan(
      listOf([{ concept: 'milk' }]),
      [store('a', 1)],
      products,
      { loyaltyRetailers: [] },
      {
        promotions,
      },
    ),
    'cheapest_single_store',
  );
  const withCard = kindOf(
    plan(
      listOf([{ concept: 'milk' }]),
      [store('a', 1)],
      products,
      { loyaltyRetailers: ['a'] },
      {
        promotions,
      },
    ),
    'cheapest_single_store',
  );
  assert.ok(withoutCard && withCard);
  assert.deepEqual(
    withoutCard.explanation.promotionsApplied,
    [],
    'an unmet promotion is not an applied promotion',
  );
  assert.equal(withCard.explanation.promotionsApplied.length, 1);
  assert.equal(withCard.explanation.promotionsApplied[0]?.savingsCents, 50);
  assert.equal(withCard.explanation.promotionsApplied[0]?.promotionId, 'promo-loyalty');
});

test('an applied promotion is worth exactly what the line saved', () => {
  const promotions: Promotion[] = [
    { id: 'p', retailerId: 'a', label: '$1 off', amountOffCents: 100 },
  ];
  const entry = kindOf(
    plan(
      listOf([{ concept: 'milk' }]),
      [store('a', 1)],
      [makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 400, promotionId: 'p' })],
      {},
      { promotions },
    ),
    'cheapest_single_store',
  );
  assert.ok(entry);
  const applied = entry.explanation.promotionsApplied[0];
  assert.ok(applied);
  const line = entry.stops[0]?.items[0];
  assert.ok(line);
  assert.equal(applied.savingsCents, line.promotionSavingsCents);
  assert.equal(entry.basketCostCents, 300, 'the discount is real money off the basket');
});

test('the explanation carries the same completeness object as the plan', () => {
  const { stores, products, list } = completeMarket();
  for (const entry of plan(list, stores, products)) {
    assert.deepEqual(entry.explanation.completeness, entry.completeness);
    assert.deepEqual(entry.explanation.baselines, entry.baselines);
    assert.deepEqual(entry.explanation.confidence, entry.confidenceDetail);
  }
});

// ── Tradeoffs ───────────────────────────────────────────────────────────────

test('a cheaper multi-store plan states what the saving costs in time', () => {
  const stores = [store('a', 1), store('b', 6)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 300 }),
    makeProduct({ id: 'a-bread', concept: 'bread', storeId: 'a', price: 900 }),
    makeProduct({ id: 'b-bread', concept: 'bread', storeId: 'b', price: 100 }),
    makeProduct({ id: 'b-milk', concept: 'milk', storeId: 'b', price: 900 }),
  ];
  const multi = plan(listOf([{ concept: 'milk' }, { concept: 'bread' }]), stores, products).find(
    (entry) => entry.stops.length === 2,
  );
  assert.ok(multi);
  const tradeoff = multi.explanation.tradeoffs[0];
  assert.ok(tradeoff, 'a plan that differs from the cheapest single store must state the trade');
  assert.ok(tradeoff.deltaBasketCents < 0, 'cheaper');
  assert.ok(tradeoff.deltaMinutes > 0, 'but longer');
  assert.equal(tradeoff.kind, 'cheaper_but_further');
  assert.match(tradeoff.detail, /cheaper for/);
});

test('the cheapest single store makes no tradeoff against itself', () => {
  const { stores, products, list } = completeMarket();
  const entry = kindOf(plan(list, stores, products), 'cheapest_single_store');
  assert.ok(entry);
  assert.deepEqual(entry.explanation.tradeoffs, []);
});

test('a tradeoff states stops as well as money and minutes', () => {
  const stores = [store('a', 1), store('b', 2)];
  const products = [
    makeProduct({ id: 'a-milk', concept: 'milk', storeId: 'a', price: 100 }),
    makeProduct({ id: 'a-bread', concept: 'bread', storeId: 'a', price: 800 }),
    makeProduct({ id: 'b-bread', concept: 'bread', storeId: 'b', price: 100 }),
    makeProduct({ id: 'b-milk', concept: 'milk', storeId: 'b', price: 800 }),
  ];
  const multi = plan(listOf([{ concept: 'milk' }, { concept: 'bread' }]), stores, products).find(
    (entry) => entry.stops.length === 2,
  );
  assert.ok(multi);
  const tradeoff = multi.explanation.tradeoffs[0];
  assert.ok(tradeoff);
  assert.equal(tradeoff.deltaStops, 1);
  assert.match(tradeoff.detail, /against the cheapest single store/);
});

// ── Determinism ─────────────────────────────────────────────────────────────

test('the same data and preferences produce a byte-identical explanation', () => {
  const { stores, products, list } = completeMarket();
  const extras = { usualStoreId: 'a', previousBasketCents: 1200 };
  const first = plan(list, stores, products, {}, extras);
  const second = plan(list, [...stores].reverse(), [...products].reverse(), {}, extras);
  assert.equal(
    JSON.stringify(first),
    JSON.stringify(second),
    'input order must not change the answer',
  );
});

test('no explanation field is ever undefined on a complete plan', () => {
  const { stores, products, list } = completeMarket();
  for (const entry of plan(list, stores, products, {}, { usualStoreId: 'a' })) {
    const explanation = entry.explanation;
    assert.ok(explanation.rationale.length > 0);
    assert.ok(Array.isArray(explanation.storesSelected));
    assert.ok(Array.isArray(explanation.productsChosen));
    assert.ok(Array.isArray(explanation.rejectedCandidates));
    assert.ok(Array.isArray(explanation.promotionsApplied));
    assert.ok(Array.isArray(explanation.baselines));
    assert.ok(Array.isArray(explanation.tradeoffs));
    assert.ok(explanation.routeInputs.stopOrder.length > 0);
    assert.ok(explanation.confidence.factors.length > 0);
    assert.ok(explanation.completeness.requestedItemCount > 0);
  }
});
