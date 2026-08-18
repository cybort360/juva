import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AdapterStore } from '../src/retailers/contract.js';
import { GeoService } from '../src/retailers/geo.js';
import { OpenPricesAdapter } from '../src/retailers/openPrices.js';

import { mockFetch, nominatim11201, overpassTwoStores, priceItem, pricesPage } from './fixtures.js';

const UA = 'JuvaTest/1.0 (test@example.com)';

function makeAdapter(routes: Parameters<typeof mockFetch>[0]) {
  const fetchImpl = mockFetch(routes);
  const geo = new GeoService({
    userAgent: UA,
    fetchImpl,
    rateLimitMs: { nominatim: 0, overpass: 0 },
  });
  const adapter = new OpenPricesAdapter({ userAgent: UA, geo, fetchImpl, rateLimitMs: 0 });
  return { adapter, geo, fetchImpl };
}

const CORNER_GROCER: AdapterStore = {
  id: 'open_prices:node:111',
  retailerId: 'corner-grocer',
  retailerName: 'Corner Grocer',
  displayName: 'Corner Grocer',
  address: '48 Jay St, Brooklyn, 11201',
  latitude: 40.6931,
  longitude: -73.9899,
  distanceMiles: 0.3,
};

test('nearby stores come from OSM, keyed by OSM identity', async () => {
  const { adapter } = makeAdapter([
    { match: 'nominatim', respond: () => new Response(JSON.stringify(nominatim11201)) },
    { match: 'overpass', respond: () => new Response(JSON.stringify(overpassTwoStores)) },
  ]);

  const stores = await adapter.getNearbyStores({
    latitude: 40.6925,
    longitude: -73.9914,
    radiusMiles: 5,
    limit: 10,
  });

  assert.equal(stores.length, 2, 'the unnamed shop is not offered as a destination');
  assert.deepEqual(
    stores.map((store) => store.id),
    ['open_prices:node:111', 'open_prices:way:222'],
  );
  // Store ids are pinned to OSM identity so a branch can never merge with another.
  assert.ok(stores.every((store) => store.id.startsWith('open_prices:')));
  assert.equal(stores[0]?.address, '48 Jay St, Brooklyn, 11201');
});

test('a price is normalized with full provenance', async () => {
  const { adapter } = makeAdapter([
    { match: '/prices', respond: () => new Response(JSON.stringify(pricesPage([priceItem()]))) },
  ]);

  const observations = await adapter.getPrice({
    store: CORNER_GROCER,
    concepts: ['milk'],
    currency: 'USD',
  });

  assert.equal(observations.length, 1);
  const observation = observations[0];
  assert.ok(observation);

  assert.equal(observation.price.cents, 349, 'money is integer cents');
  assert.equal(observation.price.currency, 'USD');
  assert.equal(observation.retailerName, 'Corner Grocer');
  assert.equal(observation.source, 'community_feed');
  assert.equal(observation.matchedConcept, 'milk');
  assert.equal(observation.scope.kind, 'store');
  assert.equal(observation.scope.storeId, 'open_prices:node:111');
  assert.equal(observation.scope.postalCode, '11201');
  assert.equal(observation.scope.countryCode, 'US');
  assert.ok(observation.observedAt.startsWith('2026-08-01'));
  // No inventory feed exists, so availability is unknown rather than "in stock".
  assert.equal(observation.availability, 'unknown');
  assert.equal(observation.attribution.licence, 'ODbL 1.0');
  assert.ok(observation.confidence > 0 && observation.confidence <= 1);
  assert.equal(observation.product.brand, 'North Dairy');
});

test('a price observed at another store is discarded, not reattributed', async () => {
  // The upstream echoes a different location than the one requested.
  const { adapter } = makeAdapter([
    {
      match: '/prices',
      respond: () =>
        new Response(JSON.stringify(pricesPage([priceItem({ osmId: 999, osmType: 'NODE' })]))),
    },
  ]);

  const observations = await adapter.getPrice({
    store: CORNER_GROCER,
    concepts: ['milk'],
    currency: 'USD',
  });

  assert.deepEqual(observations, [], 'never present one branch price as another branch');
});

