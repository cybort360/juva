import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { demoPreferences } from '../src/domain/demoMarket';
import { isRemoteSnapshot, snapshotFromWire } from '../src/domain/marketWire';
import { optimizeBasket } from '../src/domain/optimizer';
import type { GroceryList, UserPreferences } from '../src/domain/types';

/**
 * The real-data chain, end to end, deterministically.
 *
 *   location → store → retailer product → price observation → sourceIdentifier
 *            → freshness → optimizer input → priced plan
 *
 * The payload is **recorded from a live run** against Open Prices at postcode 94043 on
 * 17 Aug 2026 (`tests/fixtures/realMarket94043.json`), not hand-written. That distinction is
 * the point: a hand-written fixture only proves the code agrees with my assumptions about
 * the upstream shape, whereas a captured one proves it agrees with the source. It is then
 * frozen, so this test is deterministic and needs no network.
 *
 * If Open Prices changes its response shape, `live-check` and the mocked adapter tests are
 * what catch it. This test guards the *contract* between a real payload and the optimizer.
 */

const payload: unknown = JSON.parse(
  readFileSync(path.join(process.cwd(), 'tests/fixtures/realMarket94043.json'), 'utf8'),
);

const preferences: UserPreferences = {
  ...demoPreferences,
  onboarded: true,
  maxStores: 1,
  radiusMiles: 3,
};

function listFor(concepts: string[]): GroceryList {
  return {
    id: 'list-real',
    title: 'Real data basket',
    prompt: concepts.join(', '),
    currency: 'USD',
    createdAt: '2026-08-17T00:00:00.000Z',
    items: concepts.map((concept, index) => ({
      id: `item-${index}`,
      concept,
      displayName: concept,
      quantity: 1,
      unit: 'count',
      brandPolicy: 'flexible' as const,
    })),
  };
}

test('the recorded payload is accepted by the same validator production uses', () => {
  assert.equal(isRemoteSnapshot(payload), true);
});

test('a real location resolves to a real, identifiable store', () => {
  const data = payload as { location: Record<string, unknown>; stores: Record<string, unknown>[] };
  assert.equal(data.location.postalCode, '94043');
  assert.equal(data.location.origin, 'postal_code');
  // A postcode, not GPS: precise location stays optional.
  assert.ok(typeof data.location.latitude === 'number');

  const store = data.stores[0];
  assert.ok(store);
  assert.equal(store.retailerName, 'Safeway');
  // OSM identity, so the same physical branch is addressable across runs.
  assert.match(String(store.id), /^open_prices:(node|way):\d+$/);
  assert.ok(typeof store.distanceMiles === 'number' && (store.distanceMiles as number) <= 3);
});

test('every retailer product carries a complete, traceable observation', () => {
  assert.ok(isRemoteSnapshot(payload));
  const snapshot = snapshotFromWire(payload);
  assert.ok(snapshot.products.length > 0, 'the recording must contain priced products');

  for (const product of snapshot.products) {
    const observation = product.observation;

    // Identity: canonical concept, retailer product id, and the store it is valid at.
    assert.ok(product.canonicalConcept.length > 0);
    assert.ok(observation.retailerProductId.length > 0);
    assert.equal(observation.scope, 'store', 'only store scope is plannable');
    assert.equal(observation.storeId, snapshot.stores[0]?.id);

    // Money: integer minor units, in the basket currency.
    assert.ok(Number.isInteger(observation.priceCents) && observation.priceCents > 0);
    assert.equal(observation.currency, 'USD');

    // Provenance: where it came from, and the row it came from.
    assert.equal(observation.source, 'community_feed');
    // Optional on the type because the demo market has no upstream row to point at; for
    // real data it must always be present, which is exactly what this asserts.
    assert.ok(observation.sourceIdentifier, 'a real observation must be traceable');
    assert.match(observation.sourceIdentifier, /^price\/\d+$/);

    // Freshness: derived, never claimed by the source, and never `live` for this source.
    assert.ok(['recent', 'older', 'verify'].includes(observation.freshness));
    assert.notEqual(
      observation.freshness,
      'live',
      'community-contributed data can never justify LIVE',
    );
    assert.ok(!Number.isNaN(Date.parse(observation.observedAt)));

    // Capability honesty: no stock feed means availability is unknown, never guessed.
    assert.equal(observation.availability, 'unknown');
    assert.equal(observation.confidence > 0 && observation.confidence <= 1, true);
  }
});

test('the snapshot is marked remote, so no code path can render it as demo data', () => {
  assert.ok(isRemoteSnapshot(payload));
  const snapshot = snapshotFromWire(payload);
  assert.equal(snapshot.mode, 'remote');
  assert.notEqual(snapshot.mode, 'demo');
  // Attribution travels with the data, as ODbL requires.
  assert.ok((snapshot.attributions ?? []).some((entry) => /Open Prices/i.test(entry.name)));
});

test('the optimizer produces a priced plan from the real observations', () => {
  assert.ok(isRemoteSnapshot(payload));
  const snapshot = snapshotFromWire(payload);
  const concepts = [...new Set(snapshot.products.map((product) => product.canonicalConcept))];

  const plans = optimizeBasket({
    list: listFor(concepts),
    stores: snapshot.stores,
    products: snapshot.products,
    promotions: snapshot.promotions,
    preferences,
  });

  assert.ok(plans.length > 0, 'real observations must yield at least one plan');
  const plan = plans[0];
  assert.ok(plan);

  // The plan is priced from real money, and it adds up.
  assert.ok(plan.basketCostCents > 0);
  const lineSum = plan.stops
    .flatMap((stop) => stop.items)
    .reduce((sum, item) => sum + item.lineTotalCents, 0);
  assert.equal(plan.basketCostCents, lineSum, 'the basket total is the sum of its lines');

  // Provenance survives into the plan, which is what the item comparison renders.
  for (const item of plan.stops.flatMap((stop) => stop.items)) {
    assert.equal(item.source, 'community_feed');
    assert.ok(['recent', 'older', 'verify'].includes(item.freshness));
    assert.ok(!Number.isNaN(Date.parse(item.observedAt)));
    assert.match(item.storeId, /^open_prices:(node|way):\d+$/);
  }
});

test('a product claiming a store absent from the response is dropped and flagged', () => {
  // The locality rule, exercised against real data: a price is only ever valid at the store
  // it was observed at, and a snapshot that lost a product must tell the shopper coverage
  // was reduced rather than quietly thinning the basket.
  assert.ok(isRemoteSnapshot(payload));
  const tampered = {
    ...payload,
    products: [
      ...payload.products,
      { ...payload.products[0], id: 'smuggled', storeId: 'open_prices:node:999999' },
    ],
  };
  assert.ok(isRemoteSnapshot(tampered));
  const snapshot = snapshotFromWire(tampered);

  assert.equal(
    snapshot.products.some((product) => product.id === 'smuggled'),
    false,
    'a foreign-store price must never enter the plan',
  );
  assert.equal(snapshot.partial, true, 'losing a product must be reported as reduced coverage');
});
