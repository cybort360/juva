import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_PER_WEEK,
  MEANINGFUL_SAVING_CENTS,
  decideJourney,
  isQuietHour,
  journeyBody,
  journeyCandidates,
  pruneHistory,
  type JourneyCandidate,
  type SentMessage,
} from '../src/domain/journeys';

/** A time comfortably outside quiet hours. */
const MIDDAY = new Date('2026-03-10T12:00:00');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function candidate(over: Partial<JourneyCandidate> = {}): JourneyCandidate {
  return { kind: 'receipt_not_verified', subjectId: 'trip-1', ...over };
}

// ------------------------------------------------------------------ quiet hours

test('the overnight quiet window wraps midnight', () => {
  // 21:00–09:00 must be quiet late, in the small hours, and early.
  assert.equal(isQuietHour(22), true);
  assert.equal(isQuietHour(3), true);
  assert.equal(isQuietHour(8), true);
  assert.equal(isQuietHour(9), false, 'the window ends at 9');
  assert.equal(isQuietHour(12), false);
  assert.equal(isQuietHour(20), false);
  assert.equal(isQuietHour(21), true, 'and starts at 21');
});

test('a same-day quiet window does not wrap', () => {
  const quiet = { startHour: 13, endHour: 14 };
  assert.equal(isQuietHour(13, quiet), true);
  assert.equal(isQuietHour(14, quiet), false);
  assert.equal(isQuietHour(3, quiet), false);
});

test('an empty quiet window is never quiet', () => {
  assert.equal(isQuietHour(3, { startHour: 0, endHour: 0 }), false);
});

test('nothing is sent during quiet hours', () => {
  const decision = decideJourney(candidate(), [], new Date('2026-03-10T03:00:00'));
  assert.equal(decision.send, false);
  assert.match(decision.reason, /quiet/i);
});

// -------------------------------------------------------------- meaningfulness

test('a saving below the threshold is not worth a notification', () => {
  const decision = decideJourney(
    candidate({ kind: 'basket_cheaper', savingsCents: MEANINGFUL_SAVING_CENTS - 1 }),
    [],
    MIDDAY,
  );
  assert.equal(decision.send, false);
  assert.match(decision.reason, /threshold/);
});

test('a meaningful saving is sent', () => {
  const decision = decideJourney(
    candidate({ kind: 'basket_cheaper', subjectId: 'list-1', savingsCents: 450 }),
    [],
    MIDDAY,
  );
  assert.equal(decision.send, true);
});

test('a basket that did not actually get cheaper produces nothing', () => {
  for (const savings of [0, -100, undefined]) {
    const decision = decideJourney(
      candidate({ kind: 'basket_cheaper', savingsCents: savings }),
      [],
      MIDDAY,
    );
    assert.equal(decision.send, false, `savings ${String(savings)} must not send`);
  }
});

test('the non-money journeys do not require a saving', () => {
  for (const kind of ['trip_not_started', 'receipt_not_verified'] as const) {
    assert.equal(decideJourney(candidate({ kind }), [], MIDDAY).send, true);
  }
});

// ----------------------------------------------------------------------- caps

test('the same subject is never messaged twice', () => {
  const history: SentMessage[] = [
    { kind: 'receipt_not_verified', subjectId: 'trip-1', sentAt: MIDDAY.getTime() - 30 * DAY },
  ];
  const decision = decideJourney(candidate({ subjectId: 'trip-1' }), history, MIDDAY);
  assert.equal(decision.send, false);
  assert.match(decision.reason, /already sent about this/i);
});

test('a different subject of the same kind is allowed', () => {
  const history: SentMessage[] = [
    { kind: 'receipt_not_verified', subjectId: 'trip-1', sentAt: MIDDAY.getTime() - 30 * DAY },
  ];
  assert.equal(decideJourney(candidate({ subjectId: 'trip-2' }), history, MIDDAY).send, true);
});

test('the weekly cap holds across different journeys', () => {
  // The cap is on the shopper's attention, not on one journey type.
  const history: SentMessage[] = [
    { kind: 'basket_cheaper', subjectId: 'list-1', sentAt: MIDDAY.getTime() - 3 * DAY },
    { kind: 'trip_not_started', subjectId: 'trip-9', sentAt: MIDDAY.getTime() - 2 * DAY },
  ];
  assert.equal(history.length, MAX_PER_WEEK);
  const decision = decideJourney(candidate({ subjectId: 'trip-new' }), history, MIDDAY);
  assert.equal(decision.send, false);
  assert.match(decision.reason, /this week/);
});

test('the weekly cap is a rolling window, not a calendar week', () => {
  const history: SentMessage[] = [
    { kind: 'basket_cheaper', subjectId: 'list-1', sentAt: MIDDAY.getTime() - 8 * DAY },
    { kind: 'trip_not_started', subjectId: 'trip-9', sentAt: MIDDAY.getTime() - 9 * DAY },
  ];
  assert.equal(
    decideJourney(candidate({ subjectId: 'trip-new' }), history, MIDDAY).send,
    true,
    'messages older than a week no longer count',
  );
});

