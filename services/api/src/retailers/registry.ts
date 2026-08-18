import type { ProviderHealth, RetailerAdapter, RetailerCapabilities } from './contract.js';
import { GeoService } from './geo.js';
import { OpenPricesAdapter } from './openPrices.js';
import type { FetchLike } from './resilience.js';

/**
 * The set of retailer data sources this deployment is allowed to use.
 *
 * Adapters are opt-in via `JUVA_RETAILER_ADAPTERS`. A source that is not
 * explicitly enabled is not called, so adding an adapter to the codebase never
 * silently changes what a running deployment queries.
 */

export interface RegistryOptions {
  /** Contact identifier sent to every upstream service, as their policies require. */
  readonly userAgent: string;
  /** Comma-separated adapter ids; defaults to none. */
  readonly enabledIds?: string;
  readonly fetchImpl?: FetchLike;
}

export interface CapabilityMatrixRow extends RetailerCapabilities {
  adapterId: string;
  displayName: string;
  enabled: boolean;
  licence: string;
  automatedAccess: string;
  sourceUrl: string;
}

export class RetailerRegistry {
  private readonly adapters: RetailerAdapter[];
  readonly geo: GeoService;

  constructor(options: RegistryOptions) {
    this.geo = new GeoService({
      userAgent: options.userAgent,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });

    const enabled = new Set(
      (options.enabledIds ?? '')
        .split(',')
        .map((id) => id.trim().toLowerCase())
        .filter(Boolean),
    );

    this.adapters = [
      new OpenPricesAdapter({
        userAgent: options.userAgent,
        geo: this.geo,
        enabled: enabled.has('open_prices'),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      }),
    ];
  }

  /** Every registered adapter, enabled or not. */
  all(): readonly RetailerAdapter[] {
    return this.adapters;
  }

  /** Only adapters this deployment is configured to call. */
  active(): RetailerAdapter[] {
    return this.adapters.filter((adapter) => adapter.isEnabled());
  }

  get hasActiveAdapters(): boolean {
    return this.active().length > 0;
  }

  /**
   * The published capability matrix. Every row is a claim about a real source,
   * so this is generated from the adapters rather than maintained by hand.
   */
  capabilityMatrix(): CapabilityMatrixRow[] {
    return this.adapters.map((adapter) => ({
      adapterId: adapter.id,
      displayName: adapter.displayName,
      enabled: adapter.isEnabled(),
      licence: adapter.attribution.licence,
      automatedAccess: adapter.attribution.automatedAccess,
      sourceUrl: adapter.attribution.url,
      ...adapter.capabilities,
    }));
  }

  health(): ProviderHealth[] {
    return [
      ...this.adapters.map((adapter) => adapter.health()),
      this.geo.nominatimHealth.snapshot(),
      this.geo.overpassHealth.snapshot(),
    ];
  }
}
