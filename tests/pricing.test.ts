import assert from 'node:assert/strict';
import { test } from 'node:test';

import { demoPreferences } from '../src/domain/demoMarket';
import { evaluatePromotion, priceLine, promotionStatusLabel } from '../src/domain/pricing';
import type {
  GroceryListItem,
  Promotion,
  RetailerProduct,
  UserPreferences,
} from '../src/domain/types';

const NOW = new Date('2026-08-11T12:00:00Z');

const prefs: UserPreferences = { ...demoPreferences, loyaltyRetailers: [], onboarded: true };
const withCard: UserPreferences = { ...prefs, loyaltyRetailers: ['north'] };

function item(overrides: Partial<GroceryListItem> = {}): GroceryListItem {
  return {
    id: 'i1',
    concept: 'cereal',
    displayName: 'Corn Flakes',
    quantity: 1,
    unit: '18 oz',
    ...overrides,
  };
}

function product(overrides: {
  priceCents?: number;
  promotionId?: string;
  sizeLabel?: string;
  soldByWeight?: boolean;
  retailerId?: string;
}): RetailerProduct {
  return {
    id: 'p1',
    canonicalConcept: 'cereal',
    storeId: 's1',
    title: 'Corn Flakes',
    brand: "Kellogg's",
    sizeLabel: overrides.sizeLabel ?? '18 oz',
    ...(overrides.soldByWeight === undefined ? {} : { soldByWeight: overrides.soldByWeight }),
    observation: {
      id: 'o1',
      storeId: 's1',
      retailerId: overrides.retailerId ?? 'north',
      retailerProductId: 'p1',
      scope: 'store',
      priceCents: overrides.priceCents ?? 400,
      currency: 'USD',
      source: 'demo',
      observedAt: NOW.toISOString(),
      freshness: 'demo',
      confidence: 0.9,
      available: true,
      availability: 'in_stock',
      ...(overrides.promotionId === undefined ? {} : { promotionId: overrides.promotionId }),
    },
  };
}

const twoForSeven: Promotion = {
  id: 'promo-2for7',
  retailerId: 'north',
  label: '2 for $7',
  requiredQuantity: 2,
  overridePriceCents: 350,
};

const loyalty: Promotion = {
  id: 'promo-loyalty',
  retailerId: 'north',
  label: '$3 with card',
  loyaltyRequired: true,
  overridePriceCents: 300,
};

const dollarOff: Promotion = {
  id: 'promo-dollar',
  retailerId: 'north',
  label: '$1 off',
  amountOffCents: 100,
};

// ── Promotion eligibility ───────────────────────────────────────────────────

test('no promotion id means shelf price', () => {
  const decision = evaluatePromotion(product({}), [dollarOff], prefs, NOW);
  assert.equal(decision.status, 'none');
  assert.equal(decision.promotedUnitCents, 400);
});

test('a promotion id with no matching promotion falls back to shelf price', () => {
  const decision = evaluatePromotion(product({ promotionId: 'ghost' }), [dollarOff], prefs, NOW);
  assert.equal(decision.status, 'none');
  assert.equal(decision.promotedUnitCents, 400);
});

test('an amount-off promotion reduces the unit price', () => {
  const decision = evaluatePromotion(
    product({ promotionId: 'promo-dollar' }),
    [dollarOff],
    prefs,
    NOW,
  );
  assert.equal(decision.status, 'applied');
  assert.equal(decision.promotedUnitCents, 300);
});

test("another retailer's promotion is never honoured", () => {
  const foreign: Promotion = { ...dollarOff, retailerId: 'grove' };
  const decision = evaluatePromotion(
    product({ promotionId: 'promo-dollar', retailerId: 'north' }),
    [foreign],
    prefs,
    NOW,
  );
  assert.equal(decision.status, 'wrong_retailer');
  assert.equal(decision.promotedUnitCents, 400);
});

test('loyalty pricing needs the card', () => {
  const without = evaluatePromotion(
    product({ promotionId: 'promo-loyalty' }),
    [loyalty],
    prefs,
    NOW,
  );
  assert.equal(without.status, 'loyalty_missing');
  assert.equal(without.promotedUnitCents, 400);

  const holding = evaluatePromotion(
    product({ promotionId: 'promo-loyalty' }),
    [loyalty],
    withCard,
    NOW,
  );
  assert.equal(holding.status, 'applied');
  assert.equal(holding.promotedUnitCents, 300);
});