test('a product that is not really the concept is dropped rather than priced', async () => {
  // Real behaviour: the OFF `en:breads` category returns croutons.
  const { adapter } = makeAdapter([
    {
      match: '/prices',
      respond: () =>
        new Response(
          JSON.stringify(
            pricesPage([
              priceItem({ id: 2, productName: 'Mini croutons', categories: ['en:breads'] }),
              priceItem({ id: 3, productName: 'White Sandwich Bread', categories: ['en:breads'] }),
            ]),
          ),
        ),
    },
  ]);

  const observations = await adapter.getPrice({
    store: CORNER_GROCER,
    concepts: ['bread'],
    currency: 'USD',
  });

  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.product.name, 'White Sandwich Bread');
});

test('a name-only match is held at lower confidence than name plus category', async () => {
  const build = (categories: string[]) =>
    makeAdapter([
      {
        match: '/prices',
        respond: () =>
          new Response(
            JSON.stringify(pricesPage([priceItem({ productName: 'Whole Milk', categories })])),
          ),
      },
    ]).adapter;

  const confirmed = await build(['en:milks']).getPrice({
    store: CORNER_GROCER,
    concepts: ['milk'],
    currency: 'USD',
  });
  const nameOnly = await build(['en:beverages']).getPrice({
    store: CORNER_GROCER,
    concepts: ['milk'],
    currency: 'USD',
  });

  assert.ok(confirmed[0] && nameOnly[0]);
  assert.ok(
    nameOnly[0].confidence < confirmed[0].confidence,
    'weaker evidence must not carry equal confidence',
  );
});

test('a loyalty discount becomes a promotion with a loyalty requirement', async () => {
  const { adapter } = makeAdapter([
    {
      match: '/prices',
      respond: () =>
        new Response(
          JSON.stringify(
            pricesPage([
              priceItem({
                price: 1.25,
                discounted: true,
                priceWithoutDiscount: 2.49,
                discountType: 'LOYALTY_PROGRAM',
              }),
            ]),
          ),
        ),
    },
  ]);

  const observations = await adapter.getPrice({
    store: CORNER_GROCER,
    concepts: ['milk'],
    currency: 'USD',
  });

  const observation = observations[0];
  assert.ok(observation?.promotion);
  assert.equal(observation.price.cents, 125);
  assert.equal(observation.regularPrice?.cents, 249);
  assert.equal(observation.promotion.requirements.loyaltyRequired, true);
  assert.equal(observation.promotion.requirements.hasUnmodelledCondition, false);
  assert.equal(observation.promotion.amountOff?.cents, 124);
  assert.equal(observation.promotion.overridePrice?.cents, 125);
});

test('an unrecognised discount mechanism is flagged as unmodelled', async () => {
  const { adapter } = makeAdapter([
    {
      match: '/prices',
      respond: () =>
        new Response(
          JSON.stringify(
            pricesPage([
              priceItem({
                price: 2,
                discounted: true,
                priceWithoutDiscount: 3,
                discountType: 'MYSTERY_BUNDLE',
              }),
            ]),
          ),
        ),
    },
  ]);

  const observations = await adapter.getPrice({
    store: CORNER_GROCER,
    concepts: ['milk'],
    currency: 'USD',
  });

  assert.equal(observations[0]?.promotion?.requirements.hasUnmodelledCondition, true);
});

test('unit price is derived only when the source supports it', async () => {
  const withBasis = makeAdapter([
    {
      match: '/prices',
      respond: () =>
        new Response(JSON.stringify(pricesPage([priceItem({ pricePer: 'KILOGRAM' })]))),
    },
  ]).adapter;
  const withQuantity = makeAdapter([
    {
      match: '/prices',
      respond: () =>
        new Response(
          JSON.stringify(pricesPage([priceItem({ price: 2.5, quantity: 500, quantityUnit: 'g' })])),
        ),
    },
  ]).adapter;
  const withNeither = makeAdapter([
    { match: '/prices', respond: () => new Response(JSON.stringify(pricesPage([priceItem()]))) },
  ]).adapter;

  const query = { store: CORNER_GROCER, concepts: ['milk'], currency: 'USD' as const };

  assert.equal((await withBasis.getPrice(query))[0]?.unitPrice?.per, 'kg');
  const derived = (await withQuantity.getPrice(query))[0]?.unitPrice;
  assert.equal(derived?.per, 'kg');
  assert.equal(derived?.cents, 500, '250c per 500g is 500c per kg');
  assert.equal(
    (await withNeither.getPrice(query))[0]?.unitPrice,
    undefined,
    'unit price is omitted rather than estimated',
  );
});

