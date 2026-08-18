import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_QUIET_HOURS,
  MAX_PLAN_CHANGE_AGE_HOURS,
  MEANINGFUL_PLAN_CHANGE_CENTS,
  MIN_PLAN_CHANGE_CONFIDENCE,
  decideJourney,
  journeyBody,
  evaluatePlanChange,
  planChangeQualifies,
  type PlanChangeEvidence,
  type SentMessage,
} from '../src/domain/journeys';
import { OPTIMIZER_VERSION } from '../src/domain/types';
import type { RecommendationSnapshot } from '../src/domain/types';

/**
 * Journey D — the recommendation genuinely changed.
 *
 * The easiest journey to make useless. "Store B is 3c cheaper" is technically true,
 * asks the shopper to reorganise their afternoon, and teaches them to ignore the next
 * message. So almost every test here is a suppression: the gates matter far more than
 * the send.
 */

const NOW = new Date('2026-08-18T14:00:00Z');

function evidence(over: Partial<PlanChangeEvidence> = {}): PlanChangeEvidence {
  return {
    listId: 'list-1',
    previousStoreIds: ['alpha'],
    previousCostCents: 6142,
    currentStoreIds: ['beta'],
    currentCostCents: 5480,
    bothComplete: true,
    currentConfidence: 1,
    observedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    ...over,
  };
}

// ── Qualifying ──────────────────────────────────────────────────────────────

test('a material store change qualifies', () => {
  // $61.42 at one store becomes $54.80 at another: a different shop, $6.62 better.
  const result = planChangeQualifies(evidence(), NOW);
  assert.equal(result.qualifies, true, result.reason);
  assert.equal(result.savingsCents, 662);
  assert.match(result.reason, /different set of stores/);
});

test('one store becoming two qualifies when the saving is real', () => {
  const result = planChangeQualifies(
    evidence({ previousStoreIds: ['alpha'], currentStoreIds: ['alpha', 'beta'] }),
    NOW,
  );
  assert.equal(result.qualifies, true, result.reason);
});

test('the copy never names a store or the basket', () => {
  const body = journeyBody('plan_changed', '$6.62');
  assert.match(body, /shop this basket differently today/);
  assert.equal(/alpha|beta|milk|store [AB]/i.test(body), false, 'no basket detail leaks');

  const bodyWithoutAmount = journeyBody('plan_changed');
  assert.ok(bodyWithoutAmount.length > 0);
});

// ── Suppression ─────────────────────────────────────────────────────────────

test('a tiny price change does not qualify', () => {
  const result = planChangeQualifies(
    evidence({ previousCostCents: 6142, currentCostCents: 6139 }),
    NOW,
  );
  assert.equal(result.qualifies, false);
  assert.match(result.reason, /below the .* threshold/);
});

test('the threshold is higher than the ordinary meaningful-saving one', () => {
  // Asking someone to change where they shop must be worth more than telling them a
  // basket got cheaper.
  const justUnder = planChangeQualifies(
    evidence({
      previousCostCents: 6142,
      currentCostCents: 6142 - (MEANINGFUL_PLAN_CHANGE_CENTS - 1),
    }),
    NOW,
  );
  assert.equal(justUnder.qualifies, false);

  const atThreshold = planChangeQualifies(
    evidence({ previousCostCents: 6142, currentCostCents: 6142 - MEANINGFUL_PLAN_CHANGE_CENTS }),
    NOW,
  );
  assert.equal(atThreshold.qualifies, true);
});

test('ranking noise between the same stores does not qualify', () => {
  // The set of stores is what the shopper acts on. A reordering of the same stops is not
  // a change in the recommendation, however the scores moved.
  const result = planChangeQualifies(
    evidence({
      previousStoreIds: ['alpha', 'beta'],
      currentStoreIds: ['beta', 'alpha'],
      currentCostCents: 4000,
    }),
    NOW,
  );
  assert.equal(result.qualifies, false);
  assert.match(result.reason, /same stores/);
});

test('a partial basket never qualifies', () => {
  const result = planChangeQualifies(evidence({ bothComplete: false }), NOW);
  assert.equal(result.qualifies, false);
  assert.match(result.reason, /incomplete/);
});

