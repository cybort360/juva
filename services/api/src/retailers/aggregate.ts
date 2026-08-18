import {
  isPlannableAtStore,
  type AdapterObservation,
  type AdapterStore,
  type CurrencyCode,
  type ProviderHealth,
  type RetailerAdapter,
} from './contract.js';
import type { LocationRequest, ResolvedLocation } from './geo.js';
import { haversineMiles } from './geo.js';
import type { RetailerRegistry } from './registry.js';

/**
 * Fans out across every active retailer source and merges what comes back.
 *
 * Three invariants hold regardless of how many sources fail:
 *
 * 1. A basket is never failed because one source failed. Each store/source pair
 *    is settled independently and its failure is reported, not thrown.
 * 2. An observation is only kept if it was actually observed at the store it is
 *    being attributed to. This is re-checked here even though adapters already
 *    check it, because it is the invariant most costly to get wrong.
 * 3. Coverage is reported per concept. Items no source could price stay unpriced;
 *    nothing is substituted, estimated, or borrowed from another location.
 */

export interface MarketSearchInput {
  concepts: string[];
  location: LocationRequest;
  radiusMiles: number;
  currency: CurrencyCode;
  /** Upper bound on stores queried, to bound fan-out. Defaults to 6. */
  maxStores?: number;
  /** Drop observations older than this many days. */
  maxAgeDays?: number;
}

export interface ConceptCoverage {
  concept: string;
  /** Stores that returned at least one confirmed observation for this concept. */
  storesWithPrice: number;
  observationCount: number;
  priced: boolean;
}

export interface SourceFailure {
  adapterId: string;
  /** Absent when the failure was not specific to one store. */
  storeId?: string;
  stage: 'location' | 'stores' | 'prices';
  message: string;
}

export interface AggregatedMarket {
  location: ResolvedLocation;
  stores: AdapterStore[];
  observations: AdapterObservation[];
  coverage: ConceptCoverage[];
  /** Concepts no active source could price. */
  unpricedConcepts: string[];
  failures: SourceFailure[];
  health: ProviderHealth[];
  attributions: { name: string; url: string; licence: string; notice?: string }[];
  fetchedAt: string;
  /** True when at least one source or store failed and results may be thinner. */
  partial: boolean;
  /** Observations discarded for claiming a store they were not observed at. */
  rejectedForStoreScope: number;
}

const DEFAULT_MAX_STORES = 6;

