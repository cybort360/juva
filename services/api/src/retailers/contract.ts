/**
 * The normalized contract every Juva retailer data source implements.
 *
 * Two rules are structural rather than advisory:
 *
 * 1. A price carries the scope it was observed at. Only `store` scope may feed a
 *    local plan, so a national or online price can never be presented as the
 *    price at a branch the shopper is about to walk into.
 * 2. A source declares what it can actually answer via `RetailerCapabilities`.
 *    Nothing infers a capability from the presence of data; if a source has no
 *    inventory feed, `inventory` is false and availability stays `unknown`
 *    rather than defaulting to "in stock".
 */

export type CurrencyCode = 'USD' | 'NGN' | 'GBP' | 'EUR';

export type PriceSourceKind =
  'retailer_api' | 'affiliate_feed' | 'public_feed' | 'community_feed' | 'receipt_verified';

/**
 * How much a price can be trusted now, derived from `observedAt`/`expiresAt`.
 * `demo` is deliberately absent: demo data never travels through an adapter.
 */
export type FreshnessState = 'live' | 'recent' | 'older' | 'verify';

export type AvailabilityState = 'in_stock' | 'out_of_stock' | 'unknown';

/** Where a price is valid. Only `store` is plannable. */
export type PriceScopeKind = 'store' | 'region' | 'national' | 'online';

// ─────────────────────────────────────────────────────────────────────────────
// Capability matrix
// ─────────────────────────────────────────────────────────────────────────────

export interface FreshnessCapability {
  /** The source states when each price was observed. */
  observedAtProvided: boolean;
  /** The source states when each price stops being valid. */
  expiresAtProvided: boolean;
  /** Honest characterisation of typical staleness, not a best case. */
  typical: 'realtime' | 'daily' | 'weekly' | 'mixed_or_stale';
}

/**
 * What a source can answer. Every `true` here is a claim Juva must be able to
 * defend against the live API, because the UI and the optimizer rely on it.
 */
export interface RetailerCapabilities {
  /** Returns prices at all. */
  pricing: boolean;
  /** Returns prices attributable to one specific physical store. */
  localStorePricing: boolean;
  /** Returns stock or availability per store. */
  inventory: boolean;
  /** Returns promotional or discounted prices. */
  promotions: boolean;
  /** Returns prices conditional on a loyalty card. */
  loyaltyPricing: boolean;
  /** Returns product detail (brand, size, barcode). */
  productDetails: boolean;
  freshness: FreshnessCapability;
}

export interface SourceAttribution {
  /** Human-readable data source name. */
  readonly name: string;
  readonly url: string;
  /** Licence the data is provided under, e.g. "ODbL 1.0". */
  readonly licence: string;
  /** Whether automated retrieval is permitted, and on what basis. */
  readonly automatedAccess: 'permitted_public_api' | 'permitted_with_credentials';
  /** Required attribution string, when the licence demands one. */
  readonly notice?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalized data
// ─────────────────────────────────────────────────────────────────────────────

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/** A store a price can be attributed to. */
export interface AdapterStore extends GeoPoint {
  /** Stable id, namespaced by adapter to avoid collisions across sources. */
  id: string;
  retailerId: string;
  retailerName: string;
  displayName: string;
  address: string;
  postalCode?: string;
  city?: string;
  countryCode?: string;
  distanceMiles: number;
  /**
   * How many priced observations this source holds for the store, when known.
   * Used to prefer stores that can actually answer, never to invent prices.
   */
  knownPriceCount?: number;
}

/** The exact scope a price belongs to. */
export interface PriceScope extends Partial<GeoPoint> {
  kind: PriceScopeKind;
  /** Set when and only when `kind === 'store'`. */
  storeId?: string;
  postalCode?: string;
  city?: string;
  countryCode?: string;
}

export interface AdapterProduct {
  /** Source-native identifier (barcode where available). */
  id: string;
  name: string;
  brand?: string;
  /** Printed size, e.g. "1 gal", "500 g". */
  sizeLabel?: string;
  quantityValue?: number;
  quantityUnit?: string;
  /** Source category tags, used for concept matching. */
  categoryTags?: string[];
  imageUrl?: string;
}

export interface Money {
  /** Integer minor units. Money never travels as a float. */
  cents: number;
  currency: CurrencyCode;
}

export interface UnitPrice extends Money {
  /** Basis the unit price is expressed per, e.g. "kg", "L", "unit". */
  per: string;
}

/**
 * Conditions that must hold for a promotional price to apply. Juva only applies
 * a promotion when it can satisfy every stated requirement, so an unmodelled
 * condition must be represented rather than dropped.
 */
export interface PromotionRequirements {
  /** Minimum units that must be bought together. */
  minimumQuantity?: number;
  /** A loyalty card or membership is required. */
  loyaltyRequired: boolean;
  /** Source-specific mechanism, e.g. "LOYALTY_PROGRAM", "SEASONAL". */
  mechanism?: string;
  /** True when the source states a condition Juva cannot evaluate. */
  hasUnmodelledCondition: boolean;
}

export interface AdapterPromotion {
  id: string;
  retailerId: string;
  label: string;
  requirements: PromotionRequirements;
  expiresAt?: string;
  /** Price to charge instead of the regular price, when stated. */
  overridePrice?: Money;
  /** Amount off the regular price, when stated. */
  amountOff?: Money;
}

/**
 * One observed price. This is the unit of truth in Juva's data layer: every
 * field below is either reported by the source or explicitly marked unknown.
 */
export interface AdapterObservation {
  observationId: string;
  retailerId: string;
  retailerName: string;
  /** Where this price is valid. Non-store scopes are rejected for planning. */
  scope: PriceScope;
  product: AdapterProduct;
  /** The price a shopper would be charged, after any applied promotion. */
  price: Money;
  /** Pre-promotion shelf price, when the source distinguishes them. */
  regularPrice?: Money;
  unitPrice?: UnitPrice;
  promotion?: AdapterPromotion;
  source: PriceSourceKind;
  observedAt: string;
  /** Set only when the source states an expiry. */
  expiresAt?: string;
  confidence: number;
  freshness: FreshnessState;
  availability: AvailabilityState;
  /** Licence/attribution of the data behind this observation. */
  attribution: SourceAttribution;
  /**
   * Which requested basket concept this observation answers. Set by the adapter
   * when it confirms a match, so the aggregator never has to re-guess intent.
   *
   * This is the canonical product identity in Juva's graph: sources disagree about
   * product ids, but they agree about "this is milk".
   */
  matchedConcept?: string;
  /**
   * Stable identity of the specific upstream record behind this price.
   *
   * The audit trail. Given this string a human can go back to the source and see the
   * same row Juva priced from, which is what makes a disputed figure checkable rather
   * than a matter of trust.
   */
  sourceIdentifier: string;
  /**
   * How many receipts have independently confirmed this price.
   *
   * Only meaningful for receipt-derived observations; absent for everything else. A price
   * two shoppers actually paid is better evidence than one nobody has checked.
   */
  verificationCount?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

export interface NearbyStoreQuery extends GeoPoint {
  radiusMiles: number;
  /** Upper bound on stores returned, so a wide radius cannot fan out unbounded. */
  limit: number;
  countryCode?: string;
  postalCode?: string;
}

export interface StorePriceQuery {
  /** The single store to price. Adapters must not widen this. */
  store: AdapterStore;
  /** Juva grocery concepts, e.g. "milk", "chicken breast". */
  concepts: string[];
  currency: CurrencyCode;
  /** Ignore observations older than this, when the caller wants only fresh data. */
  maxAgeDays?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderState = 'unknown' | 'healthy' | 'degraded' | 'unavailable';

export interface ProviderHealth {
  adapterId: string;
  state: ProviderState;
  /** Consecutive failures since the last success. */
  consecutiveFailures: number;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  /** True while a circuit breaker is suppressing calls. */
  circuitOpen: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The contract every price source implements.
 *
 * Adding a retailer is an adapter-level change: the optimizer consumes normalized
 * `AdapterObservation`s and never learns a source's name, shape or quirks. Nothing below
 * may return a price the source did not actually state.
 *
 * Every capability is *declared* rather than inferred. A source with no stock feed must
 * return `'unknown'` from `getAvailability` and `false` for `capabilities.inventory` — it
 * must never guess `in_stock`, because a plan built on an invented availability sends
 * someone to a shelf that is empty.
 */
export interface RetailerAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: RetailerCapabilities;
  readonly attribution: SourceAttribution;