test('a stale market never qualifies', () => {
  const stale = new Date(NOW.getTime() - (MAX_PLAN_CHANGE_AGE_HOURS + 2) * 60 * 60 * 1000);
  const result = planChangeQualifies(evidence({ observedAt: stale.toISOString() }), NOW);
  assert.equal(result.qualifies, false);
  assert.match(result.reason, /too stale/);
});

test('a future or unparseable timestamp never qualifies', () => {
  const future = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
  assert.equal(planChangeQualifies(evidence({ observedAt: future }), NOW).qualifies, false);
  assert.equal(planChangeQualifies(evidence({ observedAt: 'nonsense' }), NOW).qualifies, false);
});

test('low confidence never qualifies', () => {
  const result = planChangeQualifies(
    evidence({ currentConfidence: MIN_PLAN_CHANGE_CONFIDENCE - 0.01 }),
    NOW,
  );
  assert.equal(result.qualifies, false);
  assert.match(result.reason, /not confident enough/);
});

test('a plan that got dearer never qualifies', () => {
  const result = planChangeQualifies(
    evidence({ previousCostCents: 5000, currentCostCents: 6000 }),
    NOW,
  );
  assert.equal(result.qualifies, false);
  assert.ok(result.savingsCents < 0, 'and the figure is reported honestly as negative');
});

// ── The shared journey rules still apply on top ─────────────────────────────

test('a qualifying change is still subject to the frequency cap', () => {
  const history: SentMessage[] = [
    { kind: 'basket_cheaper', subjectId: 'a', sentAt: NOW.getTime() - 60 * 60 * 1000 },
    { kind: 'basket_under_budget', subjectId: 'b', sentAt: NOW.getTime() - 2 * 60 * 60 * 1000 },
  ];
  const decision = decideJourney(
    { kind: 'plan_changed', subjectId: 'list-1', savingsCents: 662 },
    history,
    NOW,
    DEFAULT_QUIET_HOURS,
  );
  assert.equal(decision.send, false, decision.reason);
});

test('a qualifying change is still subject to quiet hours', () => {
  const lateNight = new Date('2026-08-18T23:30:00Z');
  const decision = decideJourney(
    { kind: 'plan_changed', subjectId: 'list-1', savingsCents: 662 },
    [],
    lateNight,
    { startHour: 21, endHour: 9 },
  );
  assert.equal(decision.send, false);
  assert.match(decision.reason, /quiet/i);
});

test('the same list is never told twice about the same change', () => {
  const history: SentMessage[] = [
    { kind: 'plan_changed', subjectId: 'list-1', sentAt: NOW.getTime() - 3 * 24 * 60 * 60 * 1000 },
  ];
  const decision = decideJourney(
    { kind: 'plan_changed', subjectId: 'list-1', savingsCents: 662 },
    history,
    NOW,
    DEFAULT_QUIET_HOURS,
  );
  assert.equal(decision.send, false, decision.reason);
});

test('a clean qualifying change with no history does send', () => {
  const decision = decideJourney(
    { kind: 'plan_changed', subjectId: 'list-1', savingsCents: 662 },
    [],
    NOW,
    DEFAULT_QUIET_HOURS,
  );
  assert.equal(decision.send, true, decision.reason);
});

// ── The persisted before/after trigger ──────────────────────────────────────

function snapshot(over: Partial<RecommendationSnapshot> = {}): RecommendationSnapshot {
  return {
    basketId: 'list-1',
    planKind: 'recommended',
    primaryStoreIds: ['alpha'],
    storeCount: 1,
    estimatedCostCents: 6142,
    travelMinutes: 20,
    confidence: 1,
    marketCompleteness: 'complete',
    observedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    optimizerVersion: OPTIMIZER_VERSION,
    ...over,
  };
}

test('a first recommendation stores a snapshot and notifies nobody', () => {
  const result = evaluatePlanChange({
    previous: undefined,
    current: snapshot(),
    history: [],
    notificationsEnabled: true,
    now: NOW,
  });
  assert.equal(result.decision.send, false);
  assert.match(result.decision.reason, /nothing to compare/);
  assert.deepEqual(result.nextSnapshot, snapshot(), 'the snapshot is still stored');
});

