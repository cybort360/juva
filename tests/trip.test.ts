import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildDemoSnapshot, demoList, demoPreferences } from '../src/domain/demoMarket';
import { optimizeBasket } from '../src/domain/optimizer';
import { createTrip, verifyTrip } from '../src/domain/trip';
import type { OptimizedPlan, Receipt, UserPreferences } from '../src/domain/types';

const prefs: UserPreferences = { ...demoPreferences, onboarded: true, maxStores: 2 };

function recommendedPlan(): OptimizedPlan {
  const snapshot = buildDemoSnapshot();
  const plans = optimizeBasket({
    list: demoList,
    stores: snapshot.stores,
    products: snapshot.products,
    promotions: snapshot.promotions,
    preferences: prefs,
  });
  const plan = plans.find((entry) => entry.kind === 'recommended');
  assert.ok(plan, 'the demo market must produce a recommended plan');
  return plan;
}

test('a trip mirrors the plan it came from', () => {
  const plan = recommendedPlan();
  const trip = createTrip(plan, demoList, buildDemoSnapshot());

  assert.equal(trip.planId, plan.id);
  assert.equal(trip.stops.length, plan.stops.length);
  assert.equal(trip.currentStopIndex, 0);
  trip.stops.forEach((stop, index) => {
    assert.equal(stop.expectedSubtotalCents, plan.stops[index]?.subtotalCents);
    assert.ok(stop.items.every((item) => item.status === 'pending'));
  });
});

test('with no receipts the plan stands in, but nothing is verified', () => {
  const plan = recommendedPlan();
  const record = verifyTrip(createTrip(plan, demoList, buildDemoSnapshot()), plan, [], 'USD');

  assert.equal(record.actualCents, plan.basketCostCents);
  assert.equal(record.plannedCents, plan.basketCostCents);
  assert.equal(record.baselineCents, plan.comparedBaselineCents);

  // The estimate survives so it can be shown, but it is not a verified saving:
  // no receipt was ever read, so there is nothing to have verified it against.
  assert.equal(record.estimatedSavingsCents, plan.savingsVsBaselineCents);
  assert.equal(record.receiptConfirmed, false);
  assert.equal(record.verifiedSavingsCents, 0, 'an unchecked estimate is not a saving');
});

test('a fully receipted trip with no open questions is confirmed', () => {
  const plan = recommendedPlan();
  const trip = createTrip(plan, demoList, buildDemoSnapshot());
  const receipts: Receipt[] = trip.stops.map((stop, index) => ({
    id: `receipt-confirmed-${index}`,
    capturedAt: new Date().toISOString(),
    storeId: stop.store.id,
    currency: 'USD',
    imageUris: [],
    source: 'manual' as const,
    totalCents: stop.expectedSubtotalCents,
    lines: [],
  }));

  const record = verifyTrip(trip, plan, receipts, 'USD');
  assert.equal(record.receiptConfirmed, true);
  assert.equal(record.actualCents, plan.basketCostCents);
  assert.equal(
    record.verifiedSavingsCents,
    Math.max(0, plan.comparedBaselineCents - plan.basketCostCents),
  );
});

test('a shelf correction is carried into the verified total', () => {
  const plan = recommendedPlan();
  const trip = createTrip(plan, demoList, buildDemoSnapshot());
  const firstStop = trip.stops[0];
  assert.ok(firstStop);
  const firstItem = firstStop.items[0];
  assert.ok(firstItem);

  firstItem.actualPriceCents = firstItem.lineTotalCents + 30;
  const record = verifyTrip(trip, plan, [], 'USD');

  assert.equal(record.actualCents, plan.basketCostCents + 30);
  const line = record.lines.find((entry) => entry.tripItemId === firstItem.groceryItemId);
  assert.ok(line);
  assert.equal(line.differenceCents, 30);
});

