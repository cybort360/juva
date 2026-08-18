import assert from 'node:assert/strict';
import { test } from 'node:test';

import { demoPreferences } from '../src/domain/demoMarket';
import { optimizeBasket } from '../src/domain/optimizer';
import type {
  GroceryList,
  GroceryListItem,
  OptimizedPlan,
  Promotion,
  RetailerProduct,
  Store,
  UserPreferences,
} from '../src/domain/types';

/**
 * The seventeen named optimizer scenarios.
 *
 * One test per scenario, numbered `S01`–`S17` to match `docs/OPTIMIZER_SCENARIOS.md`,
 * so the matrix in that document points at a real test rather than asserting that an
 * equivalent one exists somewhere. Several of these are also covered from another
 * angle in `planning.test.ts`, `optimizer.test.ts` and `worthTheTrip.test.ts`; the
 * mapping table in the doc lists those too. This file is the canonical, self-contained
 * evidence.
 *
 * Every fixture is hand-built and every expected figure is written out, so a scenario
 * cannot silently start passing for a different reason than it was written for.
 */

const NOW = new Date('2026-08-11T12:00:00Z');

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
    address: `${id} way`,
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
  soldByWeight?: boolean;
  freshness?: RetailerProduct['observation']['freshness'];
  available?: boolean;
  confidence?: number;
  promotionId?: string;
}

function priced(spec: Spec): RetailerProduct {
  return {
    id: spec.id,
    canonicalConcept: spec.concept,
    storeId: spec.storeId,
    title: spec.title ?? `${spec.concept} at ${spec.storeId}`,
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
      currency: 'USD',
      source: 'demo',
      observedAt: NOW.toISOString(),
      freshness: spec.freshness ?? 'demo',
      confidence: spec.confidence ?? 1,
      available: spec.available ?? true,
      availability: 'in_stock',
      ...(spec.promotionId === undefined ? {} : { promotionId: spec.promotionId }),
    },
  };
}

function basket(items: Partial<GroceryListItem>[], budgetCents?: number): GroceryList {
  return {
    id: 'l1',
    title: 'Scenario basket',
    prompt: 'scenario',
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
      ...(item.requestedVariant === undefined ? {} : { requestedVariant: item.requestedVariant }),
      ...(item.brandPolicy === undefined ? {} : { brandPolicy: item.brandPolicy }),
    })),
  };
}

