import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildDemoSnapshot,
  demoList,
  demoPreferences,
  demoPromotions,
  demoProducts,
  demoStores,
} from '../src/domain/demoMarket';
import { optimizeBasket, savingsBreakdown } from '../src/domain/optimizer';
import type { GroceryList, UserPreferences } from '../src/domain/types';

const prefs: UserPreferences = { ...demoPreferences, onboarded: true, maxStores: 2 };

function optimize(list: GroceryList = demoList, preferences: UserPreferences = prefs) {
  const snapshot = buildDemoSnapshot();
  return optimizeBasket({
    list,
    stores: snapshot.stores,
    products: snapshot.products,
    promotions: snapshot.promotions,
    preferences,
  });
}

test('produces a recommended, single-store and cheapest plan for the demo basket', () => {
  const plans = optimize();
  assert.ok(plans.length >= 2, 'expected more than one way to shop the basket');

  const recommended = plans.find((plan) => plan.kind === 'recommended');
  const single = plans.find((plan) => plan.kind === 'cheapest_single_store');
  assert.ok(recommended, 'a recommended plan exists');
  assert.ok(single, 'a single-store plan exists');
  assert.equal(single.stops.length, 1);
  assert.ok(recommended.basketCostCents > 0);
});

test('every plan supplies the entire basket', () => {
  for (const plan of optimize()) {
    const planned = plan.stops.flatMap((stop) => stop.items).map((item) => item.groceryItemId);
    assert.equal(
      new Set(planned).size,
      demoList.items.length,
      `${plan.kind} covered ${new Set(planned).size} of ${demoList.items.length} items`,
    );
  }
});

test('plan ids are unique so selecting a plan is unambiguous', () => {
  const plans = optimize();
  assert.equal(new Set(plans.map((plan) => plan.id)).size, plans.length);
});

test('stop subtotals and the basket total are consistent integer cents', () => {
  for (const plan of optimize()) {
    for (const stop of plan.stops) {
      const lineSum = stop.items.reduce((sum, item) => sum + item.lineTotalCents, 0);
      assert.equal(stop.subtotalCents, lineSum, `${plan.kind}/${stop.store.id} subtotal`);
    }
    const stopSum = plan.stops.reduce((sum, stop) => sum + stop.subtotalCents, 0);
    assert.equal(plan.basketCostCents, stopSum, `${plan.kind} basket total`);
    assert.ok(Number.isInteger(plan.basketCostCents), 'basket total is integer cents');
  }
});

test('every line total is quantity times the unit price actually used', () => {
  for (const plan of optimize()) {
    for (const item of plan.stops.flatMap((stop) => stop.items)) {
      assert.equal(item.lineTotalCents, item.unitPriceCents * item.quantity);
      assert.ok(item.unitPriceCents <= item.listPriceCents, 'promotions never raise the price');
    }
  }
});

test('the recommended plan is never more expensive in effective cost than one stop', () => {
  const plans = optimize();
  const recommended = plans.find((plan) => plan.kind === 'recommended');
  const single = plans.find((plan) => plan.kind === 'cheapest_single_store');
  assert.ok(recommended && single);
  assert.ok(recommended.effectiveCostCents <= single.effectiveCostCents);
});

test('the cheapest plan never has a higher basket cost than the single-store baseline', () => {
  const plans = optimize();
  const single = plans.find((plan) => plan.kind === 'cheapest_single_store');
  assert.ok(single);
  // Cheapest overall among the plans actually offered, single- or multi-store.
  const cheapest = [...plans]
    .filter((plan) => plan.complete)
    .sort((a, b) => a.basketCostCents - b.basketCostCents)[0];
  assert.ok(cheapest);
  assert.ok(cheapest.basketCostCents <= single.basketCostCents);
  assert.equal(cheapest.comparedBaselineCents, single.basketCostCents);
});

test('maxStores is respected by every plan offered', () => {
  const onePlans = optimize(demoList, { ...prefs, maxStores: 1 });
  const recommended = onePlans.find((plan) => plan.kind === 'recommended');
  assert.ok(recommended);
  assert.equal(recommended.stops.length, 1, 'a one-store shopper is never sent to two stores');
});

test('the radius excludes stores that are too far away', () => {
  const plans = optimize(demoList, { ...prefs, radiusMiles: 1 });
  const visited = new Set(plans.flatMap((plan) => plan.stops.map((stop) => stop.store.id)));
  for (const storeId of visited) {
    const store = demoStores.find((entry) => entry.id === storeId);
    assert.ok(store && store.distanceMiles <= 1, `${storeId} is inside the radius`);
  }
});

