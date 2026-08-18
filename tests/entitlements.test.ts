import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDemoSnapshot, demoList, demoPreferences } from '../src/domain/demoMarket';
import {
  FREE_HISTORY_LIMIT,
  FREE_ITEM_LIMIT,
  FREE_OPTIMIZATIONS_PER_DAY,
  bestMultiStorePlan,
  canAddItem,
  canOptimize,
  canSaveList,
  featureAvailable,
  freePlan,
  hiddenHistoryCount,
  upgradePrompt,
  visibleHistory,
} from '../src/domain/entitlements';
import { optimizeBasket } from '../src/domain/optimizer';
import type { OptimizedPlan, SavingsRecord } from '../src/domain/types';

function plans(maxStores = 2): OptimizedPlan[] {
  const snapshot = buildDemoSnapshot();
  return optimizeBasket({
    list: demoList,
    stores: snapshot.stores,
    products: snapshot.products,
    promotions: snapshot.promotions,
    preferences: { ...demoPreferences, onboarded: true, maxStores },
  });
}

function record(over: Partial<SavingsRecord> = {}): SavingsRecord {
  return {
    id: 'r',
    tripId: 't',
    createdAt: '2026-01-01T00:00:00.000Z',
    currency: 'USD',
    plannedCents: 1000,
    expectedTotalCents: 1000,
    actualCents: 1000,
    differenceCents: 0,
    baselineCents: 1200,
    estimatedSavingsCents: 200,
    verifiedSavingsCents: 200,
    storeSelectionSavingsCents: 0,
    promotionSavingsCents: 0,
    substitutionSavingsCents: 0,
    receiptConfirmed: true,
    confidence: 1,
    provenance: [],
    unmatchedLineCount: 0,
    missingItemCount: 0,
    lines: [],
    ...over,
  };
}

// ------------------------------------------------------------ what is never gated

test('the honest core of the product is free', () => {
  // Charging to see what something actually costs would make Juva dishonest, so
  // nothing in this list is a Plus feature.
  for (const feature of ['multi_store', 'worth_the_trip'] as const) {
    assert.equal(featureAvailable(feature, false), false, `${feature} is a Plus feature`);
  }
  // Shop Mode, receipt verification and recent savings are not gated at all — they
  // have no PlusFeature key, which is the structural way of saying so.
  const single = freePlan(plans());
  assert.ok(single, 'a free shopper always gets a shoppable plan');
  assert.equal(single.stops.length, 1);
});

test('Plus unlocks every gated feature', () => {
  for (const feature of [
    'multi_store',
    'worth_the_trip',
    'unlimited_lists',
    'unlimited_optimization',
    'recurring_baskets',
    'price_alerts',
    'budget_agent',
    'smart_substitutions',
    'full_history',
  ] as const) {
    assert.equal(featureAvailable(feature, true), true);
  }
});

// ------------------------------------------------------------------- free limits

test('a free basket is capped and says what the cap is', () => {
  assert.equal(canAddItem(FREE_ITEM_LIMIT - 1, false).allowed, true);
  const blocked = canAddItem(FREE_ITEM_LIMIT, false);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason ?? '', /10 items/, 'the shopper is told the number');
});

test('Plus removes the basket cap', () => {
  assert.equal(canAddItem(500, true).allowed, true);
});

test('free optimization runs are limited, Plus is not', () => {
  assert.equal(canOptimize(FREE_OPTIMIZATIONS_PER_DAY - 1, false).allowed, true);
  assert.equal(canOptimize(FREE_OPTIMIZATIONS_PER_DAY, false).allowed, false);
  assert.equal(canOptimize(9999, true).allowed, true);
});

test('a free account keeps one recurring basket', () => {
  assert.equal(canSaveList(0, false).allowed, true);
  assert.equal(canSaveList(1, false).allowed, false);
  assert.equal(canSaveList(50, true).allowed, true);
});

test('free history is trimmed for display but never deleted', () => {
  const records = Array.from({ length: 7 }, (_, i) => record({ id: `r${i}` }));
  assert.equal(visibleHistory(records, false).length, FREE_HISTORY_LIMIT);
  assert.equal(visibleHistory(records, true).length, 7);
  assert.equal(hiddenHistoryCount(records, false), 4);
  assert.equal(hiddenHistoryCount(records, true), 0);
  // The underlying records are untouched: a hidden trip still counts toward the
  // verified total, because the shopper earned it.
  assert.equal(records.length, 7);
});

// ------------------------------------------------------- the free plan selection