test('an expired promotion is not applied', () => {
  const expired: Promotion = {
    ...dollarOff,
    expiresAt: new Date(NOW.getTime() - 1000).toISOString(),
  };
  const decision = evaluatePromotion(
    product({ promotionId: 'promo-dollar' }),
    [expired],
    prefs,
    NOW,
  );
  assert.equal(decision.status, 'expired');
});

test('a promotion expiring in the future is applied', () => {
  const live: Promotion = {
    ...dollarOff,
    expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
  };
  assert.equal(
    evaluatePromotion(product({ promotionId: 'promo-dollar' }), [live], prefs, NOW).status,
    'applied',
  );
});

test('a condition Juva cannot evaluate blocks the promotion', () => {
  const opaque: Promotion = { ...dollarOff, hasUnmodelledCondition: true };
  assert.equal(
    evaluatePromotion(product({ promotionId: 'promo-dollar' }), [opaque], prefs, NOW).status,
    'unmodelled_condition',
  );
});

test('an offer that does not beat the shelf price is not a discount', () => {
  const worse: Promotion = { ...dollarOff, amountOffCents: 0, overridePriceCents: 450 };
  assert.equal(
    evaluatePromotion(product({ promotionId: 'promo-dollar' }), [worse], prefs, NOW).status,
    'not_a_discount',
  );
});

// ── Multibuy arithmetic ─────────────────────────────────────────────────────

test('a 2-for offer is not applied to a single pack', () => {
  const pricing = priceLine(
    item({ quantity: 1 }),
    product({ promotionId: 'promo-2for7' }),
    [twoForSeven],
    prefs,
    NOW,
  );
  assert.equal(pricing.packs, 1);
  assert.equal(pricing.chargedTotalCents, 400, 'one pack pays shelf price');
  assert.equal(pricing.promotionStatus, 'requirement_not_met');
  assert.equal(pricing.promotionSavingsCents, 0);
});

test('a 2-for offer applies fully to exactly two packs', () => {
  const pricing = priceLine(
    item({ quantity: 2 }),
    product({ promotionId: 'promo-2for7' }),
    [twoForSeven],
    prefs,
    NOW,
  );
  assert.equal(pricing.packs, 2);
  assert.equal(pricing.chargedTotalCents, 700);
  assert.equal(pricing.listTotalCents, 800);
  assert.equal(pricing.promotionSavingsCents, 100);
  assert.equal(pricing.promotionStatus, 'applied');
  assert.equal(pricing.promotedPacks, 2);
});

test('a 2-for offer on three packs charges the remainder at shelf price', () => {
  const pricing = priceLine(
    item({ quantity: 3 }),
    product({ promotionId: 'promo-2for7' }),
    [twoForSeven],
    prefs,
    NOW,
  );
  assert.equal(pricing.packs, 3);
  assert.equal(pricing.chargedTotalCents, 1100, '350+350 plus one at 400');
  assert.equal(pricing.promotedPacks, 2);
  assert.equal(pricing.promotionStatus, 'partially_applied');
  assert.equal(pricing.promotionSavingsCents, 100);
});

test('a 2-for offer on four packs applies twice', () => {
  const pricing = priceLine(
    item({ quantity: 4 }),
    product({ promotionId: 'promo-2for7' }),
    [twoForSeven],
    prefs,
    NOW,
  );
  assert.equal(pricing.chargedTotalCents, 1400);
  assert.equal(pricing.promotedPacks, 4);
  assert.equal(pricing.promotionStatus, 'applied');
});

test('a 3-for offer needs three, not two', () => {
  const threeFor: Promotion = {
    id: 'promo-3',
    retailerId: 'north',
    label: '3 for $9',
    requiredQuantity: 3,
    overridePriceCents: 300,
  };
  const two = priceLine(
    item({ quantity: 2 }),
    product({ promotionId: 'promo-3' }),
    [threeFor],
    prefs,
    NOW,
  );
  assert.equal(two.promotionStatus, 'requirement_not_met');
  assert.equal(two.chargedTotalCents, 800);

  const three = priceLine(
    item({ quantity: 3 }),
    product({ promotionId: 'promo-3' }),
    [threeFor],
    prefs,
    NOW,
  );
  assert.equal(three.chargedTotalCents, 900);
  assert.equal(three.promotionStatus, 'applied');
});

