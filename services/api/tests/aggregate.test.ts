import assert from 'node:assert/strict';
import { test } from 'node:test';

import { aggregateMarket } from '../src/retailers/aggregate.js';
import type {
  AdapterObservation,
  AdapterStore,
  NearbyStoreQuery,
  ProviderHealth,
  RetailerAdapter,
  StorePriceQuery,
} from '../src/retailers/contract.js';
import { GeoService } from '../src/retailers/geo.js';
import type { RetailerRegistry } from '../src/retailers/registry.js';

import { mockFetch, nominatim11201, overpassTwoStores } from './fixtures.js';

const UA = 'JuvaTest/1.0';

function store(id: string, name: string, distanceMiles: number): AdapterStore {
  return {
    id,
    retailerId: name.toLowerCase().replace(/\W+/g, '-'),
    retailerName: name,
    displayName: name,
    address: 'Somewhere in Brooklyn',
    latitude: 40.6931,
    longitude: -73.9899,
    distanceMiles,
  };
}

function observation(
  storeId: string,
  concept: string,
  cents: number,
  overrides: Partial<AdapterObservation> = {},
): AdapterObservation {
  return {
    observationId: `${storeId}:${concept}:${cents}`,
    sourceIdentifier: `test/${storeId}/${concept}`,
    retailerId: 'test-retailer',
    retailerName: 'Test Retailer',
    scope: { kind: 'store', storeId },
    product: { id: `p-${concept}`, name: concept },
    price: { cents, currency: 'USD' },
    source: 'community_feed',
    observedAt: new Date().toISOString(),
    confidence: 0.8,
    freshness: 'live',
    availability: 'unknown',
    attribution: {
      name: 'Test',
      url: 'https://test',
      licence: 'ODbL 1.0',
      automatedAccess: 'permitted_public_api',
    },
    matchedConcept: concept,
    ...overrides,
  };
}

/** A configurable stub adapter, so aggregation is tested independently of any API. */
function stubAdapter(config: {
  id: string;
  stores?: AdapterStore[];
  storesError?: string;
  pricesFor?: (storeId: string) => AdapterObservation[];
  pricesError?: string;
}): RetailerAdapter {
  return {
    id: config.id,
    displayName: config.id,
    capabilities: {
      pricing: true,
      localStorePricing: true,
      inventory: false,
      promotions: false,
      loyaltyPricing: false,
      productDetails: false,
      freshness: { observedAtProvided: true, expiresAtProvided: false, typical: 'mixed_or_stale' },
    },
    attribution: {
      name: config.id,
      url: 'https://test',
      licence: 'ODbL 1.0',
      automatedAccess: 'permitted_public_api',
    },
    isEnabled: () => true,
    getNearbyStores: async (_query: NearbyStoreQuery) => {
      if (config.storesError) throw new Error(config.storesError);
      return config.stores ?? [];
    },
    getPrice: async (query: StorePriceQuery) => {
      if (config.pricesError) throw new Error(config.pricesError);
      return config.pricesFor?.(query.store.id) ?? [];
    },
    /**
     * The stub implements the whole contract, including parts aggregation never calls, so a
     * future adapter method starting to be used fails to compile rather than silently
     * returning nothing.
     */
    searchProducts: async () => [],
    getProduct: async () => null,
    getPromotions: async () => [],
    getAvailability: async () => 'unknown' as const,
    health: (): ProviderHealth => ({
      adapterId: config.id,
      state: 'healthy',
      consecutiveFailures: 0,
      circuitOpen: false,
    }),
  };
}

function makeRegistry(adapters: RetailerAdapter[]): RetailerRegistry {
  const fetchImpl = mockFetch([
    { match: 'nominatim', respond: () => new Response(JSON.stringify(nominatim11201)) },
    { match: 'overpass', respond: () => new Response(JSON.stringify(overpassTwoStores)) },
  ]);
  const geo = new GeoService({
    userAgent: UA,
    fetchImpl,
    rateLimitMs: { nominatim: 0, overpass: 0 },
  });
  return {
    geo,
    all: () => adapters,
    active: () => adapters,
    hasActiveAdapters: adapters.length > 0,
    capabilityMatrix: () => [],

    /**
     * The stub implements the whole contract, including the parts aggregation never calls.
     * If a future adapter method starts being used, this stub fails to compile rather than
     * silently returning nothing.
     */
    searchProducts: async () => [],
    getProduct: async () => null,
    getPromotions: async () => [],
    getAvailability: async () => 'unknown' as const,
    health: () => adapters.map((adapter) => adapter.health()),
  } as unknown as RetailerRegistry;
}

const BASE_INPUT = {
  concepts: ['milk', 'bread'],
  location: { postalCode: '11201', countryCode: 'us' },
  radiusMiles: 5,
  currency: 'USD' as const,
};

test('one failing source does not fail the basket', async () => {
  const good = stubAdapter({
    id: 'good',
    stores: [store('good:1', 'Corner Grocer', 0.4)],
    pricesFor: (storeId) => [observation(storeId, 'milk', 349)],
  });
  const broken = stubAdapter({ id: 'broken', storesError: 'upstream on fire' });

  const market = await aggregateMarket(makeRegistry([good, broken]), BASE_INPUT);

  assert.equal(market.observations.length, 1, 'the healthy source still contributed');
  assert.equal(market.partial, true, 'the shopper is told results are thinner');
  assert.equal(market.failures.length, 1);
  assert.equal(market.failures[0]?.adapterId, 'broken');
  assert.equal(market.failures[0]?.stage, 'stores');
  assert.match(market.failures[0]?.message ?? '', /on fire/);
});

