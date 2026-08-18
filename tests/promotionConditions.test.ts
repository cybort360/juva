import assert from 'node:assert/strict';
import { test } from 'node:test';

import { demoPreferences } from '../src/domain/demoMarket';
import {
  discountForCents,
  evaluateEligibility,
  evaluatePromotion,
  priceLine,
  promotionStatusLabel,
} from '../src/domain/pricing';
import type {
  GroceryListItem,
  Promotion,
  RetailerProduct,
  UserPreferences,
} from '../src/domain/types';

/**
 * Structured promotion conditions.
 *
 * The rule these all serve is one line long — never apply a promotion until its
 * requirements are satisfied — but "satisfied" has three answers, not two. A minimum
 * spend cannot be judged from a single line, and the honest response is `unresolved`:
 * not "no discount" (which would rob the shopper) and not "discount" (which would
 * understate the bill). An unresolved condition never yields money.
 */

const NOW = new Date('2026-08-11T12:00:00Z');

const prefs: UserPreferences = {
  ...demoPreferences,
  loyaltyRetailers: [],
  couponIds: [],
};

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

function product(
  overrides: {
    price?: number;
    promotionId?: string;
    additional?: string[];
    retailerId?: string;
    size?: string;
  } = {},
): RetailerProduct {
  return {
    id: 'p1',
    canonicalConcept: 'cereal',
    storeId: 's1',
    title: 'Corn Flakes',
    brand: "Kellogg's",
    sizeLabel: overrides.size ?? '18 oz',
    observation: {
      id: 'o1',
      storeId: 's1',
      retailerId: overrides.retailerId ?? 'grove',
      retailerProductId: 'p1',
      scope: 'store',
      priceCents: overrides.price ?? 500,
      currency: 'USD',
      source: 'demo',
      observedAt: NOW.toISOString(),
      freshness: 'demo',
      confidence: 0.9,
      available: true,
      availability: 'in_stock',
      ...(overrides.promotionId === undefined ? {} : { promotionId: overrides.promotionId }),
      ...(overrides.additional === undefined
        ? {}
        : { additionalPromotionIds: overrides.additional }),
    },
  };
}

function promo(overrides: Partial<Promotion> & { id: string }): Promotion {
  return { retailerId: 'grove', label: 'Offer', ...overrides };
}

function verdictOf(promotion: Promotion, overrides: Partial<UserPreferences> = {}, spend?: number) {
  return evaluateEligibility(promotion, product({ promotionId: promotion.id }), {
    prefs: { ...prefs, ...overrides },
    now: NOW,
    ...(spend === undefined ? {} : { retailerSpendCents: spend }),
  });
}

function conditionOf(
  promotion: Promotion,
  condition: string,
  overrides: Partial<UserPreferences> = {},
  spend?: number,
) {
  return verdictOf(promotion, overrides, spend).conditions.find(
    (entry) => entry.condition === condition,
  );
}

// ── Minimum spend ───────────────────────────────────────────────────────────

test('minimum spend met makes the offer eligible', () => {
  const offer = promo({ id: 'p', amountOffCents: 100, minimumBasketSpendCents: 2000 });
  const result = verdictOf(offer, {}, 2500);
  assert.equal(result.verdict, 'eligible');
  assert.equal(conditionOf(offer, 'minimum_spend', {}, 2500)?.state, 'met');
});

test('minimum spend not met makes the offer ineligible and says the shortfall', () => {
  const offer = promo({ id: 'p', amountOffCents: 100, minimumBasketSpendCents: 2000 });
  const result = verdictOf(offer, {}, 1500);
  assert.equal(result.verdict, 'ineligible');
  assert.equal(result.blockingCondition, 'minimum_spend');
  assert.equal(result.status, 'minimum_spend_not_met');
  assert.match(String(conditionOf(offer, 'minimum_spend', {}, 1500)?.detail), /only 1500c/);
});

test('minimum spend exactly at the threshold counts as met', () => {
  const offer = promo({ id: 'p', amountOffCents: 100, minimumBasketSpendCents: 2000 });
  assert.equal(verdictOf(offer, {}, 2000).verdict, 'eligible');
});

