import { keepStoreScopedProducts } from './snapshot';
import type {
  ConceptCoverage,
  MarketSnapshot,
  Promotion,
  RetailerProduct,
  SourceAttribution,
  Store,
} from './types';

/**
 * The market API's wire format, and how it becomes a snapshot.
 *
 * Deliberately in `domain/` rather than `services/`: this is price-truth logic, and keeping
 * it free of React Native imports is what lets the deterministic test suite exercise the
 * whole chain — recorded payload through to optimizer — with no device and no network.
 */

export interface RemoteSnapshotPayload {
  stores: Store[];
  products: RetailerProduct[];
  promotions?: Promotion[];
  fetchedAt: string;
  coverage?: ConceptCoverage[];
  unpricedConcepts?: string[];
  partial?: boolean;
  failures?: { adapterId: string; stage: string; message: string }[];
  attributions?: SourceAttribution[];
  location?: { label?: string };
}

export function isRemoteSnapshot(value: unknown): value is RemoteSnapshotPayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RemoteSnapshotPayload>;
  return (
    Array.isArray(candidate.stores) &&
    Array.isArray(candidate.products) &&
    (candidate.promotions === undefined || Array.isArray(candidate.promotions)) &&
    typeof candidate.fetchedAt === 'string'
  );
}

/**
 * Maps a validated market payload into a snapshot.
 *
 * Pure and exported so the whole chain — location, store, retailer product, observation,
 * provenance, freshness — can be tested against a *recorded real* payload rather than a
 * hand-written one. A hand-written fixture only proves the code agrees with my assumptions;
 * a captured one proves it agrees with the upstream source.
 *
 * The locality filter runs here, not at the edge: a product claiming a store that is not in
 * the response is dropped and counted, and any rejection marks the snapshot partial so the
 * shopper is told coverage was reduced.
 */
export function snapshotFromWire(data: RemoteSnapshotPayload): MarketSnapshot {
  const { kept, rejected } = keepStoreScopedProducts(data.products, data.stores);

  return {
    stores: data.stores,
    products: kept,
    promotions: data.promotions ?? [],
    mode: 'remote',
    fetchedAt: data.fetchedAt,
    coverage: data.coverage ?? [],
    unpricedConcepts: data.unpricedConcepts ?? [],
    partial: data.partial === true || rejected > 0,
    sourceFailures: (data.failures ?? []).map(
      (failure) => `${failure.adapterId} (${failure.stage}): ${failure.message}`,
    ),
    attributions: data.attributions ?? [],
  };
}