test('Juva never adds a pack to reach a multibuy threshold', () => {
  const pricing = priceLine(
    item({ quantity: 1 }),
    product({ promotionId: 'promo-2for7' }),
    [twoForSeven],
    prefs,
    NOW,
  );
  assert.equal(pricing.packs, 1, 'the basket is not inflated to unlock an offer');
});

test('a multibuy threshold cannot be met by weighed goods', () => {
  const pricing = priceLine(
    item({ concept: 'chicken breast', unit: '2 lb', quantity: 1 }),
    product({ promotionId: 'promo-2for7', sizeLabel: '1 lb', soldByWeight: true }),
    [twoForSeven],
    prefs,
    NOW,
  );
  assert.equal(pricing.packs, 2);
  assert.equal(pricing.promotionStatus, 'requirement_not_met');
  assert.equal(pricing.chargedTotalCents, 800, 'two pounds at shelf price');
});

// ── Pack maths inside pricing ───────────────────────────────────────────────

test('a line needing two packs charges for two', () => {
  const pricing = priceLine(
    item({ concept: 'milk', unit: '1 gal', quantity: 1 }),
    product({ sizeLabel: '64 fl oz', priceCents: 279 }),
    [],
    prefs,
    NOW,
  );
  assert.equal(pricing.packs, 2);
  assert.equal(pricing.chargedTotalCents, 558);
});

test('weighed goods produce a fractional multiplier and a single rounding', () => {
  const pricing = priceLine(
    item({ concept: 'chicken breast', unit: '1.5 lb', quantity: 1 }),
    product({ sizeLabel: '1 lb', priceCents: 399, soldByWeight: true }),
    [],
    prefs,
    NOW,
  );
  assert.equal(pricing.packs, 1.5);
  assert.equal(pricing.chargedTotalCents, 599, '399 x 1.5 = 598.5, rounded once');
  assert.equal(pricing.packBasis, 'weighed');
});

test('the effective unit price reflects the promotion actually applied', () => {
  const pricing = priceLine(
    item({ quantity: 2 }),
    product({ promotionId: 'promo-2for7' }),
    [twoForSeven],
    prefs,
    NOW,
  );
  assert.equal(pricing.effectiveUnitCents, 350);
});

test('a comparison unit price is attached when the pack size is readable', () => {
  const pricing = priceLine(
    item(),
    product({ sizeLabel: '500 g', priceCents: 250 }),
    [],
    prefs,
    NOW,
  );
  assert.ok(pricing.unitPrice);
  assert.equal(pricing.unitPrice.dimension, 'mass');

  const unreadable = priceLine(
    item(),
    product({ sizeLabel: 'family size', priceCents: 250 }),
    [],
    prefs,
    NOW,
  );
  assert.equal(unreadable.unitPrice, undefined);
});

test('promotion savings are never negative', () => {
  const pricing = priceLine(item(), product({ promotionId: 'ghost' }), [], prefs, NOW);
  assert.ok(pricing.promotionSavingsCents >= 0);
});

// ── Status labels ───────────────────────────────────────────────────────────

test('an unapplied offer is explained rather than hidden', () => {
  const notMet = priceLine(
    item({ quantity: 1 }),
    product({ promotionId: 'promo-2for7' }),
    [twoForSeven],
    prefs,
    NOW,
  );
  assert.match(promotionStatusLabel(notMet) ?? '', /needs 2, not applied/);

  const missingCard = priceLine(
    item(),
    product({ promotionId: 'promo-loyalty' }),
    [loyalty],
    prefs,
    NOW,
  );
  assert.match(promotionStatusLabel(missingCard) ?? '', /requires a loyalty card/);
});

test('an applied offer shows its own label', () => {
  const applied = priceLine(
    item({ quantity: 2 }),
    product({ promotionId: 'promo-2for7' }),
    [twoForSeven],
    prefs,
    NOW,
  );
  assert.equal(promotionStatusLabel(applied), '2 for $7');
});

test('a partially applied offer says how far it reached', () => {
  const partial = priceLine(
    item({ quantity: 3 }),
    product({ promotionId: 'promo-2for7' }),
    [twoForSeven],
    prefs,
    NOW,
  );
  assert.match(promotionStatusLabel(partial) ?? '', /applied to 2 of 3/);
});

test('no promotion means no label', () => {
  assert.equal(promotionStatusLabel(priceLine(item(), product({}), [], prefs, NOW)), undefined);
});
