import type { FetchLike } from '../src/retailers/resilience.js';

/**
 * Mocked upstream responses, shaped from real payloads observed against the live
 * APIs so the tests exercise the same field names and quirks production sees.
 */

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export interface RecordedCall {
  url: string;
  userAgent: string | undefined;
}

/**
 * A fetch stub that routes by URL substring and records every call, so tests can
 * assert on politeness headers and on which upstream was actually contacted.
 */
export function mockFetch(
  routes: { match: string; respond: (url: string) => Response | Promise<Response> }[],
): FetchLike & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers ?? {});
    calls.push({ url, userAgent: headers.get('User-Agent') ?? undefined });
    for (const route of routes) {
      if (url.includes(route.match)) return route.respond(url);
    }
    throw new Error(`No mock route matched ${url}`);
  };
  return Object.assign(impl, { calls });
}

/** Nominatim postcode lookup, matching the live jsonv2 shape. */
export const nominatim11201 = [
  {
    lat: '40.6925789',
    lon: '-73.9914530',
    display_name: '11201, Brooklyn, Kings County, New York, United States',
    address: { postcode: '11201', country_code: 'us' },
  },
];

/** Overpass supermarket results: one node, one way with a `center`. */
export const overpassTwoStores = {
  elements: [
    {
      type: 'node',
      id: 111,
      lat: 40.6931,
      lon: -73.9899,
      tags: {
        name: 'Corner Grocer',
        shop: 'supermarket',
        'addr:housenumber': '48',
        'addr:street': 'Jay St',
        'addr:city': 'Brooklyn',
        'addr:postcode': '11201',
      },
    },
    {
      type: 'way',
      id: 222,
      center: { lat: 40.6968, lon: -73.9865 },
      tags: { name: 'North Market', brand: 'North Market', shop: 'supermarket' },
    },
    // Unnamed shop: not a destination Juva can send anyone to.
    { type: 'node', id: 333, lat: 40.6932, lon: -73.99, tags: { shop: 'supermarket' } },
  ],
};

interface PriceItemOverrides {
  id?: number;
  price?: number;
  currency?: string;
  date?: string;
  osmId?: number;
  osmType?: string;
  productName?: string;
  categories?: string[];
  discounted?: boolean;
  priceWithoutDiscount?: number;
  discountType?: string;
  proofType?: string;
  pricePer?: string;
  quantity?: number;
  quantityUnit?: string;
  code?: string;
}

/** One Open Prices item, mirroring the live field names exactly. */
export function priceItem(overrides: PriceItemOverrides = {}): Record<string, unknown> {
  const osmId = overrides.osmId ?? 111;
  const osmType = overrides.osmType ?? 'NODE';
  return {
    id: overrides.id ?? 1,
    price: overrides.price ?? 3.49,
    price_is_discounted: overrides.discounted ?? false,
    price_without_discount: overrides.priceWithoutDiscount ?? null,
    discount_type: overrides.discountType ?? null,
    price_per: overrides.pricePer ?? null,
    currency: overrides.currency ?? 'USD',
    date: overrides.date ?? '2026-08-01',
    product_code: overrides.code ?? '0001',
    product_name: overrides.productName ?? 'Whole Milk',
    owner: 'contributor',
    location_osm_id: osmId,
    location_osm_type: osmType,
    product: {
      code: overrides.code ?? '0001',
      product_name: overrides.productName ?? 'Whole Milk',
      brands: 'North Dairy, Other',
      quantity: '1 gal',
      product_quantity: overrides.quantity ?? null,
      product_quantity_unit: overrides.quantityUnit ?? null,
      categories_tags: overrides.categories ?? ['en:dairies', 'en:milks'],
    },
    location: {
      osm_id: osmId,
      osm_type: osmType,
      osm_name: 'Corner Grocer',
      osm_brand: 'Corner Grocer',
      osm_address_city: 'Brooklyn',
      osm_address_postcode: '11201',
      osm_address_country_code: 'us',
      osm_lat: 40.6931,
      osm_lon: -73.9899,
      price_count: 120,
    },
    proof: { type: overrides.proofType ?? 'PRICE_TAG', date: overrides.date ?? '2026-08-01' },
  };
}

export function pricesPage(items: Record<string, unknown>[]): Record<string, unknown> {
  return { items, total: items.length };
}