test('the free plan is the cheapest single-store plan', () => {
  const all = plans();
  const free = freePlan(all);
  assert.ok(free);
  assert.equal(free.stops.length, 1);
  const singles = all.filter((plan) => plan.stops.length === 1);
  for (const plan of singles) {
    assert.ok(free.basketCostCents <= plan.basketCostCents, 'no cheaper single store exists');
  }
});

test('the free plan prefers a complete basket over a cheaper incomplete one', () => {
  // A plan that silently drops an item is not a cheaper shop.
  const base = plans().find((plan) => plan.stops.length === 1);
  assert.ok(base, 'the demo market produces a single-store plan');
  const complete: OptimizedPlan = {
    ...base,
    id: 'complete',
    complete: true,
    basketCostCents: 5000,
  };
  const incomplete: OptimizedPlan = {
    ...base,
    id: 'incomplete',
    complete: false,
    basketCostCents: 1000,
  };
  assert.equal(freePlan([incomplete, complete])?.id, 'complete');
});

// ------------------------------------------------------------- the paywall offer

test('the offer quotes the deterministic difference between two computed baskets', () => {
  const all = plans();
  const prompt = upgradePrompt(all, false);
  const free = freePlan(all);
  const locked = bestMultiStorePlan(all);
  assert.ok(prompt && free && locked);
  assert.equal(
    prompt.additionalSavingsCents,
    free.basketCostCents - locked.basketCostCents,
    'exactly the subtraction, not a projection',
  );
  assert.equal(prompt.storeCount, locked.stops.length);
});

test('the offer states its cost as well as its benefit', () => {
  const prompt = upgradePrompt(plans(), false);
  assert.ok(prompt);
  assert.ok(prompt.extraDistanceMiles >= 0);
  assert.ok(prompt.extraMinutes >= 0);
});

test('no offer is made when either plan is only partially priced', () => {
  // The subtraction is only a saving when both sides are the same basket. A free
  // plan at $50 for eight items against a multi-store plan at $38 for six is a $12
  // claim for a shop that never happened.
  const all = plans();
  const free = freePlan(all);
  const locked = bestMultiStorePlan(all);
  assert.ok(free && locked, 'the demo market produces both shapes');

  const partial = (plan: OptimizedPlan): OptimizedPlan => ({
    ...plan,
    complete: false,
    completeness: {
      ...plan.completeness,
      complete: false,
      pricedItemCount: plan.completeness.requestedItemCount - 2,
      comparisonEligible: false,
      ineligibleReason: 'two items could not be priced',
    },
  });

  assert.ok(upgradePrompt(all, false), 'the complete market does produce an offer');
  assert.equal(
    upgradePrompt([partial(free), locked], false),
    undefined,
    'a partial free plan cannot anchor a savings claim',
  );
  assert.equal(
    upgradePrompt([free, partial(locked)], false),
    undefined,
    'nor can a partial multi-store plan',
  );
});

test('a shopper with Plus is never offered the upgrade', () => {
  assert.equal(upgradePrompt(plans(), true), undefined);
});

test('there is no paywall on a first launch, because there are no plans yet', () => {
  assert.equal(upgradePrompt([], false), undefined);
});

test('no offer is made when splitting the basket saves nothing', () => {
  const all = plans(1);
  // With one store allowed there is no multi-store plan to sell.
  assert.equal(bestMultiStorePlan(all), undefined);
  assert.equal(upgradePrompt(all, false), undefined);
});

test('no offer is made when the multi-store plan is not actually cheaper', () => {
  const base = plans()[0];
  assert.ok(base);
  const free = { ...base, id: 'free', stops: base.stops.slice(0, 1), basketCostCents: 1000 };
  const multi = { ...base, id: 'multi', basketCostCents: 1000 };
  assert.equal(
    upgradePrompt([free as OptimizedPlan, multi as OptimizedPlan], false),
    undefined,
    'an equal price is not a saving',
  );
});

test('a dearer multi-store plan never produces an offer', () => {
  const base = plans()[0];
  assert.ok(base);
  const free = { ...base, id: 'free', stops: base.stops.slice(0, 1), basketCostCents: 1000 };
  const multi = { ...base, id: 'multi', basketCostCents: 1500 };
  assert.equal(upgradePrompt([free as OptimizedPlan, multi as OptimizedPlan], false), undefined);
});

test('the offer is a positive integer number of cents', () => {
  const prompt = upgradePrompt(plans(), false);
  assert.ok(prompt);
  assert.ok(Number.isInteger(prompt.additionalSavingsCents));
  assert.ok(prompt.additionalSavingsCents > 0);
});
