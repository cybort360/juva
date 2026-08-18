import { matchConcept, mappingForConcept } from './concepts.js';
import {
  classifyFreshness,
  type AdapterObservation,
  type AdapterProduct,
  type AdapterPromotion,
  type AdapterStore,
  type AvailabilityState,
  type CurrencyCode,
  type NearbyStoreQuery,
  type ProviderHealth,
  type RetailerAdapter,
  type RetailerCapabilities,
  type SourceAttribution,
  type StorePriceQuery,
} from './contract.js';
import { formatOsmAddress, type GeoService, type OsmStore } from './geo.js';
import { HealthTracker, JsonClient, RateLimiter, TtlCache, type FetchLike } from './resilience.js';

/**
 * Open Food Facts **Open Prices** adapter — Juva's first real price source.
 *
 * Why this source: reads need no credentials, automated access is permitted, and
 * every price is already attributed to a specific OpenStreetMap store, which is
 * exactly what Juva's locality rule requires.
 *
 * What it is not: this is community-contributed data, not retailer-authorised
 * pricing. Coverage is narrow and uneven, fresh produce and meat are largely
 * absent, and many observations are months old. Those are reported through
 * `capabilities`, `freshness` and per-item coverage rather than smoothed over.
 *
 * Measured behaviour this adapter is built around:
 * - `/locations` has no geo filter and *silently ignores* unsupported params, so
 *   store discovery goes through OSM instead and is joined by `osm_id`.
 * - `/prices` does honour `location_osm_id` + `location_osm_type`, and echoes the
 *   location on each item, so store scope is verified rather than assumed.
 */

const API_BASE = 'https://prices.openfoodfacts.org/api/v1';
const MIN_INTERVAL_MS = 350;
const PRICES_TTL_MS = 30 * 60 * 1000;
const PAGE_SIZE = 50;

export const OPEN_PRICES_ATTRIBUTION: SourceAttribution = {
  name: 'Open Food Facts — Open Prices',
  url: 'https://prices.openfoodfacts.org',
  licence: 'ODbL 1.0',
  automatedAccess: 'permitted_public_api',
  notice: 'Price data from Open Food Facts Open Prices contributors, ODbL 1.0.',
};

/**
 * Declared capabilities, each verified against the live API rather than assumed.
 * `inventory` is false because the source has no stock concept at all.
 */