export async function aggregateMarket(
  registry: RetailerRegistry,
  input: MarketSearchInput,
): Promise<AggregatedMarket> {
  const failures: SourceFailure[] = [];
  const adapters = registry.active();

  if (adapters.length === 0) {
    throw new Error(
      'No retailer adapters are enabled. Set JUVA_RETAILER_ADAPTERS, or run the app in demo market mode.',
    );
  }

  // Location resolution is the one genuinely fatal step: without a point on the
  // map there is no radius to search and no store to attribute a price to.
  const location = await registry.geo.resolveLocation(input.location);

  const maxStores = Math.max(1, Math.min(input.maxStores ?? DEFAULT_MAX_STORES, 12));
  const concepts = dedupe(input.concepts.map((concept) => concept.trim().toLowerCase()));

  // ── Stores, per adapter, independently ────────────────────────────────────
  const storeLists = await Promise.allSettled(
    adapters.map((adapter) =>
      adapter.getNearbyStores({
        latitude: location.latitude,
        longitude: location.longitude,
        radiusMiles: input.radiusMiles,
        limit: maxStores,
        ...(location.postalCode === undefined ? {} : { postalCode: location.postalCode }),
        ...(location.countryCode === undefined ? {} : { countryCode: location.countryCode }),
      }),
    ),
  );

  const storesByAdapter = new Map<string, AdapterStore[]>();
  storeLists.forEach((result, index) => {
    const adapter = adapters[index];
    if (!adapter) return;
    if (result.status === 'fulfilled') {
      storesByAdapter.set(adapter.id, withinRadius(result.value, location, input.radiusMiles));
    } else {
      failures.push({
        adapterId: adapter.id,
        stage: 'stores',
        message: messageOf(result.reason),
      });
    }
  });

  // ── Prices, per store, independently ─────────────────────────────────────
  interface Job {
    adapter: RetailerAdapter;
    store: AdapterStore;
  }
  const jobs: Job[] = [];
  for (const adapter of adapters) {
    for (const store of storesByAdapter.get(adapter.id) ?? []) {
      jobs.push({ adapter, store });
    }
  }

  const priceResults = await Promise.allSettled(
    jobs.map((job) =>
      job.adapter.getPrice({
        store: job.store,
        concepts,
        currency: input.currency,
        ...(input.maxAgeDays === undefined ? {} : { maxAgeDays: input.maxAgeDays }),
      }),
    ),
  );

  const observations: AdapterObservation[] = [];
  let rejectedForStoreScope = 0;

  priceResults.forEach((result, index) => {
    const job = jobs[index];
    if (!job) return;
    if (result.status !== 'fulfilled') {
      failures.push({
        adapterId: job.adapter.id,
        storeId: job.store.id,
        stage: 'prices',
        message: messageOf(result.reason),
      });
      return;
    }
    for (const observation of result.value) {
      // Invariant 2. A price that cannot prove it belongs to this store is
      // discarded, never downgraded and kept.
      if (!isPlannableAtStore(observation, job.store.id)) {
        rejectedForStoreScope += 1;
        continue;
      }
      if (observation.price.currency !== input.currency) continue;
      observations.push(observation);
    }
  });

  // Only surface stores that actually contributed a price; a store with no
  // observations is not a shopping option Juva can cost.
  const contributingStoreIds = new Set(observations.map((o) => o.scope.storeId));
  const stores = [...storesByAdapter.values()]
    .flat()
    .filter((store) => contributingStoreIds.has(store.id))
    .sort((a, b) => a.distanceMiles - b.distanceMiles);

  const coverage = buildCoverage(concepts, observations);

  return {
    location,
    stores,
    observations,
    coverage,
    unpricedConcepts: coverage.filter((row) => !row.priced).map((row) => row.concept),
    failures,
    health: registry.health(),
    attributions: dedupeAttributions(adapters),
    fetchedAt: new Date().toISOString(),
    partial: failures.length > 0,
    rejectedForStoreScope,
  };
}

function buildCoverage(concepts: string[], observations: AdapterObservation[]): ConceptCoverage[] {
  return concepts.map((concept) => {
    const matching = observations.filter((o) => o.matchedConcept === concept);
    const storeIds = new Set(matching.map((o) => o.scope.storeId));
    return {
      concept,
      storesWithPrice: storeIds.size,
      observationCount: matching.length,
      priced: matching.length > 0,
    };
  });
}

/**
 * Second radius check, against the resolved centre.
 *
 * An adapter is trusted to report distance, but not to have used the same centre
 * we resolved; recomputing here means a wrong distance cannot smuggle a far-away
 * store into a local plan.
 */
function withinRadius(
  stores: AdapterStore[],
  centre: ResolvedLocation,
  radiusMiles: number,
): AdapterStore[] {
  return stores
    .map((store) => ({
      ...store,
      distanceMiles: Number(haversineMiles(centre, store).toFixed(2)),
    }))
    .filter((store) => store.distanceMiles <= radiusMiles)
    .sort((a, b) => a.distanceMiles - b.distanceMiles);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function dedupeAttributions(
  adapters: readonly RetailerAdapter[],
): { name: string; url: string; licence: string; notice?: string }[] {
  const seen = new Map<string, { name: string; url: string; licence: string; notice?: string }>();
  for (const adapter of adapters) {
    const a = adapter.attribution;
    seen.set(a.name, {
      name: a.name,
      url: a.url,
      licence: a.licence,
      ...(a.notice === undefined ? {} : { notice: a.notice }),
    });
  }
  return [...seen.values()];
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
