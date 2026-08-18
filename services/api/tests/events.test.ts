import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  FileEventSink,
  MAX_BATCH,
  MemoryEventSink,
  validateBatch,
  type StoredEvent,
} from '../src/events.js';

/**
 * Analytics ingestion, server side.
 *
 * The client sanitizes before sending, and this layer sanitizes again. That is not
 * belt-and-braces politeness — a client is a program on someone else's device, and a bug
 * in a shipped build cannot be recalled. Most of these tests are about what the server
 * refuses.
 */

const NOW = new Date('2026-08-18T20:00:00Z');

function event(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'e1',
    event: 'optimization_completed',
    at: NOW.toISOString(),
    properties: { planCount: 4, marketCompleteness: 'complete' },
    ...over,
  };
}

// ── Validation ──────────────────────────────────────────────────────────────

test('a well-formed batch is accepted', () => {
  const result = validateBatch({ events: [event()] }, NOW);
  assert.ok(result);
  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.accepted[0]?.eventName, 'optimization_completed');
  assert.equal(result.accepted[0]?.receivedAt, NOW.toISOString());
});

test('a batch that is not a batch is refused outright', () => {
  assert.equal(validateBatch(null, NOW), null);
  assert.equal(validateBatch({}, NOW), null);
  assert.equal(validateBatch({ events: 'nope' }, NOW), null);
  assert.equal(validateBatch({ events: [] }, NOW), null, 'an empty batch is not a request');
});

test('an oversized batch is refused rather than truncated', () => {
  const events = Array.from({ length: MAX_BATCH + 1 }, (_unused, index) =>
    event({ id: `e${index}` }),
  );
  assert.equal(validateBatch({ events }, NOW), null);
});

test('an unknown event name is rejected', () => {
  const result = validateBatch({ events: [event({ event: 'user_did_something' })] }, NOW);
  assert.ok(result);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.reason, 'unknown_event');
});

test('a malformed entry is rejected without taking the batch down', () => {
  const result = validateBatch(
    { events: [event(), 'not-an-object', event({ id: '', event: 'app_opened' })] },
    NOW,
  );
  assert.ok(result);
  assert.equal(result.accepted.length, 1, 'the good one still lands');
  assert.equal(result.rejected.length, 2);
  assert.ok(result.rejected.every((entry) => entry.reason === 'malformed'));
});

test('a missing or unparseable timestamp is rejected', () => {
  const noAt = validateBatch({ events: [event({ at: undefined })] }, NOW);
  assert.equal(noAt?.rejected[0]?.reason, 'malformed');
  const badAt = validateBatch({ events: [event({ at: 'sometime' })] }, NOW);
  assert.equal(badAt?.rejected[0]?.reason, 'malformed');
});

// ── Privacy: the server does not trust the client ───────────────────────────

test('receipt content is rejected even though the client should have stripped it', () => {
  const result = validateBatch(
    { events: [event({ properties: { receiptText: 'WHL MLK 1GAL 3.49' } })] },
    NOW,
  );
  assert.ok(result);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.reason, 'forbidden_key');
});

test('a base64 image is rejected as an unsupported value', () => {
  const result = validateBatch(
    { events: [event({ properties: { blob: 'data:image/jpeg;base64,/9j/4AAQSkZJRg' } })] },
    NOW,
  );
  assert.ok(result);
  assert.equal(result.accepted.length, 0);
  // Caught by the value rule even under a key the name filter allows.
  assert.equal(result.rejected[0]?.reason, 'unsupported_value');
});

test('product text, coordinates, loyalty and secrets are all rejected', () => {
  for (const properties of [
    { productName: 'Corn Flakes' },
    { latitude: 37.4067782 },
    { longitude: -122.087 },
    { loyaltyId: 'ABC-123' },
    { cardLast4: '4242' },
    { openrouterPrompt: 'read this receipt' },
    { apiSecret: 'sk-live-x' },
    { barcode: '019068100232' },
  ]) {
    const result = validateBatch({ events: [event({ properties })] }, NOW);
    assert.ok(result);
    assert.equal(result.accepted.length, 0, `${Object.keys(properties)[0]} must be rejected`);
  }
});

test('free text under an innocent key is rejected', () => {
  const result = validateBatch(
    { events: [event({ properties: { outcome: 'bought rice' } })] },
    NOW,
  );
  assert.equal(result?.rejected[0]?.reason, 'unsupported_value');
});

test('nested objects and arrays are rejected', () => {
  assert.equal(
    validateBatch({ events: [event({ properties: { basket: ['milk'] } })] }, NOW)?.accepted.length,
    0,
  );
  assert.equal(
    validateBatch({ events: [event({ properties: { plan: { cost: 1 } } })] }, NOW)?.accepted.length,
    0,
  );
});

test('too many properties is rejected', () => {
  const properties: Record<string, number> = {};
  for (let index = 0; index < 25; index += 1) properties[`k${index}`] = index;
  const result = validateBatch({ events: [event({ properties })] }, NOW);
  assert.equal(result?.rejected[0]?.reason, 'too_many_properties');
});