test('a shelf correction takes precedence over a matching receipt line', () => {
  const plan = recommendedPlan();
  const trip = createTrip(plan, demoList, buildDemoSnapshot());
  const stop = trip.stops[0];
  assert.ok(stop);
  const item = stop.items[0];
  assert.ok(item);

  item.actualPriceCents = 1234;
  const receipt: Receipt = {
    id: 'receipt-1',
    capturedAt: new Date().toISOString(),
    storeId: stop.store.id,
    currency: 'USD',
    imageUris: [],
    source: 'scan' as const,
    lines: [
      {
        id: 'line-1',
        rawText: item.productTitle,
        productName: item.productTitle,
        chargedPriceCents: 9999,
        quantity: 1,
        kind: 'item' as const,
      },
    ],
  };

  const record = verifyTrip(trip, plan, [receipt], 'USD');
  const line = record.lines.find((entry) => entry.tripItemId === item.groceryItemId);
  assert.ok(line);
  assert.equal(line.actualCents, 1234, 'what the shopper saw on the shelf wins');
});

test('a printed receipt total is recorded, with the residual made explicit', () => {
  const plan = recommendedPlan();
  const trip = createTrip(plan, demoList, buildDemoSnapshot());
  const stop = trip.stops[0];
  assert.ok(stop);

  const receiptTotal = stop.expectedSubtotalCents + 250;
  const receipt: Receipt = {
    id: 'receipt-2',
    capturedAt: new Date().toISOString(),
    storeId: stop.store.id,
    currency: 'USD',
    imageUris: [],
    source: 'manual' as const,
    totalCents: receiptTotal,
    lines: [],
  };

  const record = verifyTrip(trip, plan, [receipt], 'USD');
  const adjustment = record.lines.find((entry) =>
    entry.tripItemId.startsWith('receipt-adjustment-'),
  );
  assert.ok(adjustment, 'the difference against the printed total is shown, not absorbed');
  assert.equal(adjustment.differenceCents, 250);
  assert.equal(
    record.actualCents,
    receiptTotal + (plan.basketCostCents - stop.expectedSubtotalCents),
  );
});

test('one receipt line cannot explain two planned items', () => {
  const plan = recommendedPlan();
  const trip = createTrip(plan, demoList, buildDemoSnapshot());
  const stop = trip.stops[0];
  assert.ok(stop);
  const [first, second] = stop.items;
  assert.ok(first && second, 'this test needs a stop with at least two items');

  const receipt: Receipt = {
    id: 'receipt-3',
    capturedAt: new Date().toISOString(),
    storeId: stop.store.id,
    currency: 'USD',
    imageUris: [],
    source: 'scan' as const,
    lines: [
      {
        id: 'line-1',
        rawText: first.productTitle,
        productName: first.productTitle,
        chargedPriceCents: first.lineTotalCents + 100,
        quantity: 1,
        kind: 'item' as const,
      },
    ],
  };

  const record = verifyTrip(trip, plan, [receipt], 'USD');
  const matched = record.lines.filter((entry) => entry.differenceCents === 100);
  assert.equal(matched.length, 1, 'exactly one item was attributed to that receipt line');
});

test('verified savings are never negative', () => {
  const plan = recommendedPlan();
  const trip = createTrip(plan, demoList, buildDemoSnapshot());
  const stop = trip.stops[0];
  assert.ok(stop);

  const receipt: Receipt = {
    id: 'receipt-4',
    capturedAt: new Date().toISOString(),
    storeId: stop.store.id,
    currency: 'USD',
    imageUris: [],
    source: 'manual' as const,
    totalCents: plan.comparedBaselineCents * 4,
    lines: [],
  };

  const record = verifyTrip(trip, plan, [receipt], 'USD');
  assert.equal(record.verifiedSavingsCents, 0);
});

test('the record carries the basket currency', () => {
  const plan = recommendedPlan();
  const record = verifyTrip(createTrip(plan, demoList, buildDemoSnapshot()), plan, [], 'GBP');
  assert.equal(record.currency, 'GBP');
});