test('an unknown spend is unresolved, and its discount is not taken', () => {
  const offer = promo({ id: 'p', amountOffCents: 100, minimumBasketSpendCents: 2000 });
  const result = verdictOf(offer);
  assert.equal(result.verdict, 'unresolved');
  assert.equal(result.blockingCondition, 'minimum_spend');

  // The decision must charge the shelf price, not the discounted one.
  const decision = evaluatePromotion(product({ promotionId: 'p' }), [offer], prefs, NOW);
  assert.equal(decision.promotedUnitCents, 500, 'unresolved yields no money');
  assert.deepEqual(decision.appliedPromotions, []);
  assert.equal(decision.hasUnresolved, true);
});

test('an unresolved promotion is excluded from the line total and the saving', () => {
  const offer = promo({ id: 'p', amountOffCents: 100, minimumBasketSpendCents: 2000 });
  const pricing = priceLine(item(), product({ promotionId: 'p' }), [offer], prefs, NOW);
  assert.equal(pricing.chargedTotalCents, 500);
  assert.equal(pricing.promotionSavingsCents, 0);
  assert.equal(pricing.hasUnresolvedPromotion, true);
  assert.deepEqual(pricing.appliedPromotions, []);
});

test('the same offer applies once the spend is supplied', () => {
  const offer = promo({ id: 'p', amountOffCents: 100, minimumBasketSpendCents: 2000 });
  const pricing = priceLine(item(), product({ promotionId: 'p' }), [offer], prefs, NOW, 2500);
  assert.equal(pricing.chargedTotalCents, 400);
  assert.equal(pricing.promotionSavingsCents, 100);
  assert.equal(pricing.hasUnresolvedPromotion, false);
  assert.equal(pricing.appliedPromotions.length, 1);
});

// ── Coupons ─────────────────────────────────────────────────────────────────

test('a coupon present makes a coupon-gated offer eligible', () => {
  const offer = promo({ id: 'coupon-1', couponRequired: true, couponAmountOffCents: 150 });
  const result = verdictOf(offer, { couponIds: ['coupon-1'] });
  assert.equal(result.verdict, 'eligible');
  assert.equal(conditionOf(offer, 'coupon', { couponIds: ['coupon-1'] })?.state, 'met');
});

test('a coupon absent makes it ineligible, never assumed', () => {
  const offer = promo({ id: 'coupon-1', couponRequired: true, couponAmountOffCents: 150 });
  const result = verdictOf(offer);
  assert.equal(result.verdict, 'ineligible');
  assert.equal(result.status, 'coupon_missing');
  assert.equal(result.blockingCondition, 'coupon');
});

test('a coupon percentage is applied to the shelf price and floored', () => {
  // 15% of 499c is 74.85c. Flooring means Juva claims 74c, never 75c — a rounding
  // error must not favour Juva's savings number over the receipt.
  const offer = promo({ id: 'p', couponPercentOff: 15 });
  assert.equal(discountForCents(offer, 499), 74);
});

test('a coupon discount is kept separate from a shelf discount and both apply', () => {
  const offer = promo({ id: 'p', amountOffCents: 50, couponAmountOffCents: 100 });
  assert.equal(discountForCents(offer, 500), 150, 'one offer expressing value two ways');
});

test('a discount can never exceed the price', () => {
  const offer = promo({ id: 'p', couponAmountOffCents: 900, couponPercentOff: 50 });
  assert.equal(discountForCents(offer, 500), 500);
  const pricing = priceLine(item(), product({ promotionId: 'p' }), [offer], prefs, NOW);
  assert.equal(pricing.chargedTotalCents, 0, 'free, but never negative');
});

test('an override price wins over every discount field', () => {
  const offer = promo({ id: 'p', overridePriceCents: 399, amountOffCents: 999 });
  assert.equal(discountForCents(offer, 500), 101);
});

// ── Loyalty + coupon together ───────────────────────────────────────────────

