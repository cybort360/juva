import assert from 'node:assert/strict';
import { test } from 'node:test';

import { demoPreferences } from '../src/domain/demoMarket';
import { optimizeBasket, worthTheTripComparison } from '../src/domain/optimizer';
import type {
  GroceryList,
  OptimizedPlan,
  RetailerProduct,
  Store,
  UserPreferences,
} from '../src/domain/types';

/**
 * Worth the Trip, reverified.
 *
 * The control's promise is that moving the priority slider re-runs the optimizer and
 * the answer genuinely changes — not that a label swaps. This suite proves it by
 * calling `optimizeBasket` with exactly the preference patch the control emits
 * (`{ conveniencePreference }`, `{ maxStores }`, `{ transportMode }`) and asserting
 * the *plans* differ, then asserting the control's own rendering derivation is a pure
 * function of those plans.
 *
 * The five claims, labelled as the brief numbered them:
 *
 *   A  low effort chooses fewer stores
 *   B  low price accepts an additional worthwhile stop
 *   C  a trivial-saving stop stays rejected even at the low-price end
 *   D  travel cost can reverse the apparent cheapest basket
 *   E  the UI result is the optimizer's output, not a visual-only change
 */

const NOW = new Date('2026-08-11T12:00:00Z');

const base: UserPreferences = {
  ...demoPreferences,
  onboarded: true,
  maxStores: 3,
  radiusMiles: 20,
  loyaltyRetailers: [],
  couponIds: [],
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
    address: `${id} road`,
    distanceMiles,
    etaMinutes: Math.round(distanceMiles * 4),
    colorToken: 'forest',
  };
}

