import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  brandRankPenaltyCents,
  brandSatisfies,
  canonicalConcept,
  conceptsMatch,
  matchProduct,
  normalizeText,
} from '../src/domain/matching';
import type { GroceryListItem, RetailerProduct } from '../src/domain/types';

function item(overrides: Partial<GroceryListItem> = {}): GroceryListItem {
  return {
    id: 'i1',
    concept: 'milk',
    displayName: 'Milk',
    quantity: 1,
    unit: '1 gal',
    ...overrides,
  };
}

function product(overrides: {
  concept?: string;
  brand?: string;
  currency?: 'USD' | 'EUR';
  available?: boolean;
  priceCents?: number;
}): RetailerProduct {
  return {
    id: 'p1',
    canonicalConcept: overrides.concept ?? 'milk',
    storeId: 's1',
    title: 'Whole Milk',
    brand: overrides.brand ?? 'North Dairy',
    sizeLabel: '1 gal',
    observation: {
      id: 'o1',
      storeId: 's1',
      retailerId: 'north',
      retailerProductId: 'p1',
      scope: 'store',
      priceCents: overrides.priceCents ?? 299,
      currency: overrides.currency ?? 'USD',
      source: 'demo',
      observedAt: new Date().toISOString(),
      freshness: 'demo',
      confidence: 0.9,
      available: overrides.available ?? true,
      availability: 'in_stock',
    },
  };
}

const CONTEXT = { currency: 'USD', defaultBrandPolicy: 'flexible' as const };

// ── Canonical normalization ─────────────────────────────────────────────────

test('normalization strips case, punctuation and accents', () => {
  assert.equal(normalizeText('  Kellogg’s  CORN-FLAKES '), 'kellogg corn flakes');
  assert.equal(normalizeText('Crème Fraîche'), 'creme fraiche');
});

test('concept aliases collapse onto one canonical concept', () => {
  assert.equal(canonicalConcept('Yoghurt'), 'yogurt');
  assert.equal(canonicalConcept('Greek Yogurt'), 'yogurt');
  assert.equal(canonicalConcept('egg'), 'eggs');
  assert.equal(canonicalConcept('Corn Flakes'), 'cereal');
  assert.equal(canonicalConcept('chicken'), 'chicken breast');
  assert.equal(canonicalConcept('Vegetable Oil'), 'cooking oil');
});

test('an unknown concept normalizes to itself rather than to something else', () => {
  assert.equal(canonicalConcept('Saffron'), 'saffron');
  assert.equal(canonicalConcept('  DRAGON  FRUIT '), 'dragon fruit');
});

test('concepts match across spellings', () => {
  assert.equal(conceptsMatch('yoghurt', 'Greek yogurt'), true);
  assert.equal(conceptsMatch('milk', 'bread'), false);
});

// ── Brand matching ──────────────────────────────────────────────────────────

test('a brand satisfies a request when every requested token is present', () => {
  assert.equal(brandSatisfies('Grove Farms', 'Grove'), true);
  assert.equal(brandSatisfies("Kellogg's", 'Kelloggs'), true);
  assert.equal(brandSatisfies('KELLOGGS', "Kellogg's"), true);
});

test('a shared prefix is not a brand match', () => {
  assert.equal(
    brandSatisfies('Grovewood Dairy', 'Grove'),
    false,
    'substring matching would wrongly accept an unrelated brand',
  );
});

test('an empty request matches anything, an empty brand matches nothing', () => {
  assert.equal(brandSatisfies('Anything', ''), true);
  assert.equal(brandSatisfies('', 'Grove'), false);
});

test('the flexible policy penalises a substitution without forbidding it', () => {
  assert.equal(brandRankPenaltyCents('flexible', true), 60);
  assert.equal(brandRankPenaltyCents('flexible', false), 0);
  assert.equal(brandRankPenaltyCents('cheapest', true), 0, 'cheapest is indifferent to brand');
  assert.equal(
    brandRankPenaltyCents('exact_product', true),
    0,
    'exact never reaches a substitution',
  );
});

// ── Product matching ────────────────────────────────────────────────────────

test('a matching concept, currency and availability is a match', () => {
  assert.deepEqual(matchProduct(item(), product({}), CONTEXT), {
    matched: true,
    substitution: false,
    // No brand named, so identity rests on the concept alone: rung 5, not rung 3.
    tier: 'token',
  });
});

test('a different concept is rejected', () => {
  const result = matchProduct(item(), product({ concept: 'bread' }), CONTEXT);
  assert.equal(result.matched, false);
  assert.equal(result.rejection, 'concept_mismatch');
});

test('a foreign currency is rejected rather than converted', () => {
  const result = matchProduct(item(), product({ currency: 'EUR' }), CONTEXT);
  assert.equal(result.matched, false);
  assert.equal(result.rejection, 'currency_mismatch');
});

test('an unavailable product is rejected', () => {
  const result = matchProduct(item(), product({ available: false }), CONTEXT);
  assert.equal(result.matched, false);
  assert.equal(result.rejection, 'unavailable');
});

test('a non-positive price is rejected rather than treated as free', () => {
  assert.equal(matchProduct(item(), product({ priceCents: 0 }), CONTEXT).matched, false);
  assert.equal(
    matchProduct(item(), product({ priceCents: -100 }), CONTEXT).rejection,
    'price_not_positive',
  );
});

test('an exact brand request rejects every other brand', () => {
  const exact = item({ requestedBrand: 'Grove', brandPolicy: 'exact_product' });
  assert.equal(matchProduct(exact, product({ brand: 'North Dairy' }), CONTEXT).matched, false);
  assert.equal(
    matchProduct(exact, product({ brand: 'North Dairy' }), CONTEXT).rejection,
    'brand_required',
  );
  assert.equal(matchProduct(exact, product({ brand: 'Grove Farms' }), CONTEXT).matched, true);
});

test('a flexible brand request allows a substitution and marks it', () => {
  const flexible = item({ requestedBrand: 'Grove', brandPolicy: 'flexible' });
  const result = matchProduct(flexible, product({ brand: 'North Dairy' }), CONTEXT);
  assert.equal(result.matched, true);
  assert.equal(result.substitution, true);
});

test('the requested brand itself is never marked a substitution', () => {
  const flexible = item({ requestedBrand: 'North', brandPolicy: 'flexible' });
  const result = matchProduct(flexible, product({ brand: 'North Dairy' }), CONTEXT);
  assert.equal(result.matched, true);
  assert.equal(result.substitution, false);
});

test('the line policy overrides the shopper default', () => {
  const strictLine = item({ requestedBrand: 'Grove', brandPolicy: 'exact_product' });
  assert.equal(
    matchProduct(strictLine, product({ brand: 'Other' }), {
      currency: 'USD',
      defaultBrandPolicy: 'cheapest',
    }).matched,
    false,
    'a line marked exact stays exact even when the default is cheapest',
  );
});
