import {
  aggregateMarket,
  type AggregatedMarket,
  type MarketSearchInput,
} from './retailers/aggregate.js';
import type { AdapterObservation, AdapterStore, CurrencyCode } from './retailers/contract.js';
import type { RetailerRegistry } from './retailers/registry.js';

/**
 * Translates aggregated retailer data into the wire shape Juva's mobile
 * optimizer consumes, and keeps the pre-existing authorized-feed contract.
 *
 * This service transports and normalizes observed prices. It never computes a
 * basket total, a saving or a recommendation: that arithmetic belongs to the
 * deterministic optimizer on the device.
 */

const FEED_TIMEOUT_MS = 10_000;
const LIVE_WINDOW_MS = 60 * 60 * 1000;

export interface MarketSearchRequest {
  concepts: string[];
  location: {
    label?: string;
    postalCode?: string;
    latitude?: number;
    longitude?: number;
    countryCode?: string;
  };
  radiusMiles: number;
  currency: CurrencyCode;
  maxStores?: number;
  maxAgeDays?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire shapes (mirror src/domain/types.ts on the device)
// ─────────────────────────────────────────────────────────────────────────────

export interface WireStore {
  id: string;
  retailerId: string;
  retailerName: string;
  displayName: string;
  address: string;
  distanceMiles: number;
  etaMinutes: number;
  colorToken: 'forest' | 'blue' | 'amber';
  latitude?: number;
  longitude?: number;
}

export interface WireObservation {
  id: string;
  storeId: string;
  retailerId: string;
  retailerProductId: string;
  scope: 'store' | 'region' | 'national' | 'online';
  priceCents: number;
  currency: CurrencyCode;
  regularPriceCents?: number;
  unitPriceCents?: number;
  unitLabel?: string;
  source: string;
  /**
   * The upstream record this price came from.
   *
   * Carried onto the wire so the audit trail survives to the client: a figure a shopper
   * disputes can be traced back to the contribution it came from, rather than having to be
   * taken on trust. Documented in docs/PRICE_GRAPH.md.
   */
  sourceIdentifier: string;
  observedAt: string;
  expiresAt?: string;
  freshness: 'live' | 'recent' | 'older' | 'verify';
  confidence: number;
  /** Receipts that independently confirmed this price. Receipt-derived prices only. */
  verificationCount?: number;
  promotionId?: string;
  available: boolean;
  availability: 'in_stock' | 'out_of_stock' | 'unknown';
}

export interface WireProduct {
  id: string;
  canonicalConcept: string;
  storeId: string;
  title: string;
  brand: string;
  sizeLabel: string;
  quantityValue?: number;
  quantityUnit?: string;
  observation: WireObservation;
}

export interface WirePromotion {
  id: string;
  retailerId: string;
  label: string;
  requiredQuantity?: number;
  loyaltyRequired?: boolean;
  expiresAt?: string;
  amountOffCents?: number;
  overridePriceCents?: number;
  hasUnmodelledCondition?: boolean;
}

export interface MarketSearchResponse {
  stores: WireStore[];
  products: WireProduct[];
  promotions: WirePromotion[];
  fetchedAt: string;
  /** Resolved search centre, so the client can show what was actually searched. */
  location: {
    label: string;
    latitude: number;
    longitude: number;
    origin: 'device' | 'postal_code';
    postalCode?: string;
    countryCode?: string;
  };
  /** Per-concept coverage. Unpriced items are reported, never filled in. */
  coverage: {
    concept: string;
    storesWithPrice: number;
    observationCount: number;
    priced: boolean;
  }[];
  unpricedConcepts: string[];
  /** Non-fatal per-source failures. Present means results may be thinner. */
  failures: { adapterId: string; storeId?: string; stage: string; message: string }[];
  partial: boolean;
  rejectedForStoreScope: number;
  providers: { adapterId: string; state: string; circuitOpen: boolean }[];
  attributions: { name: string; url: string; licence: string; notice?: string }[];
}

const COLOR_TOKENS: readonly WireStore['colorToken'][] = ['forest', 'blue', 'amber'];

/** Rough drive-time estimate. Labelled an estimate everywhere it surfaces. */
function estimateEtaMinutes(distanceMiles: number): number {
  return Math.max(4, Math.round(6 + distanceMiles * 3.2));
}

function toWireStore(store: AdapterStore, index: number): WireStore {
  return {
    id: store.id,
    retailerId: store.retailerId,
    retailerName: store.retailerName,
    displayName: store.displayName,
    address: store.address,
    distanceMiles: store.distanceMiles,
    etaMinutes: estimateEtaMinutes(store.distanceMiles),
    colorToken: COLOR_TOKENS[index % COLOR_TOKENS.length] ?? 'forest',
    latitude: store.latitude,
    longitude: store.longitude,
  };
}

/**
 * Keeps one observation per (store, product, concept): the most recently
 * observed. Multiple contributors often report the same product at the same
 * store, and the newest sighting is the most defensible one to plan on.
 */
function newestPerProduct(observations: AdapterObservation[]): AdapterObservation[] {
  const best = new Map<string, AdapterObservation>();
  for (const observation of observations) {
    const key = `${observation.scope.storeId}|${observation.product.id}|${observation.matchedConcept ?? ''}`;
    const existing = best.get(key);
    if (!existing || Date.parse(observation.observedAt) > Date.parse(existing.observedAt)) {
      best.set(key, observation);
    }
  }
  return [...best.values()];
}

function toWireProduct(observation: AdapterObservation): WireProduct | null {
  const storeId = observation.scope.storeId;
  const concept = observation.matchedConcept;
  // Without a store and a confirmed concept this cannot enter a plan.
  if (!storeId || !concept) return null;

  const wireObservation: WireObservation = {
    id: observation.observationId,
    storeId,
    retailerId: observation.retailerId,
    retailerProductId: observation.product.id,
    scope: observation.scope.kind,
    priceCents: observation.price.cents,
    currency: observation.price.currency,
    source: observation.source,
    sourceIdentifier: observation.sourceIdentifier,
    observedAt: observation.observedAt,
    freshness: observation.freshness,
    confidence: observation.confidence,
    ...(observation.verificationCount === undefined
      ? {}
      : { verificationCount: observation.verificationCount }),
    // No inventory feed means Juva plans on it but says availability is unknown.
    available: observation.availability !== 'out_of_stock',
    availability: observation.availability,
    ...(observation.regularPrice === undefined
      ? {}
      : { regularPriceCents: observation.regularPrice.cents }),
    ...(observation.unitPrice === undefined
      ? {}
      : { unitPriceCents: observation.unitPrice.cents, unitLabel: observation.unitPrice.per }),
    ...(observation.expiresAt === undefined ? {} : { expiresAt: observation.expiresAt }),
    ...(observation.promotion === undefined ? {} : { promotionId: observation.promotion.id }),
  };

  return {
    id: `${storeId}|${observation.product.id}|${concept}`,
    canonicalConcept: concept,
    storeId,
    title: observation.product.name,
    brand: observation.product.brand ?? '',
    sizeLabel: observation.product.sizeLabel ?? '',
    observation: wireObservation,
    ...(observation.product.quantityValue === undefined
      ? {}
      : { quantityValue: observation.product.quantityValue }),
    ...(observation.product.quantityUnit === undefined
      ? {}
      : { quantityUnit: observation.product.quantityUnit }),
  };
}

function toWirePromotions(observations: AdapterObservation[]): WirePromotion[] {
  const promotions = new Map<string, WirePromotion>();
  for (const observation of observations) {
    const promotion = observation.promotion;
    if (!promotion) continue;
    promotions.set(promotion.id, {
      id: promotion.id,
      retailerId: promotion.retailerId,
      label: promotion.label,
      loyaltyRequired: promotion.requirements.loyaltyRequired,
      hasUnmodelledCondition: promotion.requirements.hasUnmodelledCondition,
      ...(promotion.requirements.minimumQuantity === undefined
        ? {}
        : { requiredQuantity: promotion.requirements.minimumQuantity }),
      ...(promotion.expiresAt === undefined ? {} : { expiresAt: promotion.expiresAt }),
      ...(promotion.amountOff === undefined ? {} : { amountOffCents: promotion.amountOff.cents }),
      ...(promotion.overridePrice === undefined
        ? {}
        : { overridePriceCents: promotion.overridePrice.cents }),
    });
  }
  return [...promotions.values()];
}

export function toMarketSearchResponse(market: AggregatedMarket): MarketSearchResponse {
  const observations = newestPerProduct(market.observations);
  const products = observations
    .map(toWireProduct)
    .filter((product): product is WireProduct => product !== null);

  const usedStoreIds = new Set(products.map((product) => product.storeId));
  const stores = market.stores
    .filter((store) => usedStoreIds.has(store.id))
    .map((store, index) => toWireStore(store, index));

  return {
    stores,
    products,
    promotions: toWirePromotions(observations),
    fetchedAt: market.fetchedAt,
    location: {
      label: market.location.label,
      latitude: market.location.latitude,
      longitude: market.location.longitude,
      origin: market.location.origin,
      ...(market.location.postalCode === undefined
        ? {}
        : { postalCode: market.location.postalCode }),
      ...(market.location.countryCode === undefined
        ? {}
        : { countryCode: market.location.countryCode }),
    },
    coverage: market.coverage,
    unpricedConcepts: market.unpricedConcepts,
    failures: market.failures.map((failure) => ({
      adapterId: failure.adapterId,
      stage: failure.stage,
      message: failure.message,
      ...(failure.storeId === undefined ? {} : { storeId: failure.storeId }),
    })),
    partial: market.partial,
    rejectedForStoreScope: market.rejectedForStoreScope,
    providers: market.health.map((entry) => ({
      adapterId: entry.adapterId,
      state: entry.state,
      circuitOpen: entry.circuitOpen,
    })),
    attributions: market.attributions,
  };
}

/** Searches every enabled retailer adapter and returns the wire response. */
export async function searchRetailerAdapters(
  registry: RetailerRegistry,
  request: MarketSearchRequest,
): Promise<MarketSearchResponse> {
  const input: MarketSearchInput = {
    concepts: request.concepts,
    location: request.location,
    radiusMiles: request.radiusMiles,
    currency: request.currency,
    ...(request.maxStores === undefined ? {} : { maxStores: request.maxStores }),
    ...(request.maxAgeDays === undefined ? {} : { maxAgeDays: request.maxAgeDays }),
  };
  return toMarketSearchResponse(await aggregateMarket(registry, input));
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-existing authorized normalized feed contract
// ─────────────────────────────────────────────────────────────────────────────

interface FeedConfig {
  id: string;
  name: string;
  endpoint: string;
  authHeader?: string;
}

interface FeedStore {
  id: string;
  retailerId: string;
  retailerName: string;
  displayName: string;
  address: string;
  distanceMiles: number;
  etaMinutes: number;
  colorToken?: 'forest' | 'blue' | 'amber';
}

interface FeedProduct {
  id: string;
  canonicalConcept: string;
  storeId: string;
  title: string;
  brand: string;
  sizeLabel: string;
  priceCents: number;
  available?: boolean;
  observedAt: string;
  expiresAt?: string;
  confidence?: number;
  promotionId?: string;
  unitPriceCents?: number;
  unitLabel?: string;
  regularPriceCents?: number;
  source?: 'retailer_api' | 'affiliate_feed' | 'public_feed';
}

interface FeedPromotion {
  id: string;
  retailerId: string;
  label: string;
  requiredQuantity?: number;
  loyaltyRequired?: boolean;
  expiresAt?: string;
  amountOffCents?: number;
  overridePriceCents?: number;
}

interface NormalizedFeedResponse {
  stores: FeedStore[];
  products: FeedProduct[];
  promotions?: FeedPromotion[];
}

export function readFeedConfigs(): FeedConfig[] {
  const raw = process.env.JUVA_RETAILER_FEEDS_JSON;
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('JUVA_RETAILER_FEEDS_JSON must be an array.');
  return parsed.filter((entry): entry is FeedConfig => {
    if (!entry || typeof entry !== 'object') return false;
    const candidate = entry as Partial<FeedConfig>;
    return (
      typeof candidate.id === 'string' &&
      typeof candidate.name === 'string' &&
      typeof candidate.endpoint === 'string'
    );
  });
}

function validateFeedPayload(value: unknown): value is NormalizedFeedResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { stores?: unknown; products?: unknown; promotions?: unknown };
  return (
    Array.isArray(candidate.stores) &&
    Array.isArray(candidate.products) &&
    (candidate.promotions === undefined || Array.isArray(candidate.promotions))
  );
}

async function queryFeed(
  feed: FeedConfig,
  input: MarketSearchRequest,
): Promise<NormalizedFeedResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const response = await fetch(feed.endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(feed.authHeader ? { Authorization: feed.authHeader } : {}),
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`${feed.name} returned ${response.status}.`);
    const payload = (await response.json()) as unknown;
    if (!validateFeedPayload(payload)) {
      throw new Error(`${feed.name} returned an invalid normalized feed payload.`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fans out to authorized normalized retailer feeds.
 *
 * Kept alongside the adapter layer because a partner feed is the path to real
 * retailer-authorised pricing; adapters cover sources with a public API.
 */
export async function searchConfiguredRetailerFeeds(input: MarketSearchRequest): Promise<
  Pick<MarketSearchResponse, 'stores' | 'products' | 'promotions' | 'fetchedAt'> & {
    coverage: MarketSearchResponse['coverage'];
    failures: MarketSearchResponse['failures'];
  }
> {
  const feeds = readFeedConfigs();
  if (feeds.length === 0) {
    throw new Error(
      'No remote retailer feeds are configured. Enable an adapter with JUVA_RETAILER_ADAPTERS, configure JUVA_RETAILER_FEEDS_JSON, or use demo market mode.',
    );
  }

  const results = await Promise.allSettled(feeds.map((feed) => queryFeed(feed, input)));

  const stores: WireStore[] = [];
  const products: WireProduct[] = [];
  const promotions = new Map<string, WirePromotion>();
  const failures: MarketSearchResponse['failures'] = [];

  results.forEach((result, index) => {
    const feed = feeds[index];
    const feedName = feed?.name ?? `feed-${index}`;
    if (result.status !== 'fulfilled') {
      failures.push({
        adapterId: feed?.id ?? feedName,
        stage: 'prices',
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
      return;
    }

    const feedStoreIds = new Set(result.value.stores.map((store) => store.id));
    for (const store of result.value.stores) {
      stores.push({ ...store, colorToken: store.colorToken ?? 'forest' });
    }
    for (const product of result.value.products) {
      // A feed may only price stores it also returned; otherwise the price has no
      // verifiable location and cannot be attributed to a branch.
      if (!feedStoreIds.has(product.storeId)) continue;
      products.push(toWireProductFromFeed(product, input.currency, feed?.id ?? feedName));
    }
    for (const promotion of result.value.promotions ?? []) {
      promotions.set(promotion.id, promotion);
    }
  });

  if (stores.length === 0 || products.length === 0) {
    throw new Error('Retailer feeds returned no usable local market data.');
  }

  const concepts = [...new Set(input.concepts.map((c) => c.trim().toLowerCase()))];
  return {
    stores,
    products,
    promotions: [...promotions.values()],
    fetchedAt: new Date().toISOString(),
    coverage: concepts.map((concept) => {
      const matching = products.filter((p) => p.canonicalConcept.toLowerCase() === concept);
      return {
        concept,
        storesWithPrice: new Set(matching.map((p) => p.storeId)).size,
        observationCount: matching.length,
        priced: matching.length > 0,
      };
    }),
    failures,
  };
}

function toWireProductFromFeed(
  product: FeedProduct,
  currency: CurrencyCode,
  feedId: string,
): WireProduct {
  const observedAt = product.observedAt;
  const ageMs = Date.now() - Date.parse(observedAt);
  const freshness: WireObservation['freshness'] = ageMs < LIVE_WINDOW_MS ? 'live' : 'recent';

  return {
    id: product.id,
    canonicalConcept: product.canonicalConcept,
    storeId: product.storeId,
    title: product.title,
    brand: product.brand,
    sizeLabel: product.sizeLabel,
    observation: {
      id: `${feedId}:${product.id}:${observedAt}`,
      /**
       * Traceable back to the feed row.
       *
       * This is also the only path that can produce `live` freshness, because an authorized
       * retailer feed is the only source kind whose recency Juva can vouch for. With no feed
       * configured, `live` never appears — see docs/PRICE_GRAPH.md.
       */
      sourceIdentifier: `feed/${feedId}/${product.id}`,
      storeId: product.storeId,
      retailerId: feedId,
      retailerProductId: product.id,
      scope: 'store',
      priceCents: product.priceCents,
      currency,
      source: product.source ?? 'retailer_api',
      observedAt,
      freshness,
      confidence: product.confidence ?? 0.92,
      available: product.available ?? true,
      // A feed that states availability is trusted; silence means unknown.
      availability:
        product.available === undefined
          ? 'unknown'
          : product.available
            ? 'in_stock'
            : 'out_of_stock',
      ...(product.expiresAt === undefined ? {} : { expiresAt: product.expiresAt }),
      ...(product.promotionId === undefined ? {} : { promotionId: product.promotionId }),
      ...(product.unitPriceCents === undefined ? {} : { unitPriceCents: product.unitPriceCents }),
      ...(product.unitLabel === undefined ? {} : { unitLabel: product.unitLabel }),
      ...(product.regularPriceCents === undefined
        ? {}
        : { regularPriceCents: product.regularPriceCents }),
    },
  };
}