test('loyalty and coupon must both hold for a doubly-gated offer', () => {
  const offer = promo({
    id: 'both',
    loyaltyRequired: true,
    couponRequired: true,
    couponAmountOffCents: 200,
  });
  assert.equal(verdictOf(offer).verdict, 'ineligible');
  assert.equal(verdictOf(offer, { loyaltyRetailers: ['grove'] }).status, 'coupon_missing');
  assert.equal(verdictOf(offer, { couponIds: ['both'] }).status, 'loyalty_missing');

  const both = verdictOf(offer, { loyaltyRetailers: ['grove'], couponIds: ['both'] });
  assert.equal(both.verdict, 'eligible');
  assert.equal(
    both.conditions.filter((entry) => entry.state === 'met').length,
    both.conditions.length,
    'every condition reported, all met',
  );
});

test('loyalty is checked against the retailer, not any retailer', () => {
  const offer = promo({ id: 'p', loyaltyRequired: true, amountOffCents: 50 });
  assert.equal(verdictOf(offer, { loyaltyRetailers: ['north'] }).status, 'loyalty_missing');
  assert.equal(verdictOf(offer, { loyaltyRetailers: ['grove'] }).verdict, 'eligible');
});

// ── Expiry ──────────────────────────────────────────────────────────────────

test('an expired coupon is ineligible even when held', () => {
  const offer = promo({
    id: 'old',
    couponRequired: true,
    couponAmountOffCents: 200,
    expiresAt: '2026-08-01T00:00:00.000Z',
  });
  const result = verdictOf(offer, { couponIds: ['old'] });
  assert.equal(result.verdict, 'ineligible');
  assert.equal(result.status, 'expired');
  assert.equal(result.blockingCondition, 'expiry');
});

test('an offer expiring exactly now is treated as expired', () => {
  // The boundary favours the receipt: an offer whose last instant is this one is not
  // something Juva will promise.
  const offer = promo({ id: 'p', amountOffCents: 50, expiresAt: NOW.toISOString() });
  assert.equal(verdictOf(offer).status, 'expired');
});

// ── Multibuy ────────────────────────────────────────────────────────────────

test('a multibuy states its threshold as a condition', () => {
  const offer = promo({ id: 'p', requiredQuantity: 2, overridePriceCents: 350 });
  assert.equal(conditionOf(offer, 'multibuy')?.state, 'met');
  assert.match(String(conditionOf(offer, 'multibuy')?.detail), /buy 2 together/);
});

test('a multibuy below its threshold charges the shelf price', () => {
  const offer = promo({ id: 'p', requiredQuantity: 2, overridePriceCents: 350 });
  const pricing = priceLine(
    item({ quantity: 1 }),
    product({ promotionId: 'p' }),
    [offer],
    prefs,
    NOW,
  );
  assert.equal(pricing.promotionStatus, 'requirement_not_met');
  assert.equal(pricing.chargedTotalCents, 500);
  assert.deepEqual(pricing.appliedPromotions, [], 'eligible in principle, but took nothing off');
});

test('multibuy and minimum spend must both be satisfied', () => {
  const offer = promo({
    id: 'p',
    requiredQuantity: 2,
    overridePriceCents: 350,
    minimumBasketSpendCents: 1500,
  });
  // Two packs exactly: 2 × 18 oz against an 18 oz pack.
  const twoPacks = item({ quantity: 2, unit: '18 oz' });

  // Threshold met, spend unknown: nothing applied.
  const unresolved = priceLine(twoPacks, product({ promotionId: 'p' }), [offer], prefs, NOW);
  assert.equal(unresolved.chargedTotalCents, 1000);
  assert.equal(unresolved.hasUnresolvedPromotion, true);

  // Threshold met, spend below the minimum: still nothing.
  const short = priceLine(twoPacks, product({ promotionId: 'p' }), [offer], prefs, NOW, 900);
  assert.equal(short.chargedTotalCents, 1000);
  assert.equal(short.promotionStatus, 'minimum_spend_not_met');

  // Both satisfied: two packs at the offer price.
  const applied = priceLine(twoPacks, product({ promotionId: 'p' }), [offer], prefs, NOW, 1500);
  assert.equal(applied.chargedTotalCents, 700);
  assert.equal(applied.promotionStatus, 'applied');
});