test('two messages never land close together', () => {
  const history: SentMessage[] = [
    { kind: 'basket_cheaper', subjectId: 'list-1', sentAt: MIDDAY.getTime() - 2 * HOUR },
  ];
  const decision = decideJourney(candidate({ subjectId: 'trip-new' }), history, MIDDAY);
  assert.equal(decision.send, false);
  assert.match(decision.reason, /too recently/i);
});

test('quiet hours is reported last, so a caller knows it can retry', () => {
  // A capped message will never be sendable; a quiet-hours one will be in the morning.
  const capped: SentMessage[] = [
    { kind: 'basket_cheaper', subjectId: 'a', sentAt: Date.now() },
    { kind: 'trip_not_started', subjectId: 'b', sentAt: Date.now() },
  ];
  const atNight = new Date('2026-03-10T03:00:00');
  const decision = decideJourney(candidate({ subjectId: 'c' }), capped, atNight);
  assert.match(
    decision.reason,
    /this week/,
    'the permanent objection is named, not the temporary one',
  );
});

// ------------------------------------------------------------------- the copy

test('no journey body contains a product, store or location', () => {
  for (const kind of [
    'basket_cheaper',
    'trip_not_started',
    'receipt_not_verified',
    'basket_under_budget',
  ] as const) {
    const withAmount = journeyBody(kind, '$4.20');
    const without = journeyBody(kind);
    for (const body of [withAmount, without]) {
      assert.ok(body.length > 0);
      // A lock screen is the least private surface Juva touches.
      assert.equal(/milk|chicken|grove|north|brooklyn|street/i.test(body), false, body);
    }
  }
});

test('a money body only ever quotes the amount it was given', () => {
  const body = journeyBody('basket_cheaper', '$4.20');
  assert.match(body, /\$4\.20/);
  // No figure is derived here; without one the copy simply does not quote money.
  assert.equal(/\$/.test(journeyBody('basket_cheaper')), false);
});

test('the receipt reminder does not quote an unverified saving', () => {
  const body = journeyBody('receipt_not_verified');
  assert.equal(/\$|\d+c\b/.test(body), false, 'the saving is not verified yet');
});

// -------------------------------------------------------------------- pruning

test('history is pruned but keeps enough to enforce the subject rule', () => {
  const history: SentMessage[] = [
    { kind: 'basket_cheaper', subjectId: 'old', sentAt: MIDDAY.getTime() - 400 * DAY },
    { kind: 'basket_cheaper', subjectId: 'recent', sentAt: MIDDAY.getTime() - 10 * DAY },
  ];
  const pruned = pruneHistory(history, MIDDAY);
  assert.deepEqual(
    pruned.map((entry) => entry.subjectId),
    ['recent'],
  );
});

// ------------------------------------------------------------------ candidates

test('nothing to say produces no candidates', () => {
  assert.deepEqual(journeyCandidates({}), []);
});

test('each source produces exactly its own candidate', () => {
  assert.deepEqual(journeyCandidates({ unverifiedTripId: 't1' }), [
    { kind: 'receipt_not_verified', subjectId: 't1' },
  ]);
  assert.deepEqual(journeyCandidates({ pendingPlanId: 'p1' }), [
    { kind: 'trip_not_started', subjectId: 'p1' },
  ]);
});

test('a money journey carries its amount through to the decision', () => {
  const [candidate] = journeyCandidates({ cheaperListId: 'l1', cheaperByCents: 450 });
  assert.equal(candidate?.savingsCents, 450);
  assert.equal(decideJourney(candidate!, [], MIDDAY).send, true);
});

test('a money journey with no amount is refused by the decision, not by the builder', () => {
  // The builder proposes; only `decideJourney` may refuse. That split is what stops a
  // caller from bypassing the caps by constructing a candidate by hand.
  const [candidate] = journeyCandidates({ cheaperListId: 'l1' });
  assert.equal(candidate?.savingsCents, undefined);
  assert.equal(decideJourney(candidate!, [], MIDDAY).send, false);
});

test('an unverified trip is offered before a saving', () => {
  // Money already spent outranks money that might be saved.
  const candidates = journeyCandidates({
    unverifiedTripId: 't1',
    cheaperListId: 'l1',
    cheaperByCents: 900,
    pendingPlanId: 'p1',
  });
  assert.deepEqual(
    candidates.map((entry) => entry.kind),
    ['receipt_not_verified', 'basket_cheaper', 'trip_not_started'],
  );
});

test('candidates are still individually subject to the caps', () => {
  const candidates = journeyCandidates({ unverifiedTripId: 't1', pendingPlanId: 'p1' });
  const history: SentMessage[] = [
    { kind: 'receipt_not_verified', subjectId: 't1', sentAt: MIDDAY.getTime() - 40 * DAY },
  ];
  const decisions = candidates.map((entry) => decideJourney(entry, history, MIDDAY));
  assert.equal(decisions[0]?.send, false, 'already sent about this trip');
  assert.equal(decisions[1]?.send, true);
});