test('a rejection reports an index and a reason, and nothing else', () => {
  // The whole point: a rejection must not echo the value that caused it.
  const result = validateBatch(
    { events: [event({ properties: { receiptText: 'MILK 3.49' } })] },
    NOW,
  );
  assert.ok(result);
  const rejection = result.rejected[0];
  assert.ok(rejection);
  assert.deepEqual(Object.keys(rejection).sort(), ['index', 'reason']);
  assert.equal(JSON.stringify(rejection).includes('MILK'), false);
});

test('Juva’s own enumerated values survive', () => {
  const result = validateBatch(
    {
      events: [
        event({
          properties: {
            marketCompleteness: 'complete',
            savingsBand: '5_to_15',
            subscriptionState: 'plus',
            packageKind: 'annual',
            verificationState: 'blocked',
            planCount: 3,
            overrode: false,
          },
        }),
      ],
    },
    NOW,
  );
  assert.ok(result);
  assert.equal(result.accepted.length, 1);
  assert.equal(Object.keys(result.accepted[0]?.properties ?? {}).length, 7);
});

// ── Idempotency ─────────────────────────────────────────────────────────────

test('the same eventId is stored once', async () => {
  const sink = new MemoryEventSink();
  const batch = validateBatch({ events: [event({ id: 'dup-1' })] }, NOW)?.accepted ?? [];

  const first = await sink.store(batch);
  assert.deepEqual(first, { stored: 1, duplicates: 0 });

  const second = await sink.store(batch);
  assert.deepEqual(second, { stored: 0, duplicates: 1 }, 'a retry must not double-count');
  assert.equal(sink.events.length, 1);
});

test('a mixed batch stores only the events not seen before', async () => {
  const sink = new MemoryEventSink();
  const first = validateBatch({ events: [event({ id: 'a' })] }, NOW)?.accepted ?? [];
  await sink.store(first);

  const mixed =
    validateBatch({ events: [event({ id: 'a' }), event({ id: 'b' }), event({ id: 'c' })] }, NOW)
      ?.accepted ?? [];
  const result = await sink.store(mixed);

  assert.deepEqual(result, { stored: 2, duplicates: 1 });
  assert.deepEqual(
    sink.events.map((entry) => entry.eventId),
    ['a', 'b', 'c'],
  );
});

// ── Durability ──────────────────────────────────────────────────────────────

test('accepted events are written to durable storage as NDJSON', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'juva-events-'));
  const file = path.join(dir, 'events.ndjson');
  const sink = new FileEventSink(file);

  const batch = validateBatch({ events: [event({ id: 'p1' }), event({ id: 'p2' })] }, NOW)
    ?.accepted as StoredEvent[];
  await sink.store(batch);

  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const parsed = JSON.parse(lines[0] ?? '{}') as StoredEvent;
  assert.equal(parsed.eventId, 'p1');
  assert.equal(parsed.eventName, 'optimization_completed');
  assert.ok(parsed.receivedAt.length > 0);
});

test('deduplication survives a restart, because it is rebuilt from the file', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'juva-events-'));
  const file = path.join(dir, 'events.ndjson');
  const batch = validateBatch({ events: [event({ id: 'restart-1' })] }, NOW)
    ?.accepted as StoredEvent[];

  await new FileEventSink(file).store(batch);
  // A fresh sink, as a restarted process would have.
  const afterRestart = await new FileEventSink(file).store(batch);

  assert.deepEqual(afterRestart, { stored: 0, duplicates: 1 });
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1);
});

test('a truncated final line does not break the seen-set rebuild', async () => {
  // An interrupted write leaves a partial line. It must be skipped, not fatal.
  const dir = mkdtempSync(path.join(tmpdir(), 'juva-events-'));
  const file = path.join(dir, 'events.ndjson');
  const sink = new FileEventSink(file);
  const batch = validateBatch({ events: [event({ id: 'ok-1' })] }, NOW)?.accepted as StoredEvent[];
  await sink.store(batch);

  const { appendFileSync } = await import('node:fs');
  appendFileSync(file, '{"eventId":"trunc');

  const recovered = await new FileEventSink(file).store(
    validateBatch({ events: [event({ id: 'ok-2' })] }, NOW)?.accepted as StoredEvent[],
  );
  assert.equal(recovered.stored, 1, 'the sink still works');
});

test('nothing sensitive can reach storage even from a hostile client', async () => {
  const sink = new MemoryEventSink();
  const result = validateBatch(
    {
      events: [
        event({ id: 'safe', properties: { planCount: 2 } }),
        event({ id: 'nasty', properties: { receiptText: 'MILK 3.49', latitude: 37.4 } }),
      ],
    },
    NOW,
  );
  assert.ok(result);
  await sink.store(result.accepted);

  const serialized = JSON.stringify(sink.events);
  assert.equal(serialized.includes('MILK'), false);
  assert.equal(serialized.includes('37.4'), false);
  assert.equal(sink.events.length, 1, 'only the safe event was stored');
});