test('a foreign currency observation is not mixed into the basket currency', async () => {
  const { adapter } = makeAdapter([
    {
      match: '/prices',
      respond: () => new Response(JSON.stringify(pricesPage([priceItem({ currency: 'EUR' })]))),
    },
  ]);

  const observations = await adapter.getPrice({
    store: CORNER_GROCER,
    concepts: ['milk'],
    currency: 'USD',
  });

  assert.deepEqual(observations, []);
});

test('freshness reflects observation age', async () => {
  const daysAgo = (days: number): string =>
    new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const cases: [number, string][] = [
    [0, 'live'],
    [7, 'recent'],
    [60, 'older'],
    [400, 'verify'],
  ];

  for (const [days, expected] of cases) {
    const { adapter } = makeAdapter([
      {
        match: '/prices',
        respond: () =>
          new Response(JSON.stringify(pricesPage([priceItem({ date: daysAgo(days) })]))),
      },
    ]);
    const observations = await adapter.getPrice({
      store: CORNER_GROCER,
      concepts: ['milk'],
      currency: 'USD',
    });
    assert.equal(observations[0]?.freshness, expected, `${days} days old`);
  }
});

test('maxAgeDays filters out stale observations', async () => {
  const old = new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 10);
  const { adapter } = makeAdapter([
    {
      match: '/prices',
      respond: () => new Response(JSON.stringify(pricesPage([priceItem({ date: old })]))),
    },
  ]);

  const observations = await adapter.getPrice({
    store: CORNER_GROCER,
    concepts: ['milk'],
    currency: 'USD',
    maxAgeDays: 30,
  });

  assert.deepEqual(observations, []);
});

test('an unmapped concept is skipped rather than guessed at', async () => {
  const { adapter, fetchImpl } = makeAdapter([
    { match: '/prices', respond: () => new Response(JSON.stringify(pricesPage([priceItem()]))) },
  ]);

  const observations = await adapter.getPrice({
    store: CORNER_GROCER,
    concepts: ['saffron'],
    currency: 'USD',
  });

  assert.deepEqual(observations, []);
  assert.equal(fetchImpl.calls.length, 0, 'no request is made for a concept with no mapping');
});

test('every upstream request identifies Juva, as the usage policies require', async () => {
  const { adapter, fetchImpl } = makeAdapter([
    { match: '/prices', respond: () => new Response(JSON.stringify(pricesPage([priceItem()]))) },
  ]);

  await adapter.getPrice({ store: CORNER_GROCER, concepts: ['milk'], currency: 'USD' });

  assert.ok(fetchImpl.calls.length > 0);
  assert.ok(fetchImpl.calls.every((call) => call.userAgent === UA));
});

test('the request is scoped to one store and one category', async () => {
  const { adapter, fetchImpl } = makeAdapter([
    { match: '/prices', respond: () => new Response(JSON.stringify(pricesPage([]))) },
  ]);

  await adapter.getPrice({ store: CORNER_GROCER, concepts: ['milk'], currency: 'USD' });

  const url = fetchImpl.calls[0]?.url ?? '';
  assert.match(url, /location_osm_id=111/);
  assert.match(url, /location_osm_type=NODE/);
  assert.match(url, /product__categories_tags__contains=en%3Amilks/);
});

test('declared capabilities match what the source actually provides', () => {
  const { adapter } = makeAdapter([]);
  assert.equal(adapter.capabilities.pricing, true);
  assert.equal(adapter.capabilities.localStorePricing, true);
  assert.equal(adapter.capabilities.promotions, true);
  assert.equal(adapter.capabilities.loyaltyPricing, true);
  // Verified absent against the live API: there is no stock concept at all.
  assert.equal(adapter.capabilities.inventory, false);
  assert.equal(adapter.capabilities.freshness.observedAtProvided, true);
  assert.equal(adapter.capabilities.freshness.expiresAtProvided, false);
  assert.equal(adapter.capabilities.freshness.typical, 'mixed_or_stale');
});

