import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  HealthTracker,
  HttpError,
  JsonClient,
  RateLimiter,
  TimeoutError,
  TtlCache,
  safeHost,
} from '../src/retailers/resilience.js';

import { jsonResponse } from './fixtures.js';

function client(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  overrides: { maxAttempts?: number; timeoutMs?: number; health?: HealthTracker } = {},
) {
  const health = overrides.health ?? new HealthTracker('test');
  return {
    health,
    instance: new JsonClient({
      userAgent: 'JuvaTest/1.0',
      timeoutMs: overrides.timeoutMs ?? 50,
      maxAttempts: overrides.maxAttempts ?? 3,
      rateLimiter: new RateLimiter(0),
      health,
      fetchImpl,
    }),
  };
}

test('the rate limiter spaces calls by at least the minimum interval', async () => {
  const limiter = new RateLimiter(40);
  const startedAt: number[] = [];
  await Promise.all(
    [0, 1, 2].map(() =>
      limiter.schedule(async () => {
        startedAt.push(Date.now());
      }),
    ),
  );

  assert.equal(startedAt.length, 3);
  const first = startedAt[0];
  const second = startedAt[1];
  const third = startedAt[2];
  assert.ok(first !== undefined && second !== undefined && third !== undefined);
  assert.ok(second - first >= 35, `gap was ${second - first}ms`);
  assert.ok(third - second >= 35, `gap was ${third - second}ms`);
});

test('the rate limiter keeps running after a task throws', async () => {
  const limiter = new RateLimiter(0);
  await assert.rejects(
    limiter.schedule(async () => {
      throw new Error('boom');
    }),
  );
  assert.equal(await limiter.schedule(async () => 'still working'), 'still working');
});

test('the cache expires entries and stays bounded', async () => {
  const cache = new TtlCache<string>(30, 2);
  cache.set('a', 'one');
  assert.equal(cache.get('a'), 'one');

  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(cache.get('a'), undefined, 'expired entries are not served');

  const bounded = new TtlCache<string>(10_000, 2);
  bounded.set('a', '1');
  bounded.set('b', '2');
  bounded.set('c', '3');
  assert.equal(bounded.size, 2, 'the cache does not grow past its bound');
  assert.equal(bounded.get('a'), undefined, 'the oldest entry was evicted');
  assert.equal(bounded.get('c'), '3');
});

test('a retryable status is retried and can succeed', async () => {
  let attempts = 0;
  const { instance } = client(async () => {
    attempts += 1;
    return attempts < 3 ? jsonResponse({ error: 'busy' }, 503) : jsonResponse({ ok: true });
  });

  assert.deepEqual(await instance.getJson<{ ok: boolean }>('https://x.test/a'), { ok: true });
  assert.equal(attempts, 3);
});

test('a 404 is not retried, because it will not start working', async () => {
  let attempts = 0;
  const { instance } = client(async () => {
    attempts += 1;
    return jsonResponse({ error: 'nope' }, 404);
  });

  await assert.rejects(instance.getJson('https://x.test/a'), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 404);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(attempts, 1);
});

test('a rate-limit response is treated as retryable', async () => {
  let attempts = 0;
  const { instance } = client(async () => {
    attempts += 1;
    return attempts === 1 ? jsonResponse({}, 429) : jsonResponse({ ok: 1 });
  });

  await instance.getJson('https://x.test/a');
  assert.equal(attempts, 2, '429 backs off and retries rather than failing outright');
});

test('a hanging request times out', async () => {
  const { instance } = client(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
    { maxAttempts: 1, timeoutMs: 30 },
  );

  await assert.rejects(instance.getJson('https://x.test/slow'), TimeoutError);
});

test('repeated failures open the circuit and stop further calls', async () => {
  let attempts = 0;
  const health = new HealthTracker('test', { failureThreshold: 1, openMs: 10_000 });
  const { instance } = client(
    async () => {
      attempts += 1;
      return jsonResponse({}, 500);
    },
    { maxAttempts: 1, health },
  );

  await assert.rejects(instance.getJson('https://x.test/a'));
  assert.equal(health.circuitOpen, true);
  assert.equal(health.snapshot().state, 'unavailable');

  const before = attempts;
  await assert.rejects(instance.getJson('https://x.test/a'), /circuit is open/);
  assert.equal(attempts, before, 'an open circuit does not hammer the provider');
});

test('health reports degraded after a failure and healthy after a success', async () => {
  const health = new HealthTracker('test', { failureThreshold: 5, openMs: 1_000 });
  assert.equal(health.snapshot().state, 'unknown');

  health.recordFailure(new Error('upstream exploded'));
  const degraded = health.snapshot();
  assert.equal(degraded.state, 'degraded');
  assert.equal(degraded.consecutiveFailures, 1);
  assert.equal(degraded.lastError, 'upstream exploded');

  health.recordSuccess();
  const healthy = health.snapshot();
  assert.equal(healthy.state, 'healthy');
  assert.equal(healthy.consecutiveFailures, 0);
  assert.ok(healthy.lastSuccessAt);
});

test('error messages carry the host, never the query string', () => {
  assert.equal(
    safeHost('https://prices.openfoodfacts.org/api/v1/prices?lat=40.69'),
    'prices.openfoodfacts.org',
  );
  assert.equal(safeHost('not a url'), 'upstream');
});