test('a minimum spend met but multibuy unmet applies nothing', () => {
  const offer = promo({
    id: 'p',
    requiredQuantity: 3,
    overridePriceCents: 350,
    minimumBasketSpendCents: 100,
  });
  const pricing = priceLine(
    item({ quantity: 1 }),
    product({ promotionId: 'p' }),
    [offer],
    prefs,
    NOW,
    5000,
  );
  assert.equal(pricing.promotionStatus, 'requirement_not_met');
  assert.equal(pricing.chargedTotalCents, 500);
});

// ── Stackability ────────────────────────────────────────────────────────────

test('two stackable offers both apply', () => {
  const shelf = promo({ id: 'a', label: '50c off', amountOffCents: 50, stackable: true });
  const coupon = promo({
    id: 'b',
    label: '$1 coupon',
    couponRequired: true,
    couponAmountOffCents: 100,
    stackable: true,
  });
  const decision = evaluatePromotion(
    product({ promotionId: 'a', additional: ['b'] }),
    [shelf, coupon],
    { ...prefs, couponIds: ['b'] },
    NOW,
  );
  assert.equal(decision.appliedPromotions.length, 2);
  assert.equal(decision.promotedUnitCents, 350, '500 − 50 − 100');
});

test('competing non-stackable offers apply only the best one', () => {
  const small = promo({ id: 'a', label: '50c off', amountOffCents: 50 });
  const large = promo({ id: 'b', label: '$2 off', amountOffCents: 200 });
  const decision = evaluatePromotion(
    product({ promotionId: 'a', additional: ['b'] }),
    [small, large],
    prefs,
    NOW,
  );
  assert.equal(decision.appliedPromotions.length, 1);
  assert.equal(decision.appliedPromotions[0]?.id, 'b', 'the shopper gets the better offer');
  assert.equal(decision.promotedUnitCents, 300);
});

test('one non-stackable offer forbids the whole combination', () => {
  // "Cannot be combined with other offers" is a statement about the other offers too,
  // so a stackable partner does not rescue it.
  const stackable = promo({ id: 'a', amountOffCents: 50, stackable: true });
  const exclusive = promo({ id: 'b', amountOffCents: 200, stackable: false });
  const decision = evaluatePromotion(
    product({ promotionId: 'a', additional: ['b'] }),
    [stackable, exclusive],
    prefs,
    NOW,
  );
  assert.equal(decision.appliedPromotions.length, 1);
  assert.equal(decision.promotedUnitCents, 300, 'the better single offer, not 250');
});

test('stacking defaults to forbidden when a source does not say', () => {
  // A feed that is silent has not granted permission, and assuming it did would
  // understate the bill.
  const a = promo({ id: 'a', amountOffCents: 50 });
  const b = promo({ id: 'b', amountOffCents: 60 });
  const decision = evaluatePromotion(
    product({ promotionId: 'a', additional: ['b'] }),
    [a, b],
    prefs,
    NOW,
  );
  assert.equal(decision.appliedPromotions.length, 1);
  assert.equal(decision.promotedUnitCents, 440, '500 − 60, not 500 − 110');
});

test('an ineligible offer never blocks an eligible one from stacking', () => {
  const held = promo({ id: 'a', amountOffCents: 50, stackable: true });
  const unheld = promo({
    id: 'b',
    couponRequired: true,
    couponAmountOffCents: 300,
    stackable: true,
  });
  const decision = evaluatePromotion(
    product({ promotionId: 'a', additional: ['b'] }),
    [held, unheld],
    prefs,
    NOW,
  );
  assert.equal(decision.appliedPromotions.length, 1);
  assert.equal(decision.appliedPromotions[0]?.id, 'a');
  assert.equal(decision.promotedUnitCents, 450);
  assert.equal(decision.eligibility.length, 2, 'both are still reported');
});

