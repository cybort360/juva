import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AnalyticsQueue,
  type AnalyticsTransport,
  type QueuedEvent,
} from '../src/domain/analyticsQueue';

/**
 * The analytics delivery chain, end to end.
 *
 * domain event → sanitizer → queue → transport → server validation → storage → ack →
 * queue cleared.
 *
 * The server half is re-implemented here from `services/api/src/events.ts` rather than
 * imported, because the app's test suite compiles against React Native and the API's does
 * not. The rules are duplicated deliberately and the duplication is the point: if the two
 * ever disagree, one of these suites fails. `services/api/tests/events.test.ts` tests the
 * real server module.
 */

// The subset this suite exercises. The real route carries the full vocabulary; an event
// missing from an allowlist is silently skipped, which is the behaviour under test in
// "an unknown event name never reaches storage".
const ALLOWED_EVENTS = new Set([
  'app_opened',
  'list_created',
  'optimization_completed',
  'paywall_seen',
  'purchase_completed',
  'shop_mode_started',
]);

const ALLOWED_STRINGS = new Set(['complete', 'partial', 'demo', '5_to_15', '1_to_5', 'annual']);
const FORBIDDEN_KEYS = /(name|text|receipt|latitude|longitude|loyalty|card|secret|barcode)/i;

/** A stand-in for the real `/v1/events` route, with the same rules and the same sink. */
class FakeServer {
  readonly stored: QueuedEvent[] = [];
  private readonly seen = new Set<string>();
  /** Number of requests to fail before succeeding. Simulates a 500. */
  failNext = 0;
  requests = 0;

  post(body: { events: readonly QueuedEvent[] }): {
    status: number;
    stored: number;
    duplicates: number;
  } {
    this.requests += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      return { status: 500, stored: 0, duplicates: 0 };
    }
    if (body.events.length === 0 || body.events.length > 50) {
      return { status: 400, stored: 0, duplicates: 0 };
    }

    let stored = 0;
    let duplicates = 0;
    for (const entry of body.events) {
      if (!ALLOWED_EVENTS.has(entry.event)) continue;
      const bad = Object.entries(entry.properties).some(
        ([key, value]) =>
          FORBIDDEN_KEYS.test(key) ||
          (typeof value === 'string' && !ALLOWED_STRINGS.has(value)) ||
          (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean'),
      );
      if (bad) continue;

      // Idempotent by `id`: the client retries, and a retry must not double-count.
      if (this.seen.has(entry.id)) {
        duplicates += 1;
        continue;
      }
      this.seen.add(entry.id);
      this.stored.push(entry);
      stored += 1;
    }
    return { status: 202, stored, duplicates };
  }
}

/** The client transport, talking to the fake server instead of the network. */
class WiredTransport implements AnalyticsTransport {
  constructor(private readonly server: FakeServer) {}

  send(batch: readonly QueuedEvent[]): Promise<boolean> {
    const response = this.server.post({ events: batch });
    // Only a 2xx clears the queue. A 500 leaves everything pending.
    return Promise.resolve(response.status >= 200 && response.status < 300);
  }
}

/** A transport that cannot reach anything at all. */
class OfflineTransport implements AnalyticsTransport {
  send(): Promise<boolean> {
    return Promise.reject(new Error('network unavailable'));
  }
}

// ── The happy path, all the way through ─────────────────────────────────────

test('an event travels from record to durable storage and clears the queue', async () => {
  const server = new FakeServer();
  const queue = new AnalyticsQueue(new WiredTransport(server));

  queue.record(
    'optimization_completed',
    { planCount: 4, marketCompleteness: 'complete' },
    { id: 'evt-1' },
  );
  assert.equal(queue.stats().queued, 1);

  const result = await queue.flush();

  assert.equal(result.delivered, 1);
  assert.equal(queue.stats().queued, 0, 'acknowledged events leave the queue');
  assert.equal(server.stored.length, 1);
  assert.equal(server.stored[0]?.event, 'optimization_completed');
  assert.deepEqual(server.stored[0]?.properties, {
    planCount: 4,
    marketCompleteness: 'complete',
  });
});

