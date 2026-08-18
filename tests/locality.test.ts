import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildDemoSnapshot, demoList, demoPreferences } from '../src/domain/demoMarket';
import { optimizeBasket } from '../src/domain/optimizer';
import { describeSnapshot, keepStoreScopedProducts } from '../src/domain/snapshot';
import type {
  MarketSnapshot,
  Promotion,
  RetailerProduct,
  Store,
  UserPreferences,
} from '../src/domain/types';

const prefs: UserPreferences = { ...demoPreferences, onboarded: true, maxStores: 2 };

function store(id: string): Store {
  return {
    id,
    retailerId: id,
    retailerName: id,
    displayName: id,
    address: 'somewhere',
    distanceMiles: 1,
    etaMinutes: 8,
    colorToken: 'forest',
  };
}

function product(overrides: {
  storeId: string;
  observationStoreId?: string;
  scope?: RetailerProduct['observation']['scope'];
}): RetailerProduct {
  return {
    id: `p-${overrides.storeId}`,
    canonicalConcept: 'milk',
    storeId: overrides.storeId,
    title: 'Whole Milk',
    brand: 'Test',
    sizeLabel: '1 gal',
    observation: {
      id: 'obs-1',
      storeId: overrides.observationStoreId ?? overrides.storeId,
      retailerId: 'test',
      retailerProductId: 'rp-1',
      scope: overrides.scope ?? 'store',
      priceCents: 399,
      currency: 'USD',
      source: 'community_feed',
      observedAt: new Date().toISOString(),
      freshness: 'recent',
      confidence: 0.8,
      available: true,
      availability: 'unknown',
    },
  };
}

test('a price whose observation names a different store is rejected', () => {
  const stores = [store('a'), store('b')];
  const { kept, rejected } = keepStoreScopedProducts(
    [product({ storeId: 'a', observationStoreId: 'b' })],
    stores,
  );
  assert.deepEqual(kept, []);
  assert.equal(rejected, 1);
});

test('a non-store scope is rejected even when the ids agree', () => {
  for (const scope of ['region', 'national', 'online'] as const) {
    const { kept, rejected } = keepStoreScopedProducts(
      [product({ storeId: 'a', scope })],
      [store('a')],
    );
    assert.deepEqual(kept, [], `${scope} must not be plannable`);
    assert.equal(rejected, 1);
  }
});

test('a price for a store that was not returned is rejected', () => {
  const { kept, rejected } = keepStoreScopedProducts([product({ storeId: 'ghost' })], [store('a')]);
  assert.deepEqual(kept, []);
  assert.equal(rejected, 1);
});

test('a correctly scoped price is kept', () => {
  const { kept, rejected } = keepStoreScopedProducts([product({ storeId: 'a' })], [store('a')]);
  assert.equal(kept.length, 1);
  assert.equal(rejected, 0);
});

test('the demo market satisfies the locality rule too', () => {
  const snapshot = buildDemoSnapshot();
  const { kept, rejected } = keepStoreScopedProducts(snapshot.products, snapshot.stores);
  assert.equal(rejected, 0, 'demo fixtures are store-scoped like real observations');
  assert.equal(kept.length, snapshot.products.length);
});

test('every demo observation carries full provenance', () => {
  for (const entry of buildDemoSnapshot().products) {
    const observation = entry.observation;
    assert.ok(observation.retailerId, 'retailer is recorded');
    assert.equal(observation.scope, 'store');
    assert.ok(observation.observedAt, 'observation time is recorded');
    assert.ok(observation.currency);
    assert.ok(observation.confidence > 0);
    assert.equal(observation.source, 'demo');
    assert.equal(observation.freshness, 'demo', 'demo data is never labelled live');
    assert.ok(['in_stock', 'out_of_stock', 'unknown'].includes(observation.availability));
  }
});

test('an expired promotion is not applied', () => {
  const snapshot = buildDemoSnapshot();
  const expired: Promotion[] = snapshot.promotions.map((promotion) => ({
    ...promotion,
    expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
  }));

  const withExpired = optimizeBasket({
    list: demoList,
    stores: snapshot.stores,
    products: snapshot.products,
    promotions: expired,
    preferences: prefs,
  });

  // The label now explains *why* an offer did not apply, so the invariant to
  // assert is that no discount reached a price.
  const lines = withExpired.flatMap((plan) => plan.stops).flatMap((stop) => stop.items);
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.notEqual(
      line.promotionStatus,
      'applied',
      'an expired offer is not a price Juva promises',
    );
    assert.equal(line.promotionSavingsCents, 0);
    assert.equal(line.lineTotalCents, line.listTotalCents);
  }
});

test('a promotion with an unmodelled condition is not applied', () => {
  const snapshot = buildDemoSnapshot();
  const unmodelled: Promotion[] = snapshot.promotions.map((promotion) => ({
    ...promotion,
    loyaltyRequired: false,
    requiredQuantity: 1,
    hasUnmodelledCondition: true,
  }));

  const plans = optimizeBasket({
    list: demoList,
    stores: snapshot.stores,
    products: snapshot.products,
    promotions: unmodelled,
    preferences: prefs,
  });

  const lines = plans.flatMap((plan) => plan.stops).flatMap((stop) => stop.items);
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.notEqual(line.promotionStatus, 'applied');
    assert.equal(line.promotionSavingsCents, 0, 'an unverifiable condition is never assumed met');
  }
});

test('snapshot metadata reports unpriced concepts in basket order', () => {
  const snapshot: MarketSnapshot = {
    ...buildDemoSnapshot(),
    // The source itself reports that it could not price two of the items.
    unpricedConcepts: ['bananas', 'milk'],
  };
  const meta = describeSnapshot(demoList, snapshot, prefs);

  const order = demoList.items.map((item) => item.concept);
  const positions = meta.unpricedConcepts.map((concept) => order.indexOf(concept));
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
    'unpriced items read in the order the shopper wrote them',
  );
  assert.ok(meta.unpricedConcepts.includes('milk'));
  assert.ok(meta.unpricedConcepts.includes('bananas'));
});

test('metadata reports the weakest freshness present, not the best', () => {
  const snapshot = buildDemoSnapshot();
  const mixed: MarketSnapshot = {
    ...snapshot,
    products: snapshot.products.map((entry, index) =>
      index === 0
        ? { ...entry, observation: { ...entry.observation, freshness: 'verify' as const } }
        : entry,
    ),
  };

  assert.equal(describeSnapshot(demoList, mixed, prefs).weakestFreshness, 'verify');
  assert.equal(describeSnapshot(demoList, snapshot, prefs).weakestFreshness, 'demo');
});

test('source failures and attributions travel to the snapshot metadata', () => {
  const snapshot: MarketSnapshot = {
    ...buildDemoSnapshot(),
    partial: true,
    sourceFailures: ['open_prices (prices): timed out'],
    attributions: [{ name: 'Open Prices', url: 'https://x', licence: 'ODbL 1.0' }],
  };
  const meta = describeSnapshot(demoList, snapshot, prefs);

  assert.equal(meta.partial, true);
  assert.deepEqual(meta.sourceFailures, ['open_prices (prices): timed out']);
  assert.equal(meta.attributions[0]?.licence, 'ODbL 1.0');
});