test('a store-level price failure loses only that store', async () => {
  const flaky = stubAdapter({
    id: 'flaky',
    stores: [store('flaky:1', 'A', 0.4), store('flaky:2', 'B', 0.9)],
    pricesFor: (storeId) => {
      if (storeId === 'flaky:2') throw new Error('store timed out');
      return [observation(storeId, 'milk', 299)];
    },
  });

  const market = await aggregateMarket(makeRegistry([flaky]), BASE_INPUT);

  assert.equal(market.observations.length, 1);
  assert.equal(market.stores.length, 1, 'only the store that answered is offered');
  assert.equal(market.failures[0]?.stage, 'prices');
  assert.equal(market.failures[0]?.storeId, 'flaky:2');
});

test('an observation claiming a different store is rejected and counted', async () => {
  const liar = stubAdapter({
    id: 'liar',
    stores: [store('liar:1', 'A', 0.4)],
    // Returns a price scoped to a store that was never requested.
    pricesFor: () => [observation('liar:somewhere-else', 'milk', 199)],
  });

  const market = await aggregateMarket(makeRegistry([liar]), BASE_INPUT);

  assert.deepEqual(market.observations, []);
  assert.equal(market.rejectedForStoreScope, 1);
  assert.deepEqual(market.stores, [], 'no store is offered without a verified price');
});

test('a non-store scope is never plannable', async () => {
  const national = stubAdapter({
    id: 'national',
    stores: [store('national:1', 'A', 0.4)],
    pricesFor: (storeId) => [
      observation(storeId, 'milk', 199, { scope: { kind: 'national', storeId } }),
    ],
  });

  const market = await aggregateMarket(makeRegistry([national]), BASE_INPUT);

  assert.deepEqual(market.observations, []);
  assert.equal(market.rejectedForStoreScope, 1);
});

test('coverage reports which concepts could not be priced', async () => {
  const partialSource = stubAdapter({
    id: 'partial',
    stores: [store('partial:1', 'A', 0.4)],
    // Prices milk but has nothing for bread, which is the realistic case.
    pricesFor: (storeId) => [observation(storeId, 'milk', 349)],
  });

  const market = await aggregateMarket(makeRegistry([partialSource]), BASE_INPUT);

  const milk = market.coverage.find((row) => row.concept === 'milk');
  const bread = market.coverage.find((row) => row.concept === 'bread');
  assert.equal(milk?.priced, true);
  assert.equal(milk?.storesWithPrice, 1);
  assert.equal(bread?.priced, false);
  assert.equal(bread?.observationCount, 0);
  assert.deepEqual(
    market.unpricedConcepts,
    ['bread'],
    'unpriced items are reported, not filled in',
  );
});

test('a store outside the radius cannot enter the plan even if a source returns it', async () => {
  const farAway = stubAdapter({
    id: 'far',
    // Claims a short distance while sitting in another state.
    stores: [{ ...store('far:1', 'Distant Mart', 0.2), latitude: 34.05, longitude: -118.24 }],
    pricesFor: (storeId) => [observation(storeId, 'milk', 99)],
  });

  const market = await aggregateMarket(makeRegistry([farAway]), { ...BASE_INPUT, radiusMiles: 5 });

  assert.deepEqual(market.stores, [], 'distance is recomputed against the resolved centre');
  assert.deepEqual(market.observations, []);
});

test('a currency mismatch is not mixed into the basket', async () => {
  const euro = stubAdapter({
    id: 'euro',
    stores: [store('euro:1', 'A', 0.4)],
    pricesFor: (storeId) => [
      observation(storeId, 'milk', 349, { price: { cents: 349, currency: 'EUR' } }),
    ],
  });

  const market = await aggregateMarket(makeRegistry([euro]), BASE_INPUT);
  assert.deepEqual(market.observations, []);
});

test('the resolved search centre is reported', async () => {
  const source = stubAdapter({
    id: 'src',
    stores: [store('src:1', 'A', 0.4)],
    pricesFor: (storeId) => [observation(storeId, 'milk', 349)],
  });

  const market = await aggregateMarket(makeRegistry([source]), BASE_INPUT);

  assert.equal(market.location.origin, 'postal_code');
  assert.equal(market.location.postalCode, '11201');
  assert.ok(Math.abs(market.location.latitude - 40.6925789) < 0.001);
  assert.ok(market.attributions.length > 0, 'licence attribution travels with the data');
});

test('device coordinates are used directly instead of geocoding', async () => {
  const source = stubAdapter({
    id: 'src',
    stores: [store('src:1', 'A', 0.4)],
    pricesFor: (storeId) => [observation(storeId, 'milk', 349)],
  });

  const market = await aggregateMarket(makeRegistry([source]), {
    ...BASE_INPUT,
    location: { latitude: 40.6931, longitude: -73.9899, label: 'Current location' },
  });

  assert.equal(market.location.origin, 'device');
  assert.equal(market.location.latitude, 40.6931);
});

test('aggregation refuses to run with no enabled source', async () => {
  await assert.rejects(
    aggregateMarket(makeRegistry([]), BASE_INPUT),
    /No retailer adapters are enabled/,
  );
});

test('every source failing yields an empty market, not an invented one', async () => {
  const a = stubAdapter({ id: 'a', storesError: 'down' });
  const b = stubAdapter({ id: 'b', storesError: 'also down' });

  const market = await aggregateMarket(makeRegistry([a, b]), BASE_INPUT);

  assert.deepEqual(market.stores, []);
  assert.deepEqual(market.observations, []);
  assert.equal(market.partial, true);
  assert.equal(market.failures.length, 2);
  // Reported in basket order, so it reads against the shopper's own list.
  assert.deepEqual(market.unpricedConcepts, ['milk', 'bread']);
});