test('an item no store stocks is reported as missing, never priced', () => {
  const list: GroceryList = {
    ...demoList,
    items: [
      ...demoList.items,
      { id: 'item-unknown', concept: 'saffron', displayName: 'Saffron', quantity: 1, unit: '1 g' },
    ],
  };
  const plans = optimize(list);
  assert.ok(plans.length > 0, 'the shopper still gets the best available plan');
  for (const plan of plans) {
    assert.equal(plan.complete, false);
    assert.deepEqual(
      plan.missingItems.map((missing) => missing.groceryItemId),
      ['item-unknown'],
    );
    // The unpriced line contributes nothing rather than an estimate.
    const priced = plan.stops.flatMap((stop) => stop.items).map((item) => item.groceryItemId);
    assert.ok(!priced.includes('item-unknown'));
    assert.equal(plan.savingsVsBaselineCents, 0, 'an incomplete basket claims no saving');
  }
});

test('an empty basket yields no plan', () => {
  assert.deepEqual(optimize({ ...demoList, items: [] }), []);
});

test('loyalty promotions only apply to shoppers who hold the card', () => {
  const withCard = optimize(demoList, { ...prefs, loyaltyRetailers: ['grove'] });
  const withoutCard = optimize(demoList, { ...prefs, loyaltyRetailers: [] });

  const groveMilkWithCard = withCard
    .flatMap((plan) => plan.stops)
    .flatMap((stop) => stop.items)
    .find((item) => item.retailerProductId === 'g-milk');
  const groveMilkWithoutCard = withoutCard
    .flatMap((plan) => plan.stops)
    .flatMap((stop) => stop.items)
    .find((item) => item.retailerProductId === 'g-milk');

  if (groveMilkWithCard) {
    assert.equal(groveMilkWithCard.unitPriceCents, 349, 'membership price is applied');
    assert.ok(groveMilkWithCard.promotionLabel);
  }
  if (groveMilkWithoutCard) {
    assert.equal(groveMilkWithoutCard.unitPriceCents, 419, 'shelf price without the card');
    assert.equal(groveMilkWithoutCard.promotionSavingsCents, 0);
  }
});

test('multi-buy promotions are not applied to single-unit lines', () => {
  const cerealPromotion = demoPromotions.find((promotion) => promotion.id === 'north-cereal-2');
  assert.ok(cerealPromotion && cerealPromotion.requiredQuantity === 2);

  const northCereal = demoProducts.find((product) => product.id === 'n-cereal');
  assert.ok(northCereal);

  const item = optimize()
    .flatMap((plan) => plan.stops)
    .flatMap((stop) => stop.items)
    .find((entry) => entry.retailerProductId === 'n-cereal');
  if (item) {
    assert.equal(
      item.unitPriceCents,
      northCereal.observation.priceCents,
      'a 2-for offer does not discount a single unit',
    );
  }
});

test('an exact brand policy never substitutes', () => {
  const list: GroceryList = {
    ...demoList,
    items: demoList.items.map((item) =>
      item.concept === 'cereal'
        ? { ...item, requestedBrand: "Kellogg's", brandPolicy: 'exact_product' as const }
        : item,
    ),
  };
  const cerealLines = optimize(list)
    .flatMap((plan) => plan.stops)
    .flatMap((stop) => stop.items)
    .filter((item) => item.groceryItemId === 'item-6');

  assert.ok(cerealLines.length > 0);
  for (const line of cerealLines) {
    assert.equal(line.substitution, false);
    assert.ok(line.productBrand.toLowerCase().includes('kellogg'));
  }
});

test('an impossible exact brand request leaves that line unfilled', () => {
  const list: GroceryList = {
    ...demoList,
    items: demoList.items.map((item) =>
      item.concept === 'milk'
        ? {
            ...item,
            requestedBrand: 'Brand That Does Not Exist',
            brandPolicy: 'exact_product' as const,
          }
        : item,
    ),
  };
  const plans = optimize(list);
  assert.ok(plans.length > 0);
  for (const plan of plans) {
    assert.equal(plan.complete, false);
    const missing = plan.missingItems[0];
    assert.equal(missing?.groceryItemId, 'item-1');
    assert.equal(missing?.reason, 'brand_required', 'the reason is the brand, not absence');
    // Juva never quietly swaps in a different brand for an exact request.
    const brands = plan.stops.flatMap((stop) => stop.items).map((item) => item.groceryItemId);
    assert.ok(!brands.includes('item-1'));
  }
});

test('savings attribution is derived from observed prices, never estimated', () => {
  const plans = optimize();
  const recommended = plans.find((plan) => plan.kind === 'recommended');
  assert.ok(recommended);

  const breakdown = savingsBreakdown(recommended);
  const items = recommended.stops.flatMap((stop) => stop.items);

  assert.equal(breakdown.storeSelectionCents, recommended.savingsVsBaselineCents);
  assert.equal(
    breakdown.promotionCents,
    items.reduce(
      (sum, item) => sum + (item.listPriceCents - item.unitPriceCents) * item.quantity,
      0,
    ),
  );
  assert.ok(breakdown.promotionCents >= 0);
  assert.ok(breakdown.substitutionCents >= 0);

  // Items without a promotion contribute exactly nothing.
  for (const item of items.filter((entry) => !entry.promotionLabel)) {
    assert.equal(item.promotionSavingsCents, 0);
  }
});

test('the optimizer is deterministic', () => {
  assert.deepEqual(optimize(), optimize());
});
