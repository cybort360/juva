import type { GeoPoint } from './contract.js';
import { HealthTracker, JsonClient, RateLimiter, TtlCache, type FetchLike } from './resilience.js';

/**
 * Location resolution and store geography, both from OpenStreetMap services.
 *
 * OSM is the authority for *where* a store is; a price source is the authority
 * for *what it costs there*. Keeping those separate is what lets Juva attribute
 * every price to one exact branch (see `contract.ts`, locality rule).
 *
 * Both services below are free and have published usage policies that require an
 * identifying User-Agent and a low request rate. Those limits are enforced here,
 * not left to callers.
 */

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const OVERPASS_BASE = 'https://overpass-api.de/api/interpreter';

/** Nominatim's policy is an absolute maximum of 1 request per second. */
const NOMINATIM_MIN_INTERVAL_MS = 1_100;
/** Overpass is a shared community resource; keep well clear of its limits. */
const OVERPASS_MIN_INTERVAL_MS = 1_500;

const GEOCODE_TTL_MS = 24 * 60 * 60 * 1000;
const STORES_TTL_MS = 6 * 60 * 60 * 1000;

const EARTH_RADIUS_MILES = 3958.7613;

export function milesToMetres(miles: number): number {
  return miles * 1609.344;
}

/** Great-circle distance in miles. */
export function haversineMiles(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Generic so narrowing preserves the caller's own extra fields: a
 * `LocationRequest` that passes this check is still a `LocationRequest`.
 */
export function isValidGeoPoint<
  T extends { latitude?: number | undefined; longitude?: number | undefined },
>(point: T | undefined): point is T & GeoPoint {
  return (
    point !== undefined &&
    typeof point.latitude === 'number' &&
    typeof point.longitude === 'number' &&
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.latitude) <= 90 &&
    Math.abs(point.longitude) <= 180
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Geocoding
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedLocation extends GeoPoint {
  label: string;
  /** How the coordinates were obtained. */
  origin: 'device' | 'postal_code';
  postalCode?: string;
  countryCode?: string;
}

export interface LocationRequest {
  latitude?: number;
  longitude?: number;
  postalCode?: string;
  countryCode?: string;
  label?: string;
}

interface NominatimResult {
  lat?: string;
  lon?: string;
  display_name?: string;
  address?: { postcode?: string; country_code?: string };
}

export interface GeoServiceOptions {
  readonly userAgent: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  /**
   * Overrides the minimum interval between calls to each OSM service. Defaults
   * to each service's published policy; only lower it for tests against mocks.
   */
  readonly rateLimitMs?: { nominatim?: number; overpass?: number };
}

export class GeoService {
  private readonly geocodeCache = new TtlCache<ResolvedLocation>(GEOCODE_TTL_MS, 200);
  private readonly storeCache = new TtlCache<OsmStore[]>(STORES_TTL_MS, 200);
  private readonly nominatim: JsonClient;
  private readonly overpass: JsonClient;
  readonly nominatimHealth: HealthTracker;
  readonly overpassHealth: HealthTracker;

  constructor(options: GeoServiceOptions) {
    const timeoutMs = options.timeoutMs ?? 8_000;
    this.nominatimHealth = new HealthTracker('nominatim');
    this.overpassHealth = new HealthTracker('overpass');

    this.nominatim = new JsonClient({
      userAgent: options.userAgent,
      timeoutMs,
      maxAttempts: 2,
      rateLimiter: new RateLimiter(options.rateLimitMs?.nominatim ?? NOMINATIM_MIN_INTERVAL_MS),
      health: this.nominatimHealth,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });

    this.overpass = new JsonClient({
      userAgent: options.userAgent,
      timeoutMs: timeoutMs * 3,
      maxAttempts: 2,
      rateLimiter: new RateLimiter(options.rateLimitMs?.overpass ?? OVERPASS_MIN_INTERVAL_MS),
      health: this.overpassHealth,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  }

  /**
   * Resolves a shopper's location.
   *
   * Device coordinates win when present: they are already exact, and geocoding a
   * postcode would only lose precision.
   */
  async resolveLocation(request: LocationRequest): Promise<ResolvedLocation> {
    if (isValidGeoPoint(request)) {
      return {
        latitude: request.latitude,
        longitude: request.longitude,
        label: request.label ?? 'Current location',
        origin: 'device',
        ...(request.postalCode === undefined ? {} : { postalCode: request.postalCode }),
        ...(request.countryCode === undefined ? {} : { countryCode: request.countryCode }),
      };
    }

    const postalCode = request.postalCode?.trim();
    if (!postalCode) {
      throw new Error('A postcode or device coordinates are required to search nearby stores.');
    }

    const countryCode = (request.countryCode ?? 'us').trim().toLowerCase();
    const cacheKey = `${countryCode}:${postalCode.toLowerCase()}`;
    const cached = this.geocodeCache.get(cacheKey);
    if (cached) return cached;

    const url =
      `${NOMINATIM_BASE}/search?format=jsonv2&addressdetails=1&limit=1` +
      `&postalcode=${encodeURIComponent(postalCode)}&country=${encodeURIComponent(countryCode)}`;

    const results = await this.nominatim.getJson<NominatimResult[]>(url);
    const first = results[0];
    const latitude = Number(first?.lat);
    const longitude = Number(first?.lon);
    if (!first || !isValidGeoPoint({ latitude, longitude })) {
      throw new Error(`Could not locate postcode "${postalCode}".`);
    }

    const resolved: ResolvedLocation = {
      latitude,
      longitude,
      label: request.label ?? first.display_name ?? postalCode,
      origin: 'postal_code',
      postalCode: first.address?.postcode ?? postalCode,
      ...(first.address?.country_code === undefined
        ? { countryCode: countryCode.toUpperCase() }
        : { countryCode: first.address.country_code.toUpperCase() }),
    };
    this.geocodeCache.set(cacheKey, resolved);
    return resolved;
  }

  /**
   * Supermarkets and grocery shops within a radius, from OpenStreetMap.
   *
   * Returns raw OSM identity so a price source can be joined to the exact same
   * physical store rather than to a name match.
   */
  async findGroceryStores(
    centre: GeoPoint,
    radiusMiles: number,
    limit: number,
  ): Promise<OsmStore[]> {
    const radius = Math.round(milesToMetres(Math.min(radiusMiles, 50)));
    const lat = centre.latitude.toFixed(4);
    const lon = centre.longitude.toFixed(4);
    const cacheKey = `${lat},${lon},${radius}`;
    const cached = this.storeCache.get(cacheKey);
    if (cached) return cached.slice(0, limit);

    // `out center` gives ways a single representative coordinate.
    const query =
      `[out:json][timeout:25];(` +
      `node["shop"~"^(supermarket|grocery|greengrocer)$"](around:${radius},${lat},${lon});` +
      `way["shop"~"^(supermarket|grocery|greengrocer)$"](around:${radius},${lat},${lon});` +
      `);out center ${Math.min(limit * 4, 80)};`;

    const payload = await this.overpass.getJson<OverpassResponse>(
      `${OVERPASS_BASE}?data=${encodeURIComponent(query)}`,
    );

    const stores = (payload.elements ?? [])
      .map((element) => toOsmStore(element, centre))
      .filter((store): store is OsmStore => store !== null)
      .filter((store) => store.distanceMiles <= radiusMiles)
      .sort((a, b) => a.distanceMiles - b.distanceMiles);

    this.storeCache.set(cacheKey, stores);
    return stores.slice(0, limit);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OSM shapes
// ─────────────────────────────────────────────────────────────────────────────

export type OsmElementType = 'node' | 'way' | 'relation';

export interface OsmStore extends GeoPoint {
  osmType: OsmElementType;
  osmId: number;
  name: string;
  brand?: string;
  postalCode?: string;
  city?: string;
  street?: string;
  houseNumber?: string;
  distanceMiles: number;
}

interface OverpassElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

function toOsmStore(element: OverpassElement, centre: GeoPoint): OsmStore | null {
  const osmType = element.type;
  if (osmType !== 'node' && osmType !== 'way' && osmType !== 'relation') return null;
  if (typeof element.id !== 'number') return null;

  // Narrow a named value, not a literal, so the coordinates stay narrowed below.
  const point = {
    latitude: element.lat ?? element.center?.lat,
    longitude: element.lon ?? element.center?.lon,
  };
  if (!isValidGeoPoint(point)) return null;

  const tags = element.tags ?? {};
  const name = tags.name ?? tags.brand ?? tags.operator;
  // An unnamed shop cannot be presented as a destination.
  if (!name) return null;

  return {
    osmType,
    osmId: element.id,
    name,
    latitude: point.latitude,
    longitude: point.longitude,
    distanceMiles: haversineMiles(centre, point),
    ...(tags.brand === undefined ? {} : { brand: tags.brand }),
    ...(tags['addr:postcode'] === undefined ? {} : { postalCode: tags['addr:postcode'] }),
    ...(tags['addr:city'] === undefined ? {} : { city: tags['addr:city'] }),
    ...(tags['addr:street'] === undefined ? {} : { street: tags['addr:street'] }),
    ...(tags['addr:housenumber'] === undefined ? {} : { houseNumber: tags['addr:housenumber'] }),
  };
}

export function formatOsmAddress(store: OsmStore): string {
  const line = [store.houseNumber, store.street].filter(Boolean).join(' ');
  const parts = [line || undefined, store.city, store.postalCode].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'Address not recorded in OpenStreetMap';
}