test('a malformed price row is skipped rather than priced at a guess', async () => {
  // Real community data contains rows with a missing price, a null product, or a
  // non-numeric amount. Each must be dropped: a basket built from a coerced `NaN` or a
  // defaulted zero would be a fabricated price wearing a real store's name.
  const { adapter } = makeAdapter([
    {
      match: '/prices',
      respond: () =>
        new Response(
          JSON.stringify(
            pricesPage([
              { ...priceItem({ id: 1 }), price: null },
              { ...priceItem({ id: 2 }), price: 'not a number' },
              { ...priceItem({ id: 3 }), currency: null },
              { ...priceItem({ id: 4 }), product: null, product_name: null },
              // No date on the row, on its proof, or on its creation record: the age is
              // unknowable, so it cannot be given a freshness and is dropped.
              { ...priceItem({ id: 5 }), date: null, proof: null, created: null },
              priceItem({ id: 6, price: 4.29 }),
            ]),
          ),
        ),
    },
  ]);

  const observations = await adapter.getPrice({
    store: CORNER_GROCER,
    concepts: ['milk'],
    currency: 'USD',
  });

  assert.equal(observations.length, 1, 'only the well-formed row survives');
  assert.equal(observations[0]?.price.cents, 429);
  assert.ok(
    observations.every((entry) => Number.isInteger(entry.price.cents) && entry.price.cents > 0),
    'no observation may carry a non-integer or non-positive amount',
  );
});

test('a row with no date of its own is dated from its price-tag proof', async () => {
  // Not a malformed row: a photograph of a price tag carries its own date, and using it is
  // more honest than discarding a real observation. What must never happen is inventing a
  // date, so a row with no date anywhere is dropped instead (above).
  const { adapter } = makeAdapter([
    {
      match: '/prices',
      respond: () =>
        new Response(
          JSON.stringify(pricesPage([{ ...priceItem({ id: 7, date: '2026-08-01' }), date: null }])),
        ),
    },
  ]);
  const observations = await adapter.getPrice({
    store: CORNER_GROCER,
    concepts: ['milk'],
    currency: 'USD',
  });
  assert.equal(observations.length, 1);
  assert.match(observations[0]?.observedAt ?? '', /^2026-08-01/);
});

test('a product with no recorded price at this store yields no observation', async () => {
  // "Unavailable" for a community source means nobody has recorded a price here — which is
  // an absence of evidence, not evidence of absence. Juva reports the concept as unpriced
  // and the optimizer surfaces it as a missing item.
  const { adapter } = makeAdapter([
    { match: '/prices', respond: () => new Response(JSON.stringify(pricesPage([]))) },
  ]);

  const observations = await adapter.getPrice({
    store: CORNER_GROCER,
    concepts: ['milk'],
    currency: 'USD',
  });
  assert.deepEqual(observations, []);
});

test('availability is unknown, never guessed, because the source has no stock feed', async () => {
  const { adapter } = makeAdapter([]);
  assert.equal(await adapter.getAvailability(CORNER_GROCER.id, '0001'), 'unknown');
  assert.equal(
    adapter.capabilities.inventory,
    false,
    'the capability must agree with the behaviour',
  );
});

test('searchProducts returns each product once, without inventing prices', async () => {
  const { adapter } = makeAdapter([
    {
      match: '/prices',
      respond: () =>
        new Response(
          JSON.stringify(
            pricesPage([
              priceItem({ id: 1, price: 3.49 }),
              priceItem({ id: 2, price: 3.79 }),
              priceItem({ id: 3, code: '0002', productName: 'Whole Milk 2', price: 4.19 }),
            ]),
          ),
        ),
    },
  ]);

  const products = await adapter.searchProducts({
    store: CORNER_GROCER,
    concepts: ['milk'],
    currency: 'USD',
  });
  // Two distinct products, though three price rows were returned.
  assert.equal(products.length, 2);
  assert.equal(new Set(products.map((entry) => entry.id)).size, products.length);
});

test('every observation carries a traceable source identifier', async () => {
  // The audit trail: given this string a human can open the upstream record and see the
  // same row Juva priced from, which is what makes a disputed figure checkable.
  const { adapter } = makeAdapter([
    {
      match: '/prices',
      respond: () => new Response(JSON.stringify(pricesPage([priceItem({ id: 4242 })]))),
    },
  ]);
  const observations = await adapter.getPrice({
    store: CORNER_GROCER,
    concepts: ['milk'],
    currency: 'USD',
  });
  assert.equal(observations[0]?.sourceIdentifier, 'price/4242');
});