function run(
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

function pick(plans: OptimizedPlan[]): OptimizedPlan {
  const plan = plans.find((entry) => entry.kind === 'recommended') ?? plans[0];
  assert.ok(plan, 'a recommendation is expected');
  return plan;
}

// ─────────────────────────────────────────────────────────────────────────────

test('S01 one store wins', () => {
  // Two stores in range. `alpha` is cheaper on every line, so splitting the basket
  // could only add travel for nothing.
  const stores = [store('alpha', 1), store('beta', 4)];
  const products = [
    priced({ id: 'a-milk', concept: 'milk', storeId: 'alpha', price: 300 }),
    priced({ id: 'a-eggs', concept: 'eggs', storeId: 'alpha', price: 400 }),
    priced({ id: 'b-milk', concept: 'milk', storeId: 'beta', price: 380 }),
    priced({ id: 'b-eggs', concept: 'eggs', storeId: 'beta', price: 460 }),
  ];
  const plan = pick(run(basket([{ concept: 'milk' }, { concept: 'eggs' }]), stores, products));

  assert.equal(plan.stops.length, 1);
  assert.equal(plan.stops[0]?.store.id, 'alpha');
  assert.equal(plan.basketCostCents, 700);
  assert.equal(plan.completeness.complete, true);
});

test('S02 two stores win', () => {
  // Each store is much cheaper on one line. The $9.00 combined saving is far larger
  // than the cost of the second stop, so the split is the right answer.
  const stores = [store('alpha', 1), store('beta', 2)];
  const products = [
    priced({ id: 'a-milk', concept: 'milk', storeId: 'alpha', price: 300 }),
    priced({ id: 'a-rice', concept: 'rice', storeId: 'alpha', price: 1400 }),
    priced({ id: 'b-milk', concept: 'milk', storeId: 'beta', price: 1300 }),
    priced({ id: 'b-rice', concept: 'rice', storeId: 'beta', price: 400 }),
  ];
  const plan = pick(run(basket([{ concept: 'milk' }, { concept: 'rice' }]), stores, products));

  assert.equal(plan.stops.length, 2);
  assert.equal(plan.basketCostCents, 700, '$3 milk at alpha, $4 rice at beta');
  assert.deepEqual([...plan.stops.map((stop) => stop.store.id)].sort(), ['alpha', 'beta']);
});

test('S03 third stop not worth it', () => {
  // A genuine third-stop test: `gamma` is 8 miles out and undercuts the bread by 40c.
  // The first split (alpha + beta) is worth $9.00 and is taken; the third stop is not.
  const stores = [store('alpha', 1), store('beta', 2), store('gamma', 8)];
  const products = [
    priced({ id: 'a-milk', concept: 'milk', storeId: 'alpha', price: 300 }),
    priced({ id: 'a-rice', concept: 'rice', storeId: 'alpha', price: 1400 }),
    priced({ id: 'a-bread', concept: 'bread', storeId: 'alpha', price: 500 }),
    priced({ id: 'b-milk', concept: 'milk', storeId: 'beta', price: 1300 }),
    priced({ id: 'b-rice', concept: 'rice', storeId: 'beta', price: 400 }),
    priced({ id: 'b-bread', concept: 'bread', storeId: 'beta', price: 500 }),
    priced({ id: 'g-bread', concept: 'bread', storeId: 'gamma', price: 460 }),
  ];
  const list = basket([{ concept: 'milk' }, { concept: 'rice' }, { concept: 'bread' }]);
  const plan = pick(run(list, stores, products, { maxStores: 3 }));

  assert.equal(plan.stops.length, 2, 'the worthwhile split is taken, the third stop is not');
  assert.equal(
    plan.stops.some((stop) => stop.store.id === 'gamma'),
    false,
  );
  assert.equal(plan.basketCostCents, 1200);

  // The three-stop plan is generated and simply scores worse — rejected, not hidden.
  const threeStop = run(list, stores, products, { maxStores: 3 }).find(
    (entry) => entry.stops.length === 3,
  );
  if (threeStop) {
    assert.ok(threeStop.basketCostCents < plan.basketCostCents, '40c cheaper on the basket');
    assert.ok(threeStop.effectiveCostCents > plan.effectiveCostCents, 'and worse overall');
  }
});

test('S04 strict budget', () => {
  // A $9.00 budget. The cheapest complete basket is $8.00 at beta; alpha's is $12.00.
  const stores = [store('alpha', 1), store('beta', 3)];
  const products = [
    priced({ id: 'a-milk', concept: 'milk', storeId: 'alpha', price: 600 }),
    priced({ id: 'a-eggs', concept: 'eggs', storeId: 'alpha', price: 600 }),
    priced({ id: 'b-milk', concept: 'milk', storeId: 'beta', price: 400 }),
    priced({ id: 'b-eggs', concept: 'eggs', storeId: 'beta', price: 400 }),
  ];
  const plans = run(basket([{ concept: 'milk' }, { concept: 'eggs' }], 900), stores, products);

  // `dedupePlans` labels a trip with the highest-priority kind that selected it, so the
  // budget plan here is also the cheapest single store and carries that name. It is
  // found by shape, and its rationale states the budget role it also fills.
  const budget = plans.find((plan) => plan.completeness.complete && plan.basketCostCents <= 900);
  assert.ok(budget, 'an inside-budget complete plan is offered');
  assert.equal(budget.basketCostCents, 800);
  assert.match(budget.explanation.rationale, /within-budget plan/);

  // And the recommendation is knowingly a different, dearer trip — the nearer store
  // scores better once the drive is costed, so the budget plan is a real alternative.
  assert.equal(pick(plans).basketCostCents, 1200);
});

test('S05 missing product', () => {
  const stores = [store('alpha', 1)];
  const products = [priced({ id: 'a-milk', concept: 'milk', storeId: 'alpha', price: 300 })];
  const plan = pick(
    run(
      basket([{ concept: 'milk' }, { concept: 'saffron', displayName: 'Saffron' }]),
      stores,
      products,
    ),
  );

  assert.equal(plan.missingItems.length, 1);
  assert.equal(plan.missingItems[0]?.requestedName, 'Saffron');
  assert.equal(plan.missingItems[0]?.reason, 'not_stocked_nearby');
  assert.equal(plan.basketCostCents, 300, 'the unpriced line adds nothing, never an estimate');
  assert.equal(plan.completeness.comparisonEligible, false);
  assert.equal(plan.savingsVsBaselineCents, 0);
});

test('S06 stale price', () => {
  // A 60c cheaper basket whose prices are months old loses to the fresh one: the
  // `verify` penalty is 150c a line, and it is a ranking term, never a price.
  const stores = [store('fresh', 1), store('stale', 1)];
  const products = [
    priced({ id: 'f-milk', concept: 'milk', storeId: 'fresh', price: 400, freshness: 'recent' }),
    priced({ id: 'f-eggs', concept: 'eggs', storeId: 'fresh', price: 400, freshness: 'recent' }),
    priced({ id: 's-milk', concept: 'milk', storeId: 'stale', price: 370, freshness: 'verify' }),
    priced({ id: 's-eggs', concept: 'eggs', storeId: 'stale', price: 370, freshness: 'verify' }),
  ];
  const list = basket([{ concept: 'milk' }, { concept: 'eggs' }]);
  const plan = pick(run(list, stores, products, { maxStores: 1 }));

  assert.equal(plan.stops[0]?.store.id, 'fresh');
  assert.equal(plan.basketCostCents, 800);
  assert.equal(plan.explanation.score.staleDataPenaltyCents, 30, '15c a line for recent');
  assert.equal(plan.weakestFreshness, 'recent');

  const stalePlan = run(list, stores, products, { maxStores: 1 }).find((entry) =>
    entry.stops.some((stop) => stop.store.id === 'stale'),
  );
  if (stalePlan) {
    assert.equal(stalePlan.explanation.score.staleDataPenaltyCents, 300);
    assert.equal(stalePlan.basketCostCents, 740, 'the penalty never entered the basket');
  }
});

test('S07 loyalty pricing', () => {
  const promotions: Promotion[] = [
    {
      id: 'card',
      retailerId: 'alpha',
      label: 'Members save $1',
      loyaltyRequired: true,
      amountOffCents: 100,
    },
  ];
  const stores = [store('alpha', 1)];
  const products = [
    priced({ id: 'a-milk', concept: 'milk', storeId: 'alpha', price: 500, promotionId: 'card' }),
  ];
  const list = basket([{ concept: 'milk' }]);

  const without = pick(run(list, stores, products, { loyaltyRetailers: [] }, promotions));
  assert.equal(without.basketCostCents, 500, 'no card, no discount');
  assert.deepEqual(without.explanation.promotionsApplied, []);

  const with_ = pick(run(list, stores, products, { loyaltyRetailers: ['alpha'] }, promotions));
  assert.equal(with_.basketCostCents, 400);
  assert.equal(with_.explanation.promotionsApplied[0]?.savingsCents, 100);
});

test('S08 multibuy', () => {
  const promotions: Promotion[] = [
    {
      id: 'two-for',
      retailerId: 'alpha',
      label: '2 for $7',
      requiredQuantity: 2,
      overridePriceCents: 350,
    },
  ];
  const stores = [store('alpha', 1)];
  const products = [
    priced({
      id: 'a-cereal',
      concept: 'cereal',
      storeId: 'alpha',
      price: 500,
      size: '18 oz',
      promotionId: 'two-for',
    }),
  ];

  // One pack: threshold unmet, shelf price.
  const one = pick(
    run(
      basket([{ concept: 'cereal', quantity: 1, unit: '18 oz' }]),
      stores,
      products,
      {},
      promotions,
    ),
  );
  assert.equal(one.basketCostCents, 500);

  // Two packs: the offer applies to both.
  const two = pick(
    run(
      basket([{ concept: 'cereal', quantity: 2, unit: '18 oz' }]),
      stores,
      products,
      {},
      promotions,
    ),
  );
  assert.equal(two.basketCostCents, 700);

  // Three packs: two at the offer price, one at shelf. Juva never adds a fourth pack
  // to reach another group, because that raises the bill to claim a saving.
  const three = pick(
    run(
      basket([{ concept: 'cereal', quantity: 3, unit: '18 oz' }]),
      stores,
      products,
      {},
      promotions,
    ),
  );
  assert.equal(three.basketCostCents, 1200);
});

test('S09 weighted goods', () => {
  // Chicken at $4.00/lb, 2.5 lb requested. Billed by the amount taken, not rounded to
  // a pack that does not exist.
  const stores = [store('alpha', 1)];
  const products = [
    priced({
      id: 'a-chicken',
      concept: 'chicken breast',
      storeId: 'alpha',
      price: 400,
      size: '1 lb',
      soldByWeight: true,
    }),
  ];
  const plan = pick(
    // The unit label carries the amount; `quantity` multiplies it.
    run(basket([{ concept: 'chicken breast', quantity: 1, unit: '2.5 lb' }]), stores, products),
  );

  assert.equal(plan.basketCostCents, 1000, '2.5 × $4.00');
  const line = plan.stops[0]?.items[0];
  assert.ok(line);
  assert.equal(line.packBasis, 'weighed');
  assert.equal(line.roundedUp, false, 'a weighed good is never rounded up to a whole pack');
});

test('S10 brand locked', () => {
  // `exact_product` on a variant no store carries. The line goes unfilled and is
  // reported as a brand/variant requirement rather than quietly substituted.
  const stores = [store('alpha', 1)];
  const products = [
    priced({
      id: 'a-frosties',
      concept: 'cereal',
      storeId: 'alpha',
      price: 400,
      brand: "Kellogg's",
      title: 'Frosties',
    }),
    priced({
      id: 'a-own',
      concept: 'cereal',
      storeId: 'alpha',
      price: 250,
      brand: 'Value',
      title: 'Corn Flakes',
    }),
    priced({ id: 'a-milk', concept: 'milk', storeId: 'alpha', price: 300 }),
  ];
  const plan = pick(
    run(
      basket([
        { concept: 'milk' },
        {
          concept: 'cereal',
          displayName: "Kellogg's Corn Flakes",
          requestedBrand: "Kellogg's",
          requestedVariant: 'corn flakes',
          brandPolicy: 'exact_product',
        },
      ]),
      stores,
      products,
    ),
  );

  assert.equal(plan.missingItems.length, 1);
  assert.equal(plan.missingItems[0]?.reason, 'variant_required');
  assert.equal(plan.basketCostCents, 300, 'only the milk; the locked line is not substituted');
  assert.equal(
    plan.stops[0]?.items.some((line) => line.productBrand === 'Value'),
    false,
    'the cheaper own-brand was available and deliberately not taken',
  );
  assert.ok(plan.completeness.remediations.includes('allow_substitutions'));
});

test('S11 flexible brand', () => {
  // The same market, flexible. The own-brand is $1.50 cheaper, which beats the 60c
  // preference penalty, so Juva substitutes and reports it as a substitution.
  const stores = [store('alpha', 1)];
  const products = [
    priced({ id: 'a-name', concept: 'cereal', storeId: 'alpha', price: 400, brand: "Kellogg's" }),
    priced({ id: 'a-own', concept: 'cereal', storeId: 'alpha', price: 250, brand: 'Value' }),
  ];
  const plan = pick(
    run(
      basket([{ concept: 'cereal', requestedBrand: "Kellogg's", brandPolicy: 'flexible' }]),
      stores,
      products,
    ),
  );

  assert.equal(plan.basketCostCents, 250);
  const line = plan.stops[0]?.items[0];
  assert.ok(line);
  assert.equal(line.substitution, true);
  assert.equal(line.productBrand, 'Value');
  assert.equal(line.substitutionSavingsCents, 150, 'measured against the requested brand here');
});

test('S12 unavailable product', () => {
  // Present in the feed, marked out of stock. Reported as unavailable rather than as
  // simply absent, because the two mean different things to a shopper.
  const stores = [store('alpha', 1)];
  const products = [
    priced({ id: 'a-milk', concept: 'milk', storeId: 'alpha', price: 300 }),
    priced({ id: 'a-eggs', concept: 'eggs', storeId: 'alpha', price: 400, available: false }),
  ];
  const plan = pick(run(basket([{ concept: 'milk' }, { concept: 'eggs' }]), stores, products));

  assert.equal(plan.missingItems.length, 1);
  assert.equal(plan.missingItems[0]?.reason, 'unavailable');
  assert.equal(plan.basketCostCents, 300);
});

test('S13 promotion expires', () => {
  // The offer expired ten days before planning. The plan pays the shelf price, and
  // the line says why rather than omitting the offer.
  const promotions: Promotion[] = [
    {
      id: 'gone',
      retailerId: 'alpha',
      label: '$1 off',
      amountOffCents: 100,
      expiresAt: '2026-08-01T00:00:00.000Z',
    },
  ];
  const stores = [store('alpha', 1)];
  const products = [
    priced({ id: 'a-milk', concept: 'milk', storeId: 'alpha', price: 500, promotionId: 'gone' }),
  ];
  const plan = pick(run(basket([{ concept: 'milk' }]), stores, products, {}, promotions));

  assert.equal(plan.basketCostCents, 500, 'no discount from an expired offer');
  assert.deepEqual(plan.explanation.promotionsApplied, []);
  const line = plan.stops[0]?.items[0];
  assert.ok(line);
  assert.equal(line.promotionStatus, 'expired');
  assert.match(String(line.promotionLabel), /expired/i);
  assert.equal(line.promotionSavingsCents, 0);
});

test('S14 quantity mismatch', () => {
  // 5 lb requested, sold only in 2 lb bags. Three bags is 6 lb — Juva buys the whole
  // bags it must and says the quantity was rounded up, rather than pretending 5 lb
  // can be bought or billing 2.5 bags.
  const stores = [store('alpha', 1)];
  const products = [
    priced({ id: 'a-rice', concept: 'rice', storeId: 'alpha', price: 300, size: '2 lb' }),
  ];
  const plan = pick(
    run(basket([{ concept: 'rice', quantity: 1, unit: '5 lb' }]), stores, products),
  );

  const line = plan.stops[0]?.items[0];
  assert.ok(line);
  assert.equal(line.quantity, 3, 'three whole bags');
  assert.equal(line.roundedUp, true, 'and the shopper is told it was rounded up');
  assert.equal(plan.basketCostCents, 900);
});

test('S14 quantity mismatch picks the cheaper way to reach the amount', () => {
  // A larger pack with a worse unit price must not win just because it needs one item.
  const stores = [store('alpha', 1)];
  const products = [
    priced({ id: 'a-small', concept: 'rice', storeId: 'alpha', price: 300, size: '2 lb' }),
    priced({ id: 'a-big', concept: 'rice', storeId: 'alpha', price: 1100, size: '6 lb' }),
  ];
  const plan = pick(
    run(basket([{ concept: 'rice', quantity: 1, unit: '5 lb' }]), stores, products),
  );

  assert.equal(plan.basketCostCents, 900, 'three small bags at $9.00 beat one 6 lb at $11.00');
  assert.equal(plan.stops[0]?.items[0]?.retailerProductId, 'a-small');
});

test('S15 ambiguous product', () => {
  // A different brand *and* a different variant is two steps from the request. Juva
  // prices it but flags it for confirmation instead of treating it as settled.
  const stores = [store('alpha', 1)];
  const products = [
    priced({
      id: 'a-bran',
      concept: 'cereal',
      storeId: 'alpha',
      price: 250,
      brand: 'Value',
      title: 'Bran Squares',
    }),
  ];
  const plan = pick(
    run(
      basket([
        {
          concept: 'cereal',
          requestedBrand: "Kellogg's",
          requestedVariant: 'corn flakes',
          brandPolicy: 'flexible',
        },
      ]),
      stores,
      products,
    ),
  );

  const line = plan.stops[0]?.items[0];
  assert.ok(line);
  assert.equal(line.substitution, true, 'shown as a substitution the shopper can reject');
  assert.equal(plan.basketCostCents, 250);
  // No substitution saving is claimed, because the requested product was never seen
  // here to compare against.
  assert.equal(line.substitutionSavingsCents, 0);
});

test('S16 under-budget alternative', () => {
  // The recommendation is $12.00, over the $10.00 budget. A cheaper complete basket
  // exists at beta and is offered as a distinct, under-budget plan rather than the
  // recommendation being silently swapped.
  const stores = [store('alpha', 1), store('beta', 6)];
  const products = [
    priced({ id: 'a-milk', concept: 'milk', storeId: 'alpha', price: 600 }),
    priced({ id: 'a-eggs', concept: 'eggs', storeId: 'alpha', price: 600 }),
    priced({ id: 'b-milk', concept: 'milk', storeId: 'beta', price: 450 }),
    priced({ id: 'b-eggs', concept: 'eggs', storeId: 'beta', price: 450 }),
  ];
  const plans = run(basket([{ concept: 'milk' }, { concept: 'eggs' }], 1000), stores, products);

  const recommended = pick(plans);
  assert.equal(recommended.basketCostCents, 1200, 'the nearer store still scores best');

  // Found by shape: the trip is also the cheapest single store, so `dedupePlans` gives
  // it that name. Its rationale states the budget role it also fills.
  const underBudget = plans.find(
    (plan) => plan.completeness.complete && plan.basketCostCents <= 1000,
  );
  assert.ok(underBudget, 'an under-budget alternative is offered');
  assert.equal(underBudget.basketCostCents, 900);
  assert.equal(underBudget.completeness.complete, true, 'and it is a complete basket');
  assert.notEqual(underBudget.id, recommended.id, 'a real alternative, not a relabel');
  assert.match(underBudget.explanation.rationale, /within-budget plan/);
});

test('S16 no under-budget plan is invented when nothing fits', () => {
  const stores = [store('alpha', 1)];
  const products = [
    priced({ id: 'a-milk', concept: 'milk', storeId: 'alpha', price: 900 }),
    priced({ id: 'a-eggs', concept: 'eggs', storeId: 'alpha', price: 900 }),
  ];
  const plans = run(basket([{ concept: 'milk' }, { concept: 'eggs' }], 500), stores, products);
  assert.equal(
    plans.some((plan) => plan.kind === 'strict_budget'),
    false,
    'a near miss is not offered as if it fitted',
  );
});

test('S17 travel cost reverses cheapest choice', () => {
  // `budget` has the cheaper basket by $1.50 but is 15 miles out. Once the drive is
  // costed, the nearer, dearer store is the better trip — and Juva says so while
  // still showing that it is knowingly not the cheapest basket.
  const stores = [store('local', 1), store('budget', 15)];
  const products = [
    priced({ id: 'l-milk', concept: 'milk', storeId: 'local', price: 500 }),
    priced({ id: 'l-eggs', concept: 'eggs', storeId: 'local', price: 500 }),
    priced({ id: 'b-milk', concept: 'milk', storeId: 'budget', price: 425 }),
    priced({ id: 'b-eggs', concept: 'eggs', storeId: 'budget', price: 425 }),
  ];
  const list = basket([{ concept: 'milk' }, { concept: 'eggs' }]);
  const plans = run(list, stores, products, { maxStores: 1 });
  const plan = pick(plans);

  assert.equal(plan.stops[0]?.store.id, 'local');
  assert.equal(plan.basketCostCents, 1000);

  const cheapestBasket = [...plans]
    .filter((entry) => entry.completeness.comparisonEligible)
    .sort((a, b) => a.basketCostCents - b.basketCostCents)[0];
  assert.ok(cheapestBasket);
  assert.equal(cheapestBasket.basketCostCents, 850, 'the cheaper basket exists');
  assert.equal(cheapestBasket.stops[0]?.store.id, 'budget');
  assert.ok(
    cheapestBasket.effectiveCostCents > plan.effectiveCostCents,
    'and loses on the weighted score, which is the reversal',
  );
  // The travel term is what did it, and it is published.
  assert.ok(
    cheapestBasket.explanation.score.travelCostCents > plan.explanation.score.travelCostCents,
  );
});

test('every scenario runs on integer cents only', () => {
  // A float that reached a price would undermine all seventeen.
  const stores = [store('alpha', 1), store('beta', 3)];
  const products = [
    priced({ id: 'a-rice', concept: 'rice', storeId: 'alpha', price: 333, size: '2 lb' }),
    priced({ id: 'b-rice', concept: 'rice', storeId: 'beta', price: 337, size: '3 lb' }),
  ];
  for (const plan of run(
    basket([{ concept: 'rice', quantity: 1, unit: '5 lb' }]),
    stores,
    products,
  )) {
    assert.ok(Number.isInteger(plan.basketCostCents));
    assert.ok(Number.isInteger(plan.savingsVsBaselineCents));
    assert.ok(Number.isInteger(plan.effectiveCostCents));
    for (const stop of plan.stops) {
      assert.ok(Number.isInteger(stop.subtotalCents));
      for (const line of stop.items) {
        assert.ok(Number.isInteger(line.lineTotalCents));
        assert.ok(Number.isInteger(line.listPriceCents));
      }
    }
  }
});
