import { MAX_COMBINATION_SIZE } from './optimizer';
import type {
  Freshness,
  GroceryList,
  MarketSnapshot,
  MarketSnapshotMeta,
  RetailerProduct,
  Store,
  UserPreferences,
} from './types';

/** Least trustworthy first, so the weakest link in a plan is what gets reported. */
const FRESHNESS_RANK: Record<Freshness, number> = {
  verify: 0,
  older: 1,
  recent: 2,
  demo: 3,
  live: 4,
};

/**
 * The weakest freshness across a snapshot's observations.
 *
 * An empty set returns `verify`, the least trustworthy value — deliberately, and not as a
 * detail. Seeding the reduction with `live` meant a snapshot containing *no* observations
 * reported itself as live, and the searching screen renders exactly that as "LIVE MARKET".
 * A retailer search that returns nothing is the normal shape of a total API failure, so
 * the failure case was the case that claimed freshness. There is nothing to be fresh about
 * when there is nothing there.
 */
function weakestFreshness(products: RetailerProduct[]): Freshness {
  if (products.length === 0) return 'verify';
  return products.reduce<Freshness>((worst, product) => {
    const candidate = product.observation.freshness;
    return FRESHNESS_RANK[candidate] < FRESHNESS_RANK[worst] ? candidate : worst;
  }, 'live');
}

/**
 * Drops any product whose price cannot be attributed to the store it claims.
 *
 * The API enforces this too. It is re-checked on the device because it is the
 * invariant most costly to get wrong: one branch's price shown as another's would
 * make every total, saving and recommendation downstream a fiction.
 */
export function keepStoreScopedProducts(
  products: readonly RetailerProduct[],
  stores: readonly Store[],
): { kept: RetailerProduct[]; rejected: number } {
  const storeIds = new Set(stores.map((store) => store.id));
  const kept = products.filter(
    (product) =>
      product.observation.scope === 'store' &&
      product.observation.storeId === product.storeId &&
      storeIds.has(product.storeId),
  );
  return { kept, rejected: products.length - kept.length };
}

/** Store combinations of size 1..maxSize that the optimizer enumerates. */
export function countCombinations(storeCount: number, maxSize: number): number {
  const limit = Math.min(storeCount, maxSize);
  let total = 0;
  for (let size = 1; size <= limit; size += 1) {
    let choose = 1;
    for (let i = 0; i < size; i += 1) choose = (choose * (storeCount - i)) / (i + 1);
    total += Math.round(choose);
  }
  return total;
}

/**
 * Facts about a snapshot, for screens that would otherwise be tempted to
 * estimate. Every field counts something actually present in the data, scoped
 * to the stores the optimizer is allowed to consider.
 */
export function describeSnapshot(
  list: GroceryList,
  snapshot: MarketSnapshot,
  preferences: UserPreferences,
): MarketSnapshotMeta {
  const eligibleStores = snapshot.stores.filter(
    (store) => store.distanceMiles <= preferences.radiusMiles,
  );
  const eligibleStoreIds = new Set(eligibleStores.map((store) => store.id));
  const concepts = new Set(list.items.map((item) => item.concept.toLowerCase()));

  const inRange = snapshot.products.filter((product) => eligibleStoreIds.has(product.storeId));
  const matched = inRange.filter(
    (product) =>
      product.observation.available && concepts.has(product.canonicalConcept.toLowerCase()),
  );
  const matchedPromotionIds = new Set(
    matched
      .map((product) => product.observation.promotionId)
      .filter((id): id is string => Boolean(id)),
  );

  // Concepts with no confirmed observation in range, unioned with whatever the
  // source itself reported as unpriced. Kept in basket order: the shopper reads
  // this against their own list, not alphabetically.
  const reportedUnpriced = new Set(
    (snapshot.unpricedConcepts ?? []).map((concept) => concept.toLowerCase()),
  );
  const unpricedConcepts = [...concepts].filter(
    (concept) =>
      reportedUnpriced.has(concept) ||
      !matched.some((product) => product.canonicalConcept.toLowerCase() === concept),
  );

  return {
    mode: snapshot.mode,
    fetchedAt: snapshot.fetchedAt,
    storeNames: eligibleStores.map((store) => store.retailerName),
    storeCount: eligibleStores.length,
    productCount: inRange.length,
    promotionCount: snapshot.promotions.filter((promotion) => matchedPromotionIds.has(promotion.id))
      .length,
    matchedProductCount: matched.length,
    combinationsEvaluated: countCombinations(eligibleStores.length, MAX_COMBINATION_SIZE),
    unpricedConcepts,
    partial: snapshot.partial === true,
    sourceFailures: snapshot.sourceFailures ?? [],
    attributions: snapshot.attributions ?? [],
    weakestFreshness: weakestFreshness(matched),
  };
}