export const OPEN_PRICES_CAPABILITIES: RetailerCapabilities = {
  pricing: true,
  localStorePricing: true,
  inventory: false,
  promotions: true,
  loyaltyPricing: true,
  productDetails: true,
  freshness: {
    observedAtProvided: true,
    expiresAtProvided: false,
    typical: 'mixed_or_stale',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Upstream shapes
// ─────────────────────────────────────────────────────────────────────────────

interface OpenPricesProduct {
  code?: string | null;
  product_name?: string | null;
  brands?: string | null;
  quantity?: string | null;
  product_quantity?: number | null;
  product_quantity_unit?: string | null;
  categories_tags?: string[] | null;
  image_url?: string | null;
}

interface OpenPricesLocation {
  osm_id?: number | null;
  osm_type?: string | null;
  osm_name?: string | null;
  osm_brand?: string | null;
  osm_address_city?: string | null;
  osm_address_postcode?: string | null;
  osm_address_country_code?: string | null;
  osm_lat?: number | null;
  osm_lon?: number | null;
  price_count?: number | null;
}

interface OpenPricesProof {
  type?: string | null;
  date?: string | null;
}

interface OpenPricesItem {
  id?: number;
  price?: number | null;
  price_without_discount?: number | null;
  price_is_discounted?: boolean | null;
  discount_type?: string | null;
  price_per?: string | null;
  currency?: string | null;
  date?: string | null;
  created?: string | null;
  product_code?: string | null;
  product_name?: string | null;
  owner?: string | null;
  location_osm_id?: number | null;
  location_osm_type?: string | null;
  product?: OpenPricesProduct | null;
  location?: OpenPricesLocation | null;
  proof?: OpenPricesProof | null;
}

interface OpenPricesPage {
  items?: OpenPricesItem[];
  total?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

export interface OpenPricesAdapterOptions {
  readonly userAgent: string;
  readonly geo: GeoService;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  /** Set false to disable this source without removing it. */
  readonly enabled?: boolean;
  /** Minimum interval between calls. Only lower it for tests against mocks. */
  readonly rateLimitMs?: number;
}

export class OpenPricesAdapter implements RetailerAdapter {
  readonly id = 'open_prices';
  readonly displayName = 'Open Prices (Open Food Facts)';
  readonly capabilities = OPEN_PRICES_CAPABILITIES;
  readonly attribution = OPEN_PRICES_ATTRIBUTION;

  private readonly client: JsonClient;
  private readonly healthTracker: HealthTracker;
  private readonly cache = new TtlCache<AdapterObservation[]>(PRICES_TTL_MS, 300);
  private readonly geo: GeoService;
  private readonly enabled: boolean;

  constructor(options: OpenPricesAdapterOptions) {
    this.geo = options.geo;
    this.enabled = options.enabled ?? true;
    this.healthTracker = new HealthTracker(this.id);
    this.client = new JsonClient({
      userAgent: options.userAgent,
      timeoutMs: options.timeoutMs ?? 8_000,
      maxAttempts: 3,
      rateLimiter: new RateLimiter(options.rateLimitMs ?? MIN_INTERVAL_MS),
      health: this.healthTracker,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Products this source knows about at a store, without their prices.
   *
   * Derived from the priced rows because Open Prices has no catalogue endpoint: it knows a
   * product exists at a store precisely because someone recorded a price there. Returned
   * de-duplicated by product id.
   */
  async searchProducts(query: StorePriceQuery): Promise<AdapterProduct[]> {
    const observations = await this.getPrice(query);
    const seen = new Map<string, AdapterProduct>();
    for (const observation of observations) {
      if (!seen.has(observation.product.id)) seen.set(observation.product.id, observation.product);
    }
    return [...seen.values()];
  }

  /**
   * Promotions, taken from the priced rows rather than a separate feed.
   *
   * Open Prices inlines a discount onto the price it belongs to, so there is no promotions
   * endpoint to call. Returning them here keeps the interface uniform for retailers that
   * do publish promotions separately.
   */
  async getPromotions(query: StorePriceQuery): Promise<AdapterPromotion[]> {
    const observations = await this.getPrice(query);
    return observations
      .map((observation) => observation.promotion)
      .filter((promotion): promotion is AdapterPromotion => promotion !== undefined);
  }

  /**
   * Always `'unknown'`, and that is the honest answer.
   *
   * Open Prices records what something cost when a shopper saw it, never whether it is on
   * the shelf now. `capabilities.inventory` is false for exactly this reason, and guessing
   * `in_stock` would send someone to an empty shelf on Juva's word.
   */
  async getAvailability(_storeId: string, _productId: string): Promise<AvailabilityState> {
    return 'unknown';
  }

  health(): ProviderHealth {
    return this.healthTracker.snapshot();
  }

  /**
   * Nearby stores this source may be able to price.
   *
   * Geography comes from OSM, keyed by `osm_id`, which is the same identity Open
   * Prices attributes its prices to. Whether a given store has any prices is not
   * pre-checked: that would cost an extra request per store and the price query
   * itself already answers it. Stores that return nothing are dropped later by
   * the aggregator rather than guessed at here.
   */
  async getNearbyStores(query: NearbyStoreQuery): Promise<AdapterStore[]> {
    const osmStores = await this.geo.findGroceryStores(
      { latitude: query.latitude, longitude: query.longitude },
      query.radiusMiles,
      query.limit,
    );
    return osmStores.map((store) => this.toAdapterStore(store));
  }

  private toAdapterStore(store: OsmStore): AdapterStore {
    return {
      // Namespaced and pinned to OSM identity, so the same physical store is the
      // same id across every request and can never merge with a different branch.
      id: `${this.id}:${store.osmType}:${store.osmId}`,
      retailerId: slugifyRetailer(store.brand ?? store.name),
      retailerName: store.brand ?? store.name,
      displayName: store.name,
      address: formatOsmAddress(store),
      latitude: store.latitude,
      longitude: store.longitude,
      distanceMiles: Number(store.distanceMiles.toFixed(2)),
      ...(store.postalCode === undefined ? {} : { postalCode: store.postalCode }),
      ...(store.city === undefined ? {} : { city: store.city }),
    };
  }

  /**
   * Prices for one store and one basket.
   *
   * One request per concept keeps each response small and lets a single failing
   * concept degrade to "not priced" instead of losing the whole store.
   */
  async getPrice(query: StorePriceQuery): Promise<AdapterObservation[]> {
    const osm = parseStoreId(query.store.id);
    if (!osm) return [];

    const observations: AdapterObservation[] = [];
    // A concept maps to several category tags and one product often carries more
    // than one of them, so the same physical price tag can come back twice.
    // Deduplicating here keeps coverage counts honest about how much independent
    // evidence there actually is.
    const seen = new Set<string>();

    for (const concept of query.concepts) {
      const mapping = mappingForConcept(concept);
      // An unmapped concept is reported as uncovered, not guessed at.
      if (!mapping) continue;

      for (const categoryTag of mapping.categoryTags) {
        const cacheKey = `${query.store.id}|${categoryTag}|${query.currency}`;
        const cached = this.cache.get(cacheKey);
        const items = cached ?? (await this.fetchCategoryPage(osm, categoryTag, cacheKey));

        for (const observation of items) {
          if (observation.price.currency !== query.currency) continue;
          const product = observation.product;
          const match = matchConcept(concept, product.name, product.categoryTags ?? []);
          if (!match.matched) continue;
          if (isTooOld(observation.observedAt, query.maxAgeDays)) continue;

          const key = `${concept}|${observation.observationId}`;
          if (seen.has(key)) continue;
          seen.add(key);

          observations.push({
            ...observation,
            // Name-only matches are held at lower confidence than name+category.
            confidence: Number((observation.confidence * match.strength).toFixed(3)),
            matchedConcept: concept,
          });
        }
      }
    }

    return observations;
  }

  private async fetchCategoryPage(
    osm: ParsedStoreId,
    categoryTag: string,
    cacheKey: string,
  ): Promise<AdapterObservation[]> {
    const url =
      `${API_BASE}/prices?location_osm_id=${osm.osmId}` +
      `&location_osm_type=${osm.osmType.toUpperCase()}` +
      `&product__categories_tags__contains=${encodeURIComponent(categoryTag)}` +
      `&order_by=-date&size=${PAGE_SIZE}`;

    const page = await this.client.getJson<OpenPricesPage>(url);
    const observations = (page.items ?? [])
      .map((item) => this.toObservation(item, osm))
      .filter((value): value is AdapterObservation => value !== null);

    this.cache.set(cacheKey, observations);
    return observations;
  }

  async getProduct(productId: string): Promise<AdapterProduct | null> {
    const url = `${API_BASE}/products?code=${encodeURIComponent(productId)}&size=1`;
    const page = await this.client.getJson<{ items?: OpenPricesProduct[] }>(url);
    const product = page.items?.[0];
    return product ? toProduct(product, productId) : null;
  }

  /**
   * Normalizes one upstream price.
   *
   * Returns null rather than a partial record whenever the item fails a check.
   * In particular the echoed `location` must match the store that was requested:
   * that is the last line of defence against attributing one branch's price to
   * another location.
   */
  private toObservation(item: OpenPricesItem, requested: ParsedStoreId): AdapterObservation | null {
    const priceCents = toCents(item.price);
    if (priceCents === null || priceCents <= 0) return null;

    const currency = toCurrency(item.currency);
    if (!currency) return null;

    const echoedId = item.location?.osm_id ?? item.location_osm_id;
    const echoedType = (item.location?.osm_type ?? item.location_osm_type ?? '').toLowerCase();
    if (echoedId !== requested.osmId || echoedType !== requested.osmType) return null;

    const observedAt = toIsoDate(item.date ?? item.proof?.date ?? item.created);
    if (!observedAt) return null;

    const storeId = `${this.id}:${requested.osmType}:${requested.osmId}`;
    const location = item.location ?? {};
    const productCode = item.product_code ?? item.product?.code ?? undefined;
    const product = toProduct(
      item.product ?? {},
      productCode ?? `${this.id}-unknown-${item.id ?? 'na'}`,
      item.product_name ?? undefined,
    );

    const regularCents = toCents(item.price_without_discount);
    const discounted = item.price_is_discounted === true && regularCents !== null;
    const promotion = discounted
      ? buildPromotion(item, priceCents, regularCents, currency, storeId)
      : undefined;

    const proofType = (item.proof?.type ?? '').toUpperCase();
    const observation: AdapterObservation = {
      observationId: `${this.id}:${item.id ?? `${productCode}-${observedAt}`}`,
      /**
       * The upstream Open Prices row.
       *
       * `price/<id>` is resolvable on prices.openfoodfacts.org, so a disputed figure can be
       * traced back to the contribution it came from rather than taken on trust.
       */
      sourceIdentifier: item.id === undefined ? `product/${productCode}` : `price/${item.id}`,
      retailerId: slugifyRetailer(location.osm_brand ?? location.osm_name ?? 'unknown'),
      retailerName: location.osm_brand ?? location.osm_name ?? 'Unknown retailer',
      scope: {
        kind: 'store',
        storeId,
        ...(typeof location.osm_lat === 'number' ? { latitude: location.osm_lat } : {}),
        ...(typeof location.osm_lon === 'number' ? { longitude: location.osm_lon } : {}),
        ...(location.osm_address_postcode ? { postalCode: location.osm_address_postcode } : {}),
        ...(location.osm_address_city ? { city: location.osm_address_city } : {}),
        ...(location.osm_address_country_code
          ? { countryCode: location.osm_address_country_code.toUpperCase() }
          : {}),
      },
      product,
      price: { cents: priceCents, currency },
      source: 'community_feed',
      observedAt,
      confidence: confidenceForProof(proofType),
      freshness: classifyFreshness(observedAt),
      // The source has no stock feed, so availability is unknown, never "in stock".
      availability: 'unknown',
      attribution: OPEN_PRICES_ATTRIBUTION,
      ...(regularCents === null ? {} : { regularPrice: { cents: regularCents, currency } }),
      ...(promotion === undefined ? {} : { promotion }),
    };

    const unitPrice = deriveUnitPrice(item, priceCents, currency);
    return unitPrice === undefined ? observation : { ...observation, unitPrice };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedStoreId {
  osmType: 'node' | 'way' | 'relation';
  osmId: number;
}

export function parseStoreId(storeId: string): ParsedStoreId | null {
  const parts = storeId.split(':');
  if (parts.length !== 3 || parts[0] !== 'open_prices') return null;
  const osmType = parts[1];
  const osmId = Number(parts[2]);
  if (osmType !== 'node' && osmType !== 'way' && osmType !== 'relation') return null;
  if (!Number.isInteger(osmId)) return null;
  return { osmType, osmId };
}

export function slugifyRetailer(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'unknown'
  );
}

/** Money crosses the boundary as integer cents, rounded once, here. */
function toCents(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

function toCurrency(value: string | null | undefined): CurrencyCode | null {
  const upper = (value ?? '').toUpperCase();
  return upper === 'USD' || upper === 'EUR' || upper === 'GBP' || upper === 'NGN' ? upper : null;
}

function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value.length === 10 ? `${value}T12:00:00Z` : value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function isTooOld(observedAt: string, maxAgeDays: number | undefined): boolean {
  if (maxAgeDays === undefined) return false;
  const ageDays = (Date.now() - Date.parse(observedAt)) / 86_400_000;
  return ageDays > maxAgeDays;
}

/**
 * Confidence by evidence type. A photographed price tag is stronger evidence
 * than a bulk shop import, and both are weaker than a retailer feed.
 */
function confidenceForProof(proofType: string): number {
  switch (proofType) {
    case 'PRICE_TAG':
      return 0.8;
    case 'RECEIPT':
      return 0.75;
    case 'GDPR_REQUEST':
      return 0.7;
    case 'SHOP_IMPORT':
      return 0.6;
    default:
      return 0.5;
  }
}

function toProduct(
  raw: OpenPricesProduct,
  fallbackId: string,
  fallbackName?: string,
): AdapterProduct {
  const name = raw.product_name ?? fallbackName ?? 'Unnamed product';
  const brand = raw.brands?.split(',')[0]?.trim();
  return {
    id: raw.code ?? fallbackId,
    name,
    ...(brand ? { brand } : {}),
    ...(raw.quantity ? { sizeLabel: raw.quantity } : {}),
    ...(typeof raw.product_quantity === 'number' ? { quantityValue: raw.product_quantity } : {}),
    ...(raw.product_quantity_unit ? { quantityUnit: raw.product_quantity_unit } : {}),
    ...(raw.categories_tags ? { categoryTags: raw.categories_tags } : {}),
    ...(raw.image_url ? { imageUrl: raw.image_url } : {}),
  };
}

/**
 * Builds a promotion from a discounted price.
 *
 * `LOYALTY_PROGRAM` is the mechanism this source reports most often, and it maps
 * onto a real requirement: Juva must not promise that price to a shopper without
 * the card. Any other mechanism is flagged as unmodelled so the optimizer can
 * decline to apply it rather than assume it is unconditional.
 */
function buildPromotion(
  item: OpenPricesItem,
  priceCents: number,
  regularCents: number,
  currency: CurrencyCode,
  storeId: string,
): AdapterPromotion {
  const mechanism = (item.discount_type ?? '').toUpperCase();
  const loyaltyRequired = mechanism === 'LOYALTY_PROGRAM';
  const known = new Set(['LOYALTY_PROGRAM', 'SEASONAL', 'EXPIRY_SOON', 'PROMOTION', '']);
  return {
    id: `open_prices:promo:${item.id ?? `${storeId}-${priceCents}`}`,
    retailerId: slugifyRetailer(item.location?.osm_brand ?? item.location?.osm_name ?? 'unknown'),
    label: promotionLabel(mechanism, regularCents, priceCents, currency),
    requirements: {
      loyaltyRequired,
      ...(mechanism ? { mechanism } : {}),
      hasUnmodelledCondition: !known.has(mechanism),
    },
    overridePrice: { cents: priceCents, currency },
    amountOff: { cents: Math.max(0, regularCents - priceCents), currency },
  };
}

function promotionLabel(
  mechanism: string,
  regularCents: number,
  priceCents: number,
  currency: CurrencyCode,
): string {
  const off = ((regularCents - priceCents) / 100).toFixed(2);
  const symbol =
    currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '';
  if (mechanism === 'LOYALTY_PROGRAM') return `${symbol}${off} off with loyalty card`;
  if (mechanism === 'EXPIRY_SOON') return `${symbol}${off} off, near expiry`;
  return `${symbol}${off} off`;
}

/**
 * Unit price, only where the source actually supports it.
 *
 * `price_per` states the basis; a stated quantity lets us divide. When neither is
 * present the field is omitted rather than estimated from the size label.
 */
function deriveUnitPrice(
  item: OpenPricesItem,
  priceCents: number,
  currency: CurrencyCode,
): { cents: number; currency: CurrencyCode; per: string } | undefined {
  const basis = (item.price_per ?? '').toUpperCase();
  if (basis === 'KILOGRAM') return { cents: priceCents, currency, per: 'kg' };
  if (basis === 'UNIT') return { cents: priceCents, currency, per: 'unit' };

  const quantity = item.product?.product_quantity;
  const unit = (item.product?.product_quantity_unit ?? '').toLowerCase();
  if (typeof quantity !== 'number' || quantity <= 0) return undefined;

  if (unit === 'g') {
    return { cents: Math.round((priceCents / quantity) * 1000), currency, per: 'kg' };
  }
  if (unit === 'ml') {
    return { cents: Math.round((priceCents / quantity) * 1000), currency, per: 'L' };
  }
  return undefined;
}
