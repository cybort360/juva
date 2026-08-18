import assert from 'node:assert/strict';
import { test } from 'node:test';

import { matchConcept, mappedConcepts, mappingForConcept } from '../src/retailers/concepts.js';
import {
  classifyFreshness,
  isPlannableAtStore,
  type AdapterObservation,
} from '../src/retailers/contract.js';

const NOW = new Date('2026-08-11T12:00:00Z');

function daysBefore(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

test('freshness is classified from observation age', () => {
  assert.equal(classifyFreshness(daysBefore(0), NOW), 'live');
  assert.equal(classifyFreshness(daysBefore(2), NOW), 'live');
  assert.equal(classifyFreshness(daysBefore(3), NOW), 'recent');
  assert.equal(classifyFreshness(daysBefore(14), NOW), 'recent');
  assert.equal(classifyFreshness(daysBefore(15), NOW), 'older');
  assert.equal(classifyFreshness(daysBefore(120), NOW), 'older');
  assert.equal(classifyFreshness(daysBefore(121), NOW), 'verify');
});

test('a stated expiry overrides recency', () => {
  // Observed today but already expired: recency does not make it usable.
  assert.equal(classifyFreshness(daysBefore(0), NOW, daysBefore(1)), 'verify');
  assert.equal(
    classifyFreshness(daysBefore(0), NOW, new Date(NOW.getTime() + 86_400_000).toISOString()),
    'live',
  );
});

test('an unusable or future timestamp is never treated as fresh', () => {
  assert.equal(classifyFreshness('not a date', NOW), 'verify');
  const wayFuture = new Date(NOW.getTime() + 10 * 86_400_000).toISOString();
  assert.equal(classifyFreshness(wayFuture, NOW), 'verify');
});

function observation(overrides: Partial<AdapterObservation>): AdapterObservation {
  return {
    observationId: 'o1',
    sourceIdentifier: 'test/price/o1',
    retailerId: 'r',
    retailerName: 'R',
    scope: { kind: 'store', storeId: 'store-a' },
    product: { id: 'p', name: 'Milk' },
    price: { cents: 100, currency: 'USD' },
    source: 'community_feed',
    observedAt: daysBefore(0),
    confidence: 0.8,
    freshness: 'live',
    availability: 'unknown',
    attribution: {
      name: 'Test',
      url: 'https://test',
      licence: 'ODbL 1.0',
      automatedAccess: 'permitted_public_api',
    },
    ...overrides,
  };
}

test('a price is only plannable at the exact store it was observed at', () => {
  assert.equal(isPlannableAtStore(observation({}), 'store-a'), true);
  assert.equal(
    isPlannableAtStore(observation({}), 'store-b'),
    false,
    'a price never transfers to another branch',
  );
});

test('non-store scopes are never plannable at a store', () => {
  for (const kind of ['region', 'national', 'online'] as const) {
    assert.equal(
      isPlannableAtStore(observation({ scope: { kind, storeId: 'store-a' } }), 'store-a'),
      false,
      `${kind} scope must not be plannable`,
    );
  }
});

test('concept matching requires name evidence, not just a category tag', () => {
  // Measured real leakage: OFF's bread category contains croutons.
  assert.equal(matchConcept('bread', 'Mini croutons', ['en:breads']).matched, false);
  assert.equal(
    matchConcept('yogurt', 'Brummel & Brown Butter Spread', ['en:yogurts']).matched,
    false,
  );
  assert.equal(matchConcept('milk', 'Chocolate milk drink', ['en:milks']).matched, false);

  const good = matchConcept('bread', 'White Sandwich Bread', ['en:breads']);
  assert.equal(good.matched, true);
  assert.equal(good.reason, 'name_and_category');
  assert.equal(good.strength, 1);
});

test('a name match without category confirmation is weaker but still usable', () => {
  const nameOnly = matchConcept('milk', 'Whole Milk', ['en:beverages']);
  assert.equal(nameOnly.matched, true);
  assert.equal(nameOnly.reason, 'name_only');
  assert.ok(nameOnly.strength < 1);
});

test('an unmapped concept never matches', () => {
  assert.equal(matchConcept('saffron', 'Spanish Saffron', []).matched, false);
  assert.equal(mappingForConcept('saffron'), undefined);
});

test('a missing product name cannot be matched', () => {
  assert.equal(matchConcept('milk', undefined, ['en:milks']).matched, false);
  assert.equal(matchConcept('milk', '', ['en:milks']).reason, 'no_name_evidence');
});

test('every mapped concept has both category tags and name evidence', () => {
  for (const concept of mappedConcepts()) {
    const mapping = mappingForConcept(concept);
    assert.ok(mapping, concept);
    assert.ok(mapping.categoryTags.length > 0, `${concept} needs a category tag`);
    assert.ok(mapping.nameIncludes.length > 0, `${concept} needs name evidence`);
  }
});
