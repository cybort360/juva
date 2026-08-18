import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GeoService,
  haversineMiles,
  isValidGeoPoint,
  milesToMetres,
} from '../src/retailers/geo.js';

import { mockFetch, nominatim11201, overpassTwoStores } from './fixtures.js';

const UA = 'JuvaTest/1.0';

function service(routes: Parameters<typeof mockFetch>[0]) {
  const fetchImpl = mockFetch(routes);
  return {
    fetchImpl,
    geo: new GeoService({
      userAgent: UA,
      fetchImpl,
      rateLimitMs: { nominatim: 0, overpass: 0 },
    }),
  };
}

test('haversine distance matches a known separation', () => {
  // Brooklyn Bridge to Prospect Park is roughly 3 miles.
  const miles = haversineMiles(
    { latitude: 40.7061, longitude: -73.9969 },
    { latitude: 40.6602, longitude: -73.969 },
  );
  assert.ok(miles > 3 && miles < 3.9, `got ${miles}`);
  assert.equal(haversineMiles({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 }), 0);
});

test('miles convert to metres for the Overpass radius', () => {
  assert.equal(Math.round(milesToMetres(1)), 1609);
});

test('coordinate validation rejects impossible and missing values', () => {
  assert.equal(isValidGeoPoint({ latitude: 40, longitude: -73 }), true);
  assert.equal(isValidGeoPoint({ latitude: 91, longitude: 0 }), false);
  assert.equal(isValidGeoPoint({ latitude: 0, longitude: 181 }), false);
  assert.equal(isValidGeoPoint({ latitude: Number.NaN, longitude: 0 }), false);
  assert.equal(isValidGeoPoint({ longitude: 0 }), false);
  assert.equal(isValidGeoPoint(undefined), false);
});

test('a postcode is geocoded and cached', async () => {
  const { geo, fetchImpl } = service([
    { match: 'nominatim', respond: () => new Response(JSON.stringify(nominatim11201)) },
  ]);

  const first = await geo.resolveLocation({ postalCode: '11201', countryCode: 'us' });
  assert.equal(first.origin, 'postal_code');
  assert.equal(first.postalCode, '11201');
  assert.equal(first.countryCode, 'US');
  assert.ok(Math.abs(first.latitude - 40.6925789) < 1e-6);

  const callsAfterFirst = fetchImpl.calls.length;
  await geo.resolveLocation({ postalCode: '11201', countryCode: 'us' });
  assert.equal(fetchImpl.calls.length, callsAfterFirst, 'the second lookup is served from cache');
});

test('device coordinates skip geocoding entirely', async () => {
  const { geo, fetchImpl } = service([]);

  const resolved = await geo.resolveLocation({ latitude: 40.69, longitude: -73.99 });

  assert.equal(resolved.origin, 'device');
  assert.equal(fetchImpl.calls.length, 0, 'exact coordinates are not degraded by geocoding');
});

test('an unresolvable postcode is an explicit error', async () => {
  const { geo } = service([{ match: 'nominatim', respond: () => new Response('[]') }]);

  await assert.rejects(
    geo.resolveLocation({ postalCode: 'ZZ999', countryCode: 'us' }),
    /Could not locate postcode/,
  );
});

test('a location with neither coordinates nor postcode is rejected', async () => {
  const { geo } = service([]);
  await assert.rejects(geo.resolveLocation({}), /postcode or device coordinates are required/);
});

test('grocery stores are parsed from Overpass, including ways with a centre', async () => {
  const { geo } = service([
    { match: 'overpass', respond: () => new Response(JSON.stringify(overpassTwoStores)) },
  ]);

  const stores = await geo.findGroceryStores({ latitude: 40.6925, longitude: -73.9914 }, 5, 10);

  assert.equal(stores.length, 2, 'the unnamed shop is dropped');
  const node = stores.find((store) => store.osmType === 'node');
  const way = stores.find((store) => store.osmType === 'way');
  assert.equal(node?.name, 'Corner Grocer');
  assert.equal(node?.postalCode, '11201');
  assert.equal(way?.name, 'North Market');
  assert.ok(way?.latitude === 40.6968, 'a way uses its representative centre');
  assert.ok(stores.every((store) => store.distanceMiles >= 0));
  // Sorted nearest first, so the caller can bound work by proximity.
  assert.ok((stores[0]?.distanceMiles ?? 0) <= (stores[1]?.distanceMiles ?? 0));
});

test('stores beyond the radius are excluded', async () => {
  const faraway = {
    elements: [
      {
        type: 'node',
        id: 1,
        lat: 34.05,
        lon: -118.24,
        tags: { name: 'LA Market', shop: 'supermarket' },
      },
    ],
  };
  const { geo } = service([
    { match: 'overpass', respond: () => new Response(JSON.stringify(faraway)) },
  ]);

  const stores = await geo.findGroceryStores({ latitude: 40.6925, longitude: -73.9914 }, 5, 10);
  assert.deepEqual(stores, []);
});

test('store discovery is cached per centre and radius', async () => {
  const { geo, fetchImpl } = service([
    { match: 'overpass', respond: () => new Response(JSON.stringify(overpassTwoStores)) },
  ]);

  await geo.findGroceryStores({ latitude: 40.6925, longitude: -73.9914 }, 5, 10);
  const after = fetchImpl.calls.length;
  await geo.findGroceryStores({ latitude: 40.6925, longitude: -73.9914 }, 5, 10);

  assert.equal(fetchImpl.calls.length, after, 'repeat searches do not re-hit Overpass');
});

test('both OSM services receive an identifying User-Agent', async () => {
  const { geo, fetchImpl } = service([
    { match: 'nominatim', respond: () => new Response(JSON.stringify(nominatim11201)) },
    { match: 'overpass', respond: () => new Response(JSON.stringify(overpassTwoStores)) },
  ]);

  await geo.resolveLocation({ postalCode: '11201', countryCode: 'us' });
  await geo.findGroceryStores({ latitude: 40.6925, longitude: -73.9914 }, 5, 10);

  assert.equal(fetchImpl.calls.length, 2);
  assert.ok(fetchImpl.calls.every((call) => call.userAgent === UA));
});