  /** False when required credentials or configuration are absent. */
  isEnabled(): boolean;

  /** Stores this source can price, near a point. */
  getNearbyStores(query: NearbyStoreQuery): Promise<AdapterStore[]>;

  /**
   * Candidate products for a concept at one store.
   *
   * Returns products, not prices: a source may know a product exists at a store without
   * anyone having recorded what it costs.
   */
  searchProducts(query: StorePriceQuery): Promise<AdapterProduct[]>;

  /** Product detail by source-native id. Null when the source does not know it. */
  getProduct(productId: string): Promise<AdapterProduct | null>;

  /**
   * Priced observations for one store only.
   *
   * The batch path the aggregator uses, because one request per product would exhaust
   * every rate limit these sources impose.
   */
  getPrice(query: StorePriceQuery): Promise<AdapterObservation[]>;

  /**
   * Promotions as first-class records.
   *
   * Sources that inline discounts into a price return them on the observation instead and
   * may return an empty array here — `capabilities.promotions` says which.
   */
  getPromotions(query: StorePriceQuery): Promise<AdapterPromotion[]>;

  /**
   * Stock state for one product at one store.
   *
   * `'unknown'` is the correct and expected answer for every source without a real stock
   * feed, and is what `capabilities.inventory: false` promises.
   */
  getAvailability(storeId: string, productId: string): Promise<AvailabilityState>;

  health(): ProviderHealth;
}

/** Freshness thresholds, in days, shared by every adapter. */
export const FRESHNESS_THRESHOLD_DAYS = {
  live: 2,
  recent: 14,
  older: 120,
} as const;

/**
 * Classifies an observation age into a freshness state.
 *
 * An expired price is `verify` regardless of age: a stated expiry is a stronger
 * signal than recency.
 */
export function classifyFreshness(
  observedAt: string,
  now: Date = new Date(),
  expiresAt?: string,
): FreshnessState {
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return 'verify';

  if (expiresAt !== undefined) {
    const expiresMs = Date.parse(expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs <= now.getTime()) return 'verify';
  }

  const ageDays = (now.getTime() - observedMs) / 86_400_000;
  // A timestamp meaningfully in the future is not trustworthy.
  if (ageDays < -1) return 'verify';
  if (ageDays <= FRESHNESS_THRESHOLD_DAYS.live) return 'live';
  if (ageDays <= FRESHNESS_THRESHOLD_DAYS.recent) return 'recent';
  if (ageDays <= FRESHNESS_THRESHOLD_DAYS.older) return 'older';
  return 'verify';
}

/**
 * Guards Juva's core locality rule: a price observed at one store is never
 * reusable as the price at another location.
 */
export function isPlannableAtStore(observation: AdapterObservation, storeId: string): boolean {
  return observation.scope.kind === 'store' && observation.scope.storeId === storeId;
}