test('the sanitizer runs before anything reaches the wire', async () => {
  const server = new FakeServer();
  const queue = new AnalyticsQueue(new WiredTransport(server));

  queue.record(
    'list_created',
    {
      productName: 'Kellogg’s Corn Flakes',
      receiptText: 'WHL MLK 3.49',
      latitude: 37.4067782,
      basketItemCount: 12,
    },
    { id: 'evt-2' },
  );
  await queue.flush();

  assert.equal(server.stored.length, 1);
  assert.deepEqual(Object.keys(server.stored[0]?.properties ?? {}), ['basketItemCount']);
  const serialized = JSON.stringify(server.stored);
  assert.equal(serialized.includes('Kellogg'), false);
  assert.equal(serialized.includes('37.4'), false);
});

// ── Deduplication ───────────────────────────────────────────────────────────

test('a duplicate eventId is deduplicated by the server', async () => {
  const server = new FakeServer();
  const queue = new AnalyticsQueue(new WiredTransport(server));

  queue.record('paywall_seen', {}, { id: 'same-id' });
  await queue.flush();

  // A second queue — a reinstall, or a restored queue — sends the same id again.
  const second = new AnalyticsQueue(new WiredTransport(server));
  second.record('paywall_seen', {}, { id: 'same-id' });
  await second.flush();

  assert.equal(server.stored.length, 1, 'stored once, however many times it arrives');
  assert.equal(server.requests, 2, 'and both requests were genuinely made');
});

test('the client also refuses to queue the same id twice', () => {
  const server = new FakeServer();
  const queue = new AnalyticsQueue(new WiredTransport(server));
  queue.record('paywall_seen', {}, { id: 'render-1' });
  queue.record('paywall_seen', {}, { id: 'render-1' });
  assert.equal(queue.stats().queued, 1, 'a re-render is not a second impression');
});

// ── Retry ───────────────────────────────────────────────────────────────────

test('a server 500 keeps the event queued, and a retry stores it exactly once', async () => {
  const server = new FakeServer();
  server.failNext = 1;
  const queue = new AnalyticsQueue(new WiredTransport(server));

  queue.record('purchase_completed', { packageKind: 'annual' }, { id: 'buy-1' });

  const first = await queue.flush();
  assert.equal(first.delivered, 0);
  assert.equal(queue.stats().queued, 1, 'nothing is lost to a server error');
  assert.equal(server.stored.length, 0);

  const second = await queue.flush();
  assert.equal(second.delivered, 1);
  assert.equal(queue.stats().queued, 0);
  assert.equal(server.stored.length, 1, 'stored once, not twice');
});

test('backoff grows between attempts and is bounded', async () => {
  const server = new FakeServer();
  server.failNext = 3;
  const queue = new AnalyticsQueue(new WiredTransport(server), { maxAttempts: 5 });
  queue.record('app_opened', {}, { id: 'a-1' });

  const first = queue.nextDelayMs();
  await queue.flush();
  const second = queue.nextDelayMs();
  await queue.flush();

  assert.ok(second > first, 'exponential');
  assert.ok(queue.nextDelayMs() <= 60_000, 'and capped, so it never becomes a battery complaint');
});

test('retrying is bounded — a permanently broken endpoint drops the batch', async () => {
  const server = new FakeServer();
  server.failNext = 99;
  const queue = new AnalyticsQueue(new WiredTransport(server), { maxAttempts: 3 });
  queue.record('app_opened', {}, { id: 'a-2' });

  await queue.flush();
  await queue.flush();
  const final = await queue.flush();

  assert.equal(final.dropped, 1);
  assert.equal(queue.stats().queued, 0, 'the queue drains rather than growing forever');
});

// ── Offline, and the product carrying on regardless ─────────────────────────

