import { sanitizeProperties, type AnalyticsEvent, type AnalyticsValue } from './analytics';

/**
 * The analytics delivery queue.
 *
 * Two rules shape everything here.
 *
 * **Analytics may never break Juva.** A shopper mid-trip does not care that an event
 * failed to send, and must never find out. So emission cannot throw, cannot block, and
 * cannot grow without bound — a transport that is down for an hour must cost a fixed
 * amount of memory, not an unbounded one.
 *
 * **Nothing reaches a transport unsanitized.** The sanitizer runs inside `record`, not at
 * the call site, so there is no path to a transport that skips it. A caller cannot forget.
 */

/** A sanitized, ready-to-send event. */
export interface QueuedEvent {
  /** Stable id, so a retry cannot double-count a conversion. */
  readonly id: string;
  readonly event: AnalyticsEvent;
  readonly at: string;
  readonly properties: Readonly<Record<string, AnalyticsValue>>;
}

export interface AnalyticsTransport {
  /**
   * Delivers a batch. Resolves on success, rejects or resolves false on failure.
   *
   * Implementations must not throw synchronously; the queue treats any rejection as a
   * retryable failure rather than a crash.
   */
  send(batch: readonly QueuedEvent[]): Promise<boolean>;
}

export interface QueueOptions {
  /**
   * Hard cap on buffered events.
   *
   * When full, the *oldest* event is dropped rather than the newest. A queue that
   * rejects new events during an outage preserves a stale prefix and loses everything
   * that happened since, which is the opposite of useful.
   */
  readonly maxQueued?: number;
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  /** Base delay for exponential backoff, in ms. */
  readonly baseDelayMs?: number;
}

const DEFAULTS = {
  maxQueued: 200,
  batchSize: 20,
  maxAttempts: 4,
  baseDelayMs: 1_000,
} as const;

export interface FlushResult {
  delivered: number;
  dropped: number;
  retrying: number;
}

/**
 * A bounded, non-blocking analytics queue.
 *
 * Deliberately not a class with a timer: the caller owns when flushing happens, which
 * makes the whole thing synchronous to test and impossible to leave running in a test
 * process. The app schedules `flush` on foreground and background transitions.
 */
export class AnalyticsQueue {
  private readonly options: Required<QueueOptions>;
  private queued: QueuedEvent[] = [];
  private attempts = 0;
  private droppedTotal = 0;
  private inFlight = false;
  private readonly seen = new Set<string>();

  constructor(
    private readonly transport: AnalyticsTransport,
    options: QueueOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  /**
   * Records an event. Never throws, never blocks, never awaits the transport.
   *
   * Returns what was actually queued so a caller — in practice a test or the dev
   * diagnostics screen — can see the sanitized result, including nothing at all when
   * every property was rejected.
   */
  record(
    event: AnalyticsEvent,
    properties: Readonly<Record<string, unknown>> = {},
    meta: { id?: string; at?: string } = {},
  ): QueuedEvent {
    const { safe } = sanitizeProperties(properties);
    const entry: QueuedEvent = {
      id: meta.id ?? `${event}-${this.seen.size}-${meta.at ?? Date.now()}`,
      event,
      at: meta.at ?? new Date().toISOString(),
      properties: safe,
    };

    // Deduplication: a stable id offered twice is the same transition reported twice,
    // usually by a re-render. Counting it twice would inflate a funnel step.
    if (this.seen.has(entry.id)) return entry;
    this.seen.add(entry.id);

    this.queued.push(entry);
    while (this.queued.length > this.options.maxQueued) {
      this.queued.shift();
      this.droppedTotal += 1;
    }
    return entry;
  }

  /**
   * Attempts one delivery.
   *
   * Failure is isolated: the batch stays queued, the attempt count rises, and the caller
   * gets a result rather than an exception. After `maxAttempts` the batch is dropped —
   * an unbounded retry is how a broken endpoint becomes a battery complaint.
   */
  async flush(): Promise<FlushResult> {
    if (this.inFlight || this.queued.length === 0) {
      return { delivered: 0, dropped: 0, retrying: this.queued.length };
    }
    this.inFlight = true;
    const batch = this.queued.slice(0, this.options.batchSize);

    try {
      const ok = await this.transport.send(batch);
      if (ok) {
        this.queued = this.queued.slice(batch.length);
        this.attempts = 0;
        return { delivered: batch.length, dropped: 0, retrying: this.queued.length };
      }
      return this.recordFailure(batch.length);
    } catch {
      // A transport that throws is a transport that failed. It is never Juva's problem.
      return this.recordFailure(batch.length);
    } finally {
      this.inFlight = false;
    }
  }

  private recordFailure(batchSize: number): FlushResult {
    this.attempts += 1;
    if (this.attempts >= this.options.maxAttempts) {
      this.queued = this.queued.slice(batchSize);
      this.droppedTotal += batchSize;
      this.attempts = 0;
      return { delivered: 0, dropped: batchSize, retrying: this.queued.length };
    }
    return { delivered: 0, dropped: 0, retrying: this.queued.length };
  }

  /** Delay before the next attempt, exponential with a ceiling. */
  nextDelayMs(): number {
    return Math.min(this.options.baseDelayMs * 2 ** this.attempts, 60_000);
  }

  /** Inspectable state, for tests and the development diagnostics screen. */
  stats(): { queued: number; attempts: number; droppedTotal: number } {
    return { queued: this.queued.length, attempts: this.attempts, droppedTotal: this.droppedTotal };
  }

  /** The pending events, for development inspection only. Never logged in production. */
  pending(): readonly QueuedEvent[] {
    return [...this.queued];
  }
}

/**
 * A transport that keeps everything in memory.
 *
 * The development and test destination. Not a production transport and not pretending to
 * be one — its whole purpose is that a test can assert on the exact sequence of events a
 * real product transition produced.
 */
export class MemoryTransport implements AnalyticsTransport {
  readonly delivered: QueuedEvent[] = [];
  /** Set to make every send fail, to prove Juva survives it. */
  failing = false;

  send(batch: readonly QueuedEvent[]): Promise<boolean> {
    if (this.failing) return Promise.resolve(false);
    this.delivered.push(...batch);
    return Promise.resolve(true);
  }

  names(): AnalyticsEvent[] {
    return this.delivered.map((entry) => entry.event);
  }
}