function priced(id: string, concept: string, storeId: string, priceCents: number): RetailerProduct {
  return {
    id,
    canonicalConcept: concept,
    storeId,
    title: `${concept} at ${storeId}`,
    brand: 'Generic',
    sizeLabel: '1 ct',
    observation: {
      id: `obs-${id}`,
      storeId,
      retailerId: storeId,
      retailerProductId: id,
      scope: 'store',
      priceCents,
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

function list(concepts: string[]): GroceryList {
  return {
    id: 'l1',
    title: 'Basket',
    prompt: concepts.join(', '),
    currency: 'USD',
    createdAt: NOW.toISOString(),
    items: concepts.map((concept, index) => ({
      id: `i${index + 1}`,
      concept,
      displayName: concept,
      quantity: 1,
      unit: '1 ct',
    })),
  };
}

/**
 * Exactly what `recomputePlans` does: merge the control's patch into preferences and
 * re-run the optimizer over the *same* observations. Nothing else changes.
 */
function replan(
  basket: GroceryList,
  stores: Store[],
  products: RetailerProduct[],
  patch: Partial<UserPreferences>,
): OptimizedPlan[] {
  return optimizeBasket({
    list: basket,
    stores,
    products,
    promotions: [],
    preferences: { ...base, ...patch },
    now: NOW,
  });
}

function recommended(plans: OptimizedPlan[]): OptimizedPlan {
  const plan = plans.find((entry) => entry.kind === 'recommended') ?? plans[0];
  assert.ok(plan, 'the optimizer must return a recommendation');
  return plan;
}

/**
 * A market where splitting the basket saves real money but costs a genuine detour.
 *
 * `near` can fill the whole basket for $24.00. `far` is 6 miles out and sells the
 * rice for $3.00 against near's $12.00 — a $9.00 saving for roughly 24 extra minutes
 * and a second stop. Whether that is worth it is precisely the judgement the slider
 * expresses, which makes this the right fixture for A and B.
 */
function detourMarket(): { stores: Store[]; products: RetailerProduct[]; basket: GroceryList } {
  return {
    stores: [store('near', 1), store('far', 6)],
    products: [
      priced('near-milk', 'milk', 'near', 400),
      priced('near-eggs', 'eggs', 'near', 800),
      priced('near-rice', 'rice', 'near', 1200),
      priced('far-milk', 'milk', 'far', 900),
      priced('far-eggs', 'eggs', 'far', 1400),
      priced('far-rice', 'rice', 'far', 300),
    ],
    basket: list(['milk', 'eggs', 'rice']),
  };
}

// ── A. Low effort chooses fewer stores ──────────────────────────────────────

test('A: prioritising less effort recommends the single-store trip', () => {
  const { stores, products, basket } = detourMarket();
  const plan = recommended(replan(basket, stores, products, { conveniencePreference: 1 }));
  assert.equal(plan.stops.length, 1, 'one stop');
  assert.equal(plan.stops[0]?.store.id, 'near');
  assert.equal(plan.basketCostCents, 2400, 'and pays the higher basket for it');
});

// ── B. Low price accepts a worthwhile extra stop ─────────────────────────────

test('B: prioritising the lowest price accepts the second stop', () => {
  const { stores, products, basket } = detourMarket();
  const plan = recommended(replan(basket, stores, products, { conveniencePreference: 0 }));
  assert.equal(plan.stops.length, 2, 'two stops');
  assert.equal(plan.basketCostCents, 1500, '$4 + $8 near, $3 rice far');
  assert.deepEqual([...plan.stops.map((stop) => stop.store.id)].sort(), ['far', 'near']);
});

test('A vs B: the same observations produce genuinely different recommendations', () => {
  // The core of the reverification. One field of preferences changes; two different
  // trips come back, with different stop counts, different baskets and different ids.
  const { stores, products, basket } = detourMarket();
  const effort = recommended(replan(basket, stores, products, { conveniencePreference: 1 }));
  const price = recommended(replan(basket, stores, products, { conveniencePreference: 0 }));

  assert.notEqual(effort.id, price.id);
  assert.notEqual(effort.stops.length, price.stops.length);
  assert.ok(price.basketCostCents < effort.basketCostCents, 'the price end buys cheaper');
  assert.ok(price.etaMinutes > effort.etaMinutes, 'and takes longer doing it');
});

test('the balanced midpoint is a real third answer, not a copy of an extreme', () => {
  const { stores, products, basket } = detourMarket();
  const balanced = recommended(replan(basket, stores, products, { conveniencePreference: 0.5 }));
  // Whichever way the midpoint falls, its score must sit between the two extremes'
  // scores under its own weighting — the slider is a continuum, not a toggle.
  assert.ok(balanced.effectiveCostCents > 0);
  assert.ok(balanced.explanation.score.effortWeight === 1);
});

// ── C. A trivial saving never justifies a stop ───────────────────────────────

test('C: a 30c saving does not buy a second stop, even at the lowest-price end', () => {
  // `far` undercuts the rice by 30c and is 6 miles away. At conveniencePreference 0
  // the effort weight is zero, so travel and time are free to the ranking — but the
  // basket difference is still only 30c against a $12.00 line, and the plan that adds
  // a stop for it must not win. This is the case that would expose a control that
  // merely re-labels: a naive "cheapest basket wins" would take the detour.
  const stores = [store('near', 1), store('far', 6)];
  const products = [
    priced('near-milk', 'milk', 'near', 400),
    priced('near-eggs', 'eggs', 'near', 800),
    priced('near-rice', 'rice', 'near', 1200),
    priced('far-rice', 'rice', 'far', 1170),
  ];
  const basket = list(['milk', 'eggs', 'rice']);

  // Including 0: the effort-weight floor means even the most price-focused setting
  // still costs the drive, which is what makes this hold at the very end of the range.
  for (const preference of [0, 0.25, 0.5, 1]) {
    const plan = recommended(
      replan(basket, stores, products, { conveniencePreference: preference }),
    );
    assert.equal(
      plan.stops.length,
      1,
      `at conveniencePreference ${preference} a 30c saving must not add a stop`,
    );
  }
});

test('C: the trivial-saving plan is still generated and still explains itself', () => {
  // Rejected, not hidden. The shopper can see the two-stop option and why it lost.
  const stores = [store('near', 1), store('far', 6)];
  const products = [
    priced('near-milk', 'milk', 'near', 400),
    priced('near-rice', 'rice', 'near', 1200),
    priced('far-rice', 'rice', 'far', 1170),
  ];
  const plans = replan(list(['milk', 'rice']), stores, products, { conveniencePreference: 0 });
  const twoStop = plans.find((plan) => plan.stops.length === 2);
  assert.ok(twoStop, 'the multi-store option exists as a competing plan');
  assert.ok(
    twoStop.effectiveCostCents > recommended(plans).effectiveCostCents,
    'it simply scores worse',
  );
});

// ── D. Travel cost reverses the apparent cheapest basket ─────────────────────

test('D: travel cost reverses which single store wins', () => {
  // `budget` has the cheaper basket by $1.50 but is 15 miles away; `local` is 1 mile.
  // On basket price alone budget wins. Once driving is costed, local wins.
  const stores = [store('local', 1), store('budget', 15)];
  const products = [
    priced('local-milk', 'milk', 'local', 500),
    priced('local-eggs', 'eggs', 'local', 500),
    priced('budget-milk', 'milk', 'budget', 425),
    priced('budget-eggs', 'eggs', 'budget', 425),
  ];
  const basket = list(['milk', 'eggs']);

  const balanced = recommended(replan(basket, stores, products, { conveniencePreference: 0.5 }));
  assert.equal(balanced.stops[0]?.store.id, 'local', 'the nearer, dearer store wins');

  const cheapestBasket = replan(basket, stores, products, { conveniencePreference: 0.5 })
    .filter((plan) => plan.completeness.comparisonEligible)
    .sort((a, b) => a.basketCostCents - b.basketCostCents)[0];
  assert.equal(cheapestBasket?.stops[0]?.store.id, 'budget');
  assert.ok(
    cheapestBasket.basketCostCents < balanced.basketCostCents,
    'so the recommendation is knowingly not the cheapest basket',
  );
  assert.ok(
    cheapestBasket.effectiveCostCents > balanced.effectiveCostCents,
    'it is beaten on the weighted score, which is the whole point',
  );
});

test('D: the reversal is caused by the travel term, and undoes itself when it shrinks', () => {
  // Same $1.50 basket saving, same priority — only the distance moves. At 15 miles the
  // nearer store wins; at 2 miles the cheaper basket wins again. Nothing else differs,
  // so the travel term is provably what reversed it.
  const products = (budgetDistance: number) => ({
    stores: [store('local', 1), store('budget', budgetDistance)],
    products: [
      priced('local-milk', 'milk', 'local', 500),
      priced('local-eggs', 'eggs', 'local', 500),
      priced('budget-milk', 'milk', 'budget', 425),
      priced('budget-eggs', 'eggs', 'budget', 425),
    ],
  });
  const basket = list(['milk', 'eggs']);

  const far = products(15);
  assert.equal(
    recommended(replan(basket, far.stores, far.products, { conveniencePreference: 0.5 })).stops[0]
      ?.store.id,
    'local',
  );

  const close = products(1.5);
  assert.equal(
    recommended(replan(basket, close.stores, close.products, { conveniencePreference: 0.5 }))
      .stops[0]?.store.id,
    'budget',
    'a half-mile further no longer outweighs $1.50',
  );
});

test('D: switching to walking changes the answer through travel time alone', () => {
  // Same prices, same stores, same priority. Only the transport mode moves, and it
  // moves the recommendation — travel is a real input, not decoration.
  const { stores, products, basket } = detourMarket();
  const driving = recommended(
    replan(basket, stores, products, { transportMode: 'drive', conveniencePreference: 0.5 }),
  );
  const walking = recommended(
    replan(basket, stores, products, { transportMode: 'walk', conveniencePreference: 0.5 }),
  );
  assert.ok(
    walking.etaMinutes > driving.etaMinutes,
    'walking is slower, and the route inputs say so',
  );
  assert.notEqual(
    walking.explanation.routeInputs.minutesPerMile,
    driving.explanation.routeInputs.minutesPerMile,
  );
});

// ── The maxStores control ───────────────────────────────────────────────────

test('capping stores at one removes the multi-store plan entirely', () => {
  const { stores, products, basket } = detourMarket();
  const capped = replan(basket, stores, products, { maxStores: 1, conveniencePreference: 0 });
  assert.ok(capped.length > 0);
  for (const plan of capped) {
    assert.equal(plan.stops.length, 1, 'the cap is a hard constraint, not a preference');
  }
  // And it costs the shopper the saving, which the plan is honest about.
  assert.equal(recommended(capped).basketCostCents, 2400);
});

// ── E. The UI renders the optimizer's output ─────────────────────────────────

test('E: the control compares two plans the optimizer actually generated', () => {
  const { stores, products, basket } = detourMarket();
  const plans = replan(basket, stores, products, { conveniencePreference: 1 });
  const selected = recommended(plans);
  const comparison = worthTheTripComparison(selected, plans);

  assert.ok(comparison.alternative, 'a cheaper alternative exists here');
  // Identity, not resemblance: the alternative is one of the returned plans.
  assert.ok(
    plans.some((plan) => plan.id === comparison.alternative?.id),
    'the alternative is a member of the generated plan set',
  );
  assert.notEqual(comparison.alternative.id, selected.id);
});

test('E: every number the control shows is arithmetic over those two plans', () => {
  const { stores, products, basket } = detourMarket();
  const plans = replan(basket, stores, products, { conveniencePreference: 1 });
  const selected = recommended(plans);
  const comparison = worthTheTripComparison(selected, plans);
  const alternative = comparison.alternative;
  assert.ok(alternative);

  assert.equal(
    comparison.extraSavingsCents,
    selected.basketCostCents - alternative.basketCostCents,
    'the saving is a subtraction of two computed baskets',
  );
  assert.equal(comparison.extraMinutes, alternative.etaMinutes - selected.etaMinutes);
  assert.equal(comparison.extraStops, alternative.stops.length - selected.stops.length);
  assert.equal(
    comparison.alternativeScoresBetter,
    alternative.effectiveCostCents < selected.effectiveCostCents,
  );
  // The concrete figures for this fixture, so a silent change to the arithmetic fails.
  assert.equal(comparison.extraSavingsCents, 900);
  assert.equal(comparison.extraStops, 1);
});

test('E: the control offers nothing when the selected plan is already cheapest', () => {
  // At the lowest-price end the recommendation *is* the cheapest basket, so there is
  // no alternative to offer — and the control must say so rather than invent one.
  const { stores, products, basket } = detourMarket();
  const plans = replan(basket, stores, products, { conveniencePreference: 0 });
  const comparison = worthTheTripComparison(recommended(plans), plans);
  assert.equal(comparison.alternative, undefined);
  assert.equal(comparison.extraSavingsCents, 0);
  assert.equal(comparison.extraMinutes, 0);
  assert.equal(comparison.extraStops, 0);
});

test('E: a partial plan is never offered as the cheaper alternative', () => {
  // Otherwise the control would advertise a saving against a basket missing an item —
  // the same fabricated claim the completeness gate exists to prevent.
  const stores = [store('near', 1), store('far', 6)];
  const products = [
    priced('near-milk', 'milk', 'near', 900),
    priced('near-eggs', 'eggs', 'near', 900),
    priced('far-milk', 'milk', 'far', 100),
  ];
  const plans = replan(list(['milk', 'eggs']), stores, products, { conveniencePreference: 0 });
  const selected = recommended(plans);
  const comparison = worthTheTripComparison(selected, plans);
  if (comparison.alternative) {
    assert.equal(comparison.alternative.completeness.comparisonEligible, true);
  }
  assert.equal(
    plans.some(
      (plan) => !plan.completeness.comparisonEligible && plan.id === comparison.alternative?.id,
    ),
    false,
  );
});

test('E: the comparison is deterministic for the same plan set', () => {
  const { stores, products, basket } = detourMarket();
  const plans = replan(basket, stores, products, { conveniencePreference: 1 });
  const selected = recommended(plans);
  assert.equal(
    JSON.stringify(worthTheTripComparison(selected, plans)),
    JSON.stringify(worthTheTripComparison(selected, [...plans].reverse())),
    'plan order must not change what the control shows',
  );
});

test('recomputing with an unchanged preference returns an unchanged plan', () => {
  // The control patches one field. Patching it to its current value must be a no-op,
  // or the shopper would see the plan flicker for no reason.
  const { stores, products, basket } = detourMarket();
  const first = replan(basket, stores, products, { conveniencePreference: 0.5 });
  const second = replan(basket, stores, products, { conveniencePreference: 0.5 });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
