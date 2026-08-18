import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus } from 'react-native';

import { env } from '@/config/runtimeEnv';
import type { AnalyticsEvent } from '@/domain/analytics';
import {
  AnalyticsQueue,
  MemoryTransport,
  type AnalyticsTransport,
  type QueuedEvent,
} from '@/domain/analyticsQueue';

/**
 * Juva's analytics transport.
 *
 * First-party by choice. Juva already runs a small API for market data and receipt
 * extraction, and pointing events at it keeps a shopper's funnel behaviour inside the
 * same trust boundary as their basket — rather than handing it to an analytics vendor
 * whose retention and resale terms Juva does not control.
 *
 * The transport is pluggable because the destination is a deployment decision, not a
 * product one. In development and test, events go to memory and are inspectable; with an
 * API base URL configured they are POSTed in batches; with neither, nothing is sent and
 * nothing breaks.
 */

/**
 * Batches events to Juva's own API.
 *
 * Deliberately thin: no auth header, no device fingerprint, no retry of its own. Retry
 * and backoff belong to the queue, and everything identifying was already removed by the
 * sanitizer before an event reached here.
 */
export class HttpAnalyticsTransport implements AnalyticsTransport {
  constructor(private readonly baseUrl: string) {}

  async send(batch: readonly QueuedEvent[]): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: batch }),
      });
      return response.ok;
    } catch {
      // A network failure is a retryable delivery failure, never an app error.
      return false;
    }
  }
}

/** A transport that accepts everything and keeps nothing. Used when no destination exists. */
class NullTransport implements AnalyticsTransport {
  send(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

function chooseTransport(): AnalyticsTransport {
  if (env.apiBaseUrl !== undefined) return new HttpAnalyticsTransport(env.apiBaseUrl);
  // Development without an API still gets an inspectable record, which is what the
  // diagnostics screen reads.
  if (__DEV__) return devTransport;
  return new NullTransport();
}

/** Kept module-level so the diagnostics screen can show what was emitted this session. */
export const devTransport = new MemoryTransport();

let queue: AnalyticsQueue | undefined;

function ensureQueue(): AnalyticsQueue {
  queue ??= new AnalyticsQueue(chooseTransport());
  return queue;
}

/**
 * Records one product event.
 *
 * The only function the app calls. Synchronous, never throws, and never awaits — a
 * caller in the middle of a purchase or a receipt scan must not be able to notice that
 * analytics exists.
 */
export function track(
  event: AnalyticsEvent,
  properties: Readonly<Record<string, unknown>> = {},
  meta: { id?: string } = {},
): void {
  try {
    const queue = ensureQueue();
    queue.record(event, properties, meta);
    // Threshold flush, so a long session does not hold everything in memory.
    if (queue.stats().queued >= FLUSH_AT_QUEUED) flushAnalytics();
  } catch {
    // Recording must never surface. If the queue itself is broken, the shopper's trip is
    // still the thing that matters.
  }
}

/**
 * Attempts delivery. Safe to call on foreground, background and after a purchase.
 *
 * Fire-and-forget by design: nothing in the product waits on this resolving.
 */
export function flushAnalytics(): void {
  void ensureQueue()
    .flush()
    .catch(() => undefined);
}

/** Queue state for the development diagnostics screen. Never logged. */
export function analyticsStats(): { queued: number; attempts: number; droppedTotal: number } {
  return ensureQueue().stats();
}

/**
 * Flush thresholds.
 *
 * Batched rather than per-event: a POST for every tap would cost battery and tell an
 * observer of the network exactly when the shopper did each thing. Time-based flushing
 * only happens while the app is active.
 */
const FLUSH_AT_QUEUED = 10;
const ACTIVE_FLUSH_MS = 60_000;

let periodic: ReturnType<typeof setInterval> | undefined;

/**
 * Binds analytics to the app lifecycle.
 *
 * Called once from the root. Flushes on background — the last chance before the process
 * may be suspended — and on foreground when anything is waiting. Nothing here blocks:
 * every call is fire-and-forget, so a slow network cannot delay a navigation, a purchase
 * or a receipt scan.
 */
export function startAnalyticsLifecycle(): () => void {
  const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
    if (next === 'background' || next === 'inactive') {
      // Persist first: the process may not come back.
      void persistQueue();
      flushAnalytics();
      return;
    }
    if (next === 'active' && analyticsStats().queued > 0) flushAnalytics();
  });

  periodic = setInterval(() => {
    if (AppState.currentState === 'active' && analyticsStats().queued > 0) flushAnalytics();
  }, ACTIVE_FLUSH_MS);

  void restoreQueue();
  track('app_opened');

  return () => {
    subscription.remove();
    if (periodic) clearInterval(periodic);
    periodic = undefined;
  };
}

/**
 * Queued events, kept across a restart.
 *
 * Bounded by the queue itself, so this cannot grow without limit. Written on background
 * rather than on every record — a disk write per tap is the same mistake as a POST per
 * tap.
 */
const QUEUE_KEY = 'juva.analytics.queue.v1';

async function persistQueue(): Promise<void> {
  try {
    const pending = ensureQueue().pending();
    if (pending.length === 0) {
      await AsyncStorage.removeItem(QUEUE_KEY);
      return;
    }
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(pending));
  } catch {
    // Losing analytics is always preferable to surfacing an error to a shopper.
  }
}

async function restoreQueue(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const queue = ensureQueue();
    for (const entry of parsed as QueuedEvent[]) {
      // Re-recorded through the same path, so the sanitizer and the dedup set both apply
      // to restored events exactly as they did to fresh ones.
      queue.record(entry.event, entry.properties, { id: entry.id, at: entry.at });
    }
    await AsyncStorage.removeItem(QUEUE_KEY);
  } catch {
    // Corrupt queue state is discarded rather than retried forever.
  }
}

/** Replaces the transport. Test seam only — production chooses its own. */
export function __setAnalyticsTransportForTests(transport: AnalyticsTransport): void {
  queue = new AnalyticsQueue(transport);
}