// ── Unresolved and unmodelled conditions ────────────────────────────────────

test('a condition Juva cannot model is ineligible, not unresolved', () => {
  // Unresolved means "ask again later". There is no later for a condition Juva has no
  // way to evaluate at all, so it is a refusal rather than a deferral.
  const offer = promo({ id: 'p', amountOffCents: 100, hasUnmodelledCondition: true });
  const result = verdictOf(offer);
  assert.equal(result.verdict, 'ineligible');
  assert.equal(result.status, 'unmodelled_condition');
});

test('an offer from another retailer is ineligible on the retailer condition', () => {
  const offer = promo({ id: 'p', retailerId: 'north', amountOffCents: 100 });
  const result = evaluateEligibility(offer, product({ retailerId: 'grove', promotionId: 'p' }), {
    prefs,
    now: NOW,
  });
  assert.equal(result.verdict, 'ineligible');
  assert.equal(result.blockingCondition, 'retailer');
});

test('an offer that does not beat the shelf price is not a discount', () => {
  const offer = promo({ id: 'p', overridePriceCents: 500 });
  assert.equal(verdictOf(offer).status, 'not_a_discount');
  assert.equal(verdictOf(offer).verdict, 'ineligible');
});

test('every condition is reported even after one fails', () => {
  // The explanation shows the whole picture, not only the first obstacle.
  const offer = promo({
    id: 'p',
    loyaltyRequired: true,
    couponRequired: true,
    requiredQuantity: 2,
    minimumBasketSpendCents: 5000,
    amountOffCents: 100,
    expiresAt: '2027-01-01T00:00:00.000Z',
  });
  const result = verdictOf(offer);
  const named = result.conditions.map((entry) => entry.condition);
  for (const condition of [
    'retailer',
    'expiry',
    'loyalty',
    'coupon',
    'multibuy',
    'minimum_spend',
  ]) {
    assert.ok(named.includes(condition as never), `${condition} must be reported`);
  }
  for (const entry of result.conditions) {
    assert.ok(entry.detail.length > 0, `${entry.condition} must be explainable`);
  }
});

test('a promotion with no conditions at all is simply eligible', () => {
  const offer = promo({ id: 'p', amountOffCents: 100 });
  const result = verdictOf(offer);
  assert.equal(result.verdict, 'eligible');
  assert.equal(result.blockingCondition, undefined);
});

test('a product with no promotion reports none, not a failure', () => {
  const decision = evaluatePromotion(product(), [], prefs, NOW);
  assert.equal(decision.status, 'none');
  assert.deepEqual(decision.eligibility, []);
  assert.equal(decision.hasUnresolved, false);
});

test('a promotion id pointing at nothing is ignored rather than invented', () => {
  const decision = evaluatePromotion(product({ promotionId: 'ghost' }), [], prefs, NOW);
  assert.equal(decision.status, 'none');
  assert.equal(decision.promotedUnitCents, 500);
});

// ── Labels ──────────────────────────────────────────────────────────────────

test('each new status has copy that names the obstacle', () => {
  const cases: { offer: Promotion; spend?: number; match: RegExp }[] = [
    {
      offer: promo({ id: 'a', label: 'Save $1', couponRequired: true, couponAmountOffCents: 100 }),
      match: /coupon/i,
    },
    {
      offer: promo({
        id: 'b',
        label: 'Save $1',
        amountOffCents: 100,
        minimumBasketSpendCents: 9000,
      }),
      spend: 100,
      match: /larger spend/i,
    },
    {
      offer: promo({
        id: 'c',
        label: 'Save $1',
        amountOffCents: 100,
        minimumBasketSpendCents: 9000,
      }),
      match: /not confirmed/i,
    },
  ];
  for (const entry of cases) {
    const pricing = priceLine(
      item(),
      product({ promotionId: entry.offer.id }),
      [entry.offer],
      prefs,
      NOW,
      entry.spend,
    );
    assert.match(String(promotionStatusLabel(pricing)), entry.match);
  }
});
