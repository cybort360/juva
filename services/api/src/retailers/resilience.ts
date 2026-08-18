import type { ProviderHealth, ProviderState } from './contract.js';

/**
 * Shared resilience primitives for outbound retailer calls.
 *
 * Every external source Juva talks to is someone else's free or rate-limited
 * service, so politeness is a correctness concern as much as a reliability one:
 * exceeding a published rate limit gets the whole project blocked, which would
 * take the real-data layer down for every user.
 */

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class TimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms.`);
    this.name = 'TimeoutError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serialised minimum-interval limiter.
 *
 * Requests queue and are released no closer together than `minIntervalMs`. This
 * is stricter than a token bucket on purpose: Nominatim's usage policy caps
 * absolute request rate rather than allowing bursts.
 */
export class RateLimiter {
  private queue: Promise<void> = Promise.resolve();
  private lastStartedAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.lastStartedAt);
      if (wait > 0) await delay(wait);
      this.lastStartedAt = Date.now();
    });
    // Keep the chain alive even when a task rejects.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then(task);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Caching
// ─────────────────────────────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Bounded TTL cache.
 *
 * The bound matters: a long-running API server keyed by free-text location and
 * concept would otherwise grow without limit. Eviction is oldest-inserted-first,
 * which is sufficient for request-shaped traffic.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider health / circuit breaker
// ─────────────────────────────────────────────────────────────────────────────

export interface HealthTrackerOptions {
  /** Failures in a row before calls are suppressed. */
  readonly failureThreshold: number;
  /** How long the circuit stays open before a trial call is allowed. */
  readonly openMs: number;
}

const DEFAULT_HEALTH_OPTIONS: HealthTrackerOptions = {
  failureThreshold: 3,
  openMs: 60_000,
};

/**
 * Tracks whether a provider is answering, and stops hammering it when it is not.
 *
 * A tripped breaker is reported rather than hidden, because a basket priced
 * while a provider was down has different coverage than one priced when it was
 * up, and the shopper is entitled to know which they are looking at.
 */
export class HealthTracker {
  private consecutiveFailures = 0;
  private lastSuccessAt: string | undefined;
  private lastErrorAt: string | undefined;
  private lastError: string | undefined;
  private openUntil = 0;
  private readonly options: HealthTrackerOptions;

  constructor(
    private readonly adapterId: string,
    options: Partial<HealthTrackerOptions> = {},
  ) {
    this.options = { ...DEFAULT_HEALTH_OPTIONS, ...options };
  }

  get circuitOpen(): boolean {
    return Date.now() < this.openUntil;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openUntil = 0;
    this.lastSuccessAt = new Date().toISOString();
  }

  recordFailure(error: unknown): void {
    this.consecutiveFailures += 1;
    this.lastErrorAt = new Date().toISOString();
    this.lastError = error instanceof Error ? error.message : String(error);
    if (this.consecutiveFailures >= this.options.failureThreshold) {
      this.openUntil = Date.now() + this.options.openMs;
    }
  }

  private get state(): ProviderState {
    if (this.circuitOpen) return 'unavailable';
    if (this.consecutiveFailures > 0) return 'degraded';
    if (this.lastSuccessAt) return 'healthy';
    return 'unknown';
  }

  snapshot(): ProviderHealth {
    return {
      adapterId: this.adapterId,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      circuitOpen: this.circuitOpen,
      ...(this.lastSuccessAt === undefined ? {} : { lastSuccessAt: this.lastSuccessAt }),
      ...(this.lastErrorAt === undefined ? {} : { lastErrorAt: this.lastErrorAt }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetching
// ─────────────────────────────────────────────────────────────────────────────

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface JsonClientOptions {
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly rateLimiter: RateLimiter;
  readonly health: HealthTracker;
  /** Injected for tests; defaults to global fetch. */
  readonly fetchImpl?: FetchLike;
}

/** 4xx other than 408/429 will not succeed on retry, so they are not retried. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function backoffMs(attempt: number): number {
  const base = 300 * 2 ** (attempt - 1);
  // Jitter avoids synchronised retries across concurrent basket lookups.
  return base + Math.floor(Math.random() * 150);
}

/**
 * A polite JSON client: identifies itself, rate limits, times out, retries only
 * what is worth retrying, and reports outcomes to the provider's health tracker.
 */
export class JsonClient {
  constructor(private readonly options: JsonClientOptions) {}

  get health(): HealthTracker {
    return this.options.health;
  }

  async getJson<T>(url: string): Promise<T> {
    if (this.options.health.circuitOpen) {
      throw new Error(`Provider circuit is open; skipping call to ${safeHost(url)}.`);
    }

    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      try {
        const payload = await this.options.rateLimiter.schedule(() =>
          this.fetchOnce<T>(fetchImpl, url),
        );
        this.options.health.recordSuccess();
        return payload;
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof TimeoutError ||
          (error instanceof HttpError && error.retryable) ||
          isNetworkError(error);

        if (!retryable || attempt === this.options.maxAttempts) break;
        await delay(backoffMs(attempt));
      }
    }

    this.options.health.recordFailure(lastError);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async fetchOnce<T>(fetchImpl: FetchLike, url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          // Both Nominatim and Overpass require a contactable identifier.
          'User-Agent': this.options.userAgent,
        },
      });
      if (!response.ok) {
        throw new HttpError(
          `${safeHost(url)} returned ${response.status}.`,
          response.status,
          isRetryableStatus(response.status),
        );
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new TimeoutError(this.options.timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && error.name === 'FetchError');
}

/** Host only, so query strings with location data never reach logs. */
export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'upstream';
  }
}
