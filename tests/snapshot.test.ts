import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildDemoSnapshot, demoList, demoPreferences } from '../src/domain/demoMarket';
import { countCombinations, describeSnapshot } from '../src/domain/snapshot';
import type { UserPreferences } from '../src/domain/types';

const prefs: UserPreferences = { ...demoPreferences, onboarded: true };

test('counts store combinations of size 1 to 3', () => {
  assert.equal(countCombinations(0, 3), 0);
  assert.equal(countCombinations(1, 3), 1);
  assert.equal(countCombinations(2, 3), 3); // 2 singles + 1 pair
  assert.equal(countCombinations(3, 3), 7); // 3 + 3 + 1
  assert.equal(countCombinations(4, 3), 14); // 4 + 6 + 4
});

test('the demo snapshot is always labelled demo, never live', () => {
  const snapshot = buildDemoSnapshot();
  assert.equal(snapshot.mode, 'demo');
  for (const product of snapshot.products) {
    assert.equal(product.observation.source, 'demo');
    assert.equal(product.observation.freshness, 'demo');
  }
});

test('the demo snapshot carries its promotions with it', () => {
  const snapshot = buildDemoSnapshot();
  assert.ok(snapshot.promotions.length > 0);
  const promotionIds = new Set(snapshot.promotions.map((promotion) => promotion.id));
  for (const product of snapshot.products) {
    const id = product.observation.promotionId;
    if (id) assert.ok(promotionIds.has(id), `promotion ${id} is present in the snapshot`);
  }
});

test('snapshot metadata reports real counts, scoped to the search radius', () => {
  const snapshot = buildDemoSnapshot();
  const meta = describeSnapshot(demoList, snapshot, prefs);

  assert.equal(meta.mode, 'demo');
  assert.equal(meta.storeCount, snapshot.stores.length);
  assert.deepEqual(
    meta.storeNames,
    snapshot.stores.map((store) => store.retailerName),
  );
  assert.equal(meta.productCount, snapshot.products.length);
  assert.ok(meta.matchedProductCount > 0);
  assert.ok(meta.matchedProductCount <= meta.productCount);
  assert.equal(meta.combinationsEvaluated, countCombinations(snapshot.stores.length, 3));
});

test('a tighter radius shrinks every reported count', () => {
  const snapshot = buildDemoSnapshot();
  const wide = describeSnapshot(demoList, snapshot, { ...prefs, radiusMiles: 5 });
  const tight = describeSnapshot(demoList, snapshot, { ...prefs, radiusMiles: 1 });

  assert.ok(tight.storeCount < wide.storeCount);
  assert.ok(tight.productCount < wide.productCount);
  assert.ok(tight.combinationsEvaluated < wide.combinationsEvaluated);
});

test('only promotions attached to matched products are counted', () => {
  const snapshot = buildDemoSnapshot();
  const meta = describeSnapshot({ ...demoList, items: [] }, snapshot, prefs);
  assert.equal(meta.matchedProductCount, 0);
  assert.equal(meta.promotionCount, 0, 'no basket means no promotions were checked');
});

test('an empty snapshot is never described as live', () => {
  // Seeding the weakest-freshness reduction with 'live' meant a snapshot with no
  // observations at all reported itself live, and the searching screen renders that as
  // "LIVE MARKET". A retailer search returning nothing is the normal shape of a total
  // API failure, so the failure case was the one claiming freshness.
  const meta = describeSnapshot(
    demoList,
    {
      stores: [],
      products: [],
      promotions: [],
      // The shape a real search produces when every source fails.
      mode: 'remote',
      fetchedAt: new Date().toISOString(),
      partial: true,
    },
    prefs,
  );
  assert.notEqual(meta.weakestFreshness, 'live');
  assert.equal(meta.weakestFreshness, 'verify', 'nothing observed means nothing fresh');
});