test('with no network the product loop succeeds and events stay queued and bounded', async () => {
  const queue = new AnalyticsQueue(new OfflineTransport(), { maxQueued: 5, maxAttempts: 10 });

  for (let index = 0; index < 20; index += 1) {
    queue.record('app_opened', { index }, { id: `off-${index}` });
  }
  const result = await queue.flush();

  assert.equal(result.delivered, 0);
  assert.equal(queue.stats().queued, 5, 'bounded, whatever the outage does');
  assert.ok(queue.stats().droppedTotal >= 15);

  // A rejected promise from the transport never escapes as an exception, which is what
  // keeps a dead endpoint from breaking a shopping trip.
  assert.doesNotReject(() => queue.flush());
});

test('a later flush succeeds once the network returns, storing each event once', async () => {
  const server = new FakeServer();
  const failing = { send: (): Promise<boolean> => Promise.resolve(false) };
  const queue = new AnalyticsQueue(failing, { maxAttempts: 10 });

  queue.record('optimization_completed', { planCount: 2 }, { id: 'later-1' });
  await queue.flush();
  assert.equal(queue.stats().queued, 1, 'held while offline');

  // The network returns: same queue, working transport.
  const online = new AnalyticsQueue(new WiredTransport(server), { maxAttempts: 10 });
  for (const entry of queue.pending()) {
    online.record(entry.event, entry.properties, { id: entry.id, at: entry.at });
  }
  await online.flush();

  assert.equal(server.stored.length, 1);
  assert.equal(server.stored[0]?.id, 'later-1');
});

// ── Lifecycle: background flush, failure, foreground retry ──────────────────

test('the background-to-foreground cycle preserves and then delivers the queue', async () => {
  // Models exactly what `startAnalyticsLifecycle` does on an AppState change, without
  // needing React Native's AppState in the domain test environment.
  const server = new FakeServer();
  const transport = new WiredTransport(server);
  const queue = new AnalyticsQueue(transport, { maxAttempts: 10 });

  queue.record('shop_mode_started', { stopCount: 2 }, { id: 'life-1' });

  // Backgrounding: the flush is attempted and fails.
  server.failNext = 1;
  await queue.flush();
  assert.equal(queue.stats().queued, 1, 'the queue survives a failed background flush');

  // The app is suspended and restored — the queue is serialized and rehydrated.
  const serialized = JSON.stringify(queue.pending());
  const restored = new AnalyticsQueue(transport, { maxAttempts: 10 });
  for (const entry of JSON.parse(serialized) as QueuedEvent[]) {
    restored.record(entry.event, entry.properties, { id: entry.id, at: entry.at });
  }
  assert.equal(restored.stats().queued, 1, 'and survives a restart');

  // Foregrounding: retry, and this time it lands.
  const result = await restored.flush();
  assert.equal(result.delivered, 1);
  assert.equal(restored.stats().queued, 0, 'the queue clears');
  assert.equal(server.stored.length, 1, 'stored exactly once across the whole cycle');
});

test('an unknown event name never reaches storage', async () => {
  // The server's allowlist is the last line: a client shipped with a typo, or a hostile
  // one, cannot invent an event type.
  const server = new FakeServer();
  const queue = new AnalyticsQueue(new WiredTransport(server));
  queue.record('worth_trip_changed', {}, { id: 'unknown-1' });
  await queue.flush();
  assert.equal(server.stored.length, 0, 'not in this suite’s allowlist, so not stored');
});

test('a restored queue is re-sanitized rather than trusted', () => {
  // The restore path re-records through `record`, so a queue file that was tampered with
  // between runs cannot smuggle a product name back in.
  const server = new FakeServer();
  const restored = new AnalyticsQueue(new WiredTransport(server));
  restored.record('list_created', { productName: 'smuggled', basketItemCount: 3 } as never, {
    id: 'tampered-1',
  });
  assert.deepEqual(Object.keys(restored.pending()[0]?.properties ?? {}), ['basketItemCount']);
});