test('an identical second recommendation notifies nobody', () => {
  const result = evaluatePlanChange({
    previous: snapshot(),
    current: snapshot(),
    history: [],
    notificationsEnabled: true,
    now: NOW,
  });
  assert.equal(result.decision.send, false);
  assert.match(result.decision.reason, /same stores/);
});

test('a material store change qualifies and sends', () => {
  const result = evaluatePlanChange({
    previous: snapshot(),
    current: snapshot({ primaryStoreIds: ['beta'], estimatedCostCents: 5480 }),
    history: [],
    notificationsEnabled: true,
    now: NOW,
  });
  assert.equal(result.decision.send, true, result.decision.reason);
});

test('a material plan-shape change qualifies', () => {
  const result = evaluatePlanChange({
    previous: snapshot(),
    current: snapshot({
      primaryStoreIds: ['alpha', 'beta'],
      storeCount: 2,
      estimatedCostCents: 5480,
    }),
    history: [],
    notificationsEnabled: true,
    now: NOW,
  });
  assert.equal(result.decision.send, true, result.decision.reason);
});

test('the snapshot is compared before it is replaced', () => {
  // If the store were updated first, the comparison would be against itself and no
  // change could ever be detected.
  const previous = snapshot();
  const current = snapshot({ primaryStoreIds: ['beta'], estimatedCostCents: 5480 });
  const result = evaluatePlanChange({
    previous,
    current,
    history: [],
    notificationsEnabled: true,
    now: NOW,
  });
  assert.equal(result.decision.send, true);
  assert.deepEqual(result.nextSnapshot, current, 'and then replaced with the new one');
  assert.equal(previous.estimatedCostCents, 6142, 'the old one was not mutated');
});

test('notifications switched off means no delivery, but the snapshot still updates', () => {
  const current = snapshot({ primaryStoreIds: ['beta'], estimatedCostCents: 5480 });
  const result = evaluatePlanChange({
    previous: snapshot(),
    current,
    history: [],
    notificationsEnabled: false,
    now: NOW,
  });
  assert.equal(result.decision.send, false);
  assert.match(result.decision.reason, /switched off/);
  assert.deepEqual(result.nextSnapshot, current, 'state still moves forward');
});

test('the frequency cap still suppresses a qualifying change', () => {
  const history: SentMessage[] = [
    { kind: 'basket_cheaper', subjectId: 'a', sentAt: NOW.getTime() - 60 * 60 * 1000 },
    { kind: 'basket_under_budget', subjectId: 'b', sentAt: NOW.getTime() - 2 * 60 * 60 * 1000 },
  ];
  const result = evaluatePlanChange({
    previous: snapshot(),
    current: snapshot({ primaryStoreIds: ['beta'], estimatedCostCents: 5480 }),
    history,
    notificationsEnabled: true,
    now: NOW,
  });
  assert.equal(result.decision.send, false, result.decision.reason);
});

test('a partial market suppresses, even with a large difference', () => {
  const result = evaluatePlanChange({
    previous: snapshot(),
    current: snapshot({
      primaryStoreIds: ['beta'],
      estimatedCostCents: 3000,
      marketCompleteness: 'partial',
    }),
    history: [],
    notificationsEnabled: true,
    now: NOW,
  });
  assert.equal(result.decision.send, false);
  assert.match(result.decision.reason, /incomplete/);
});

test('a snapshot from a different optimizer generation is not compared', () => {
  // Otherwise a Juva release would notify every shopper that their plan "changed".
  const result = evaluatePlanChange({
    previous: snapshot({ optimizerVersion: OPTIMIZER_VERSION - 1 }),
    current: snapshot({ primaryStoreIds: ['beta'], estimatedCostCents: 5480 }),
    history: [],
    notificationsEnabled: true,
    now: NOW,
  });
  assert.equal(result.decision.send, false);
  assert.match(result.decision.reason, /optimizer changed/);
});

test('a snapshot survives a serialization round trip', () => {
  const stored = JSON.parse(JSON.stringify(snapshot())) as RecommendationSnapshot;
  const result = evaluatePlanChange({
    previous: stored,
    current: snapshot({ primaryStoreIds: ['beta'], estimatedCostCents: 5480 }),
    history: [],
    notificationsEnabled: true,
    now: NOW,
  });
  assert.equal(result.decision.send, true, 'a restarted app still detects the change');
});
