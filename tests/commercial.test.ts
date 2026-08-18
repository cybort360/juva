import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  countBand,
  sanitizeProperties,
  savingsBand,
  verificationEventFor,
} from '../src/domain/analytics';
import { demoPreferences } from '../src/domain/demoMarket';
import { optimizeBasket } from '../src/domain/optimizer';
import {
  MIN_PAYWALL_CONFIDENCE,
  paywallValueContext,
  paywallValueIsSound,
  refusalIsNoteworthy,
} from '../src/domain/paywallValue';
import {
  canOfferPurchase,
  describeSubscription,
  grantsPlus,
  subscriptionState,
  type SubscriptionInputs,
} from '../src/domain/subscription';
import type {
  GroceryList,
  GroceryListItem,
  OptimizedPlan,
  RetailerProduct,
  Store,
  UserPreferences,
} from '../src/domain/types';

/**
 * The commercial layer's truth rules.
 *
 * Monetization wraps around Juva's trust system and must never bend it, so these tests
 * are mostly about refusals: the paywall declining to quote a figure it cannot justify,
 * the subscription state declining to call an outage "free", and analytics declining to
 * carry anything a shopper typed or a retailer printed.
 */

const NOW = new Date('2026-08-18T16:00:00Z');

const prefs: UserPreferences = {
  ...demoPreferences,
  onboarded: true,
  maxStores: 3,
  radiusMiles: 25,
  loyaltyRetailers: [],
  couponIds: [],
  conveniencePreference: 0.5,
};

function store(id: string, distanceMiles: number): Store {
  return {
    id,
    retailerId: id,
    retailerName: id.toUpperCase(),
    displayName: id,
    address: `${id} way`,
    distanceMiles,
    etaMinutes: Math.round(distanceMiles * 4),
    colorToken: 'forest',
  };
}

function priced(spec: {
  id: string;
  concept: string;
  storeId: string;
  price: number;
  confidence?: number;
}): RetailerProduct {
  return {
    id: spec.id,
    canonicalConcept: spec.concept,
    storeId: spec.storeId,
    title: `${spec.concept} at ${spec.storeId}`,
    brand: 'Generic',
    sizeLabel: '1 ct',
    observation: {
      id: `obs-${spec.id}`,
      storeId: spec.storeId,
      retailerId: spec.storeId,
      retailerProductId: spec.id,
      scope: 'store',
      priceCents: spec.price,
      currency: 'USD',
      source: 'demo',
      observedAt: NOW.toISOString(),
      freshness: 'demo',
      confidence: spec.confidence ?? 1,
      available: true,
      availability: 'in_stock',
    },
  };
}

function basket(items: Partial<GroceryListItem>[]): GroceryList {
  return {
    id: 'list-1',
    title: 'Weekly groceries',
    prompt: 'weekly',
    currency: 'USD',
    createdAt: NOW.toISOString(),
    items: items.map((item, index) => ({
      id: item.id ?? `i${index + 1}`,
      concept: item.concept ?? 'milk',
      displayName: item.displayName ?? item.concept ?? 'Milk',
      quantity: 1,
      unit: '1 ct',
    })),
  };
}

function plansFor(
  stores: Store[],
  products: RetailerProduct[],
  list: GroceryList,
): OptimizedPlan[] {
  return optimizeBasket({
    list,
    stores,
    products,
    promotions: [],
    preferences: prefs,
    now: NOW,
  });
}

/**
 * A market where splitting genuinely saves money: each store is far cheaper on one line,
 * so a multi-store plan beats the best single store by a real margin.
 */
function splitMarket(confidence = 1) {
  const stores = [store('alpha', 1), store('beta', 2)];
  const products = [
    priced({ id: 'a-milk', concept: 'milk', storeId: 'alpha', price: 300, confidence }),
    priced({ id: 'a-rice', concept: 'rice', storeId: 'alpha', price: 1600, confidence }),
    priced({ id: 'b-milk', concept: 'milk', storeId: 'beta', price: 1500, confidence }),
    priced({ id: 'b-rice', concept: 'rice', storeId: 'beta', price: 400, confidence }),
  ];
  const list = basket([{ concept: 'milk' }, { concept: 'rice' }]);
  return { stores, products, list };
}

// ── The paywall's evidence ──────────────────────────────────────────────────

test('a valid complete market produces a personalized figure that reconciles', () => {
  const { stores, products, list } = splitMarket();
  const result = paywallValueContext({
    plans: plansFor(stores, products, list),
    hasPlus: false,
    now: NOW,
  });
  assert.ok('context' in result, 'a complete comparable market must produce a context');
  const context = result.context;

  // The claim is exactly the subtraction of two plans the optimizer generated.
  assert.equal(
    context.potentialSavingsCents,
    context.baselineCostCents - context.lockedPlanCostCents,
  );
  assert.ok(context.potentialSavingsCents > 0);
  assert.equal(paywallValueIsSound(context), true);
  assert.equal(context.marketCompleteness, 'complete');
  assert.notEqual(context.baselinePlanId, context.lockedPlanId);
  assert.ok(context.additionalStops >= 1, 'the cost of the offer is stated too');
});

test('the paywall figure equals the optimizer output, not a recomputation', () => {
  const { stores, products, list } = splitMarket();
  const plans = plansFor(stores, products, list);
  const result = paywallValueContext({ plans, hasPlus: false, now: NOW });
  assert.ok('context' in result);

  const baseline = plans.find((plan) => plan.id === result.context.baselinePlanId);
  const locked = plans.find((plan) => plan.id === result.context.lockedPlanId);
  assert.ok(baseline && locked, 'both ids name plans the optimizer actually returned');
  assert.equal(result.context.baselineCostCents, baseline.basketCostCents);
  assert.equal(result.context.lockedPlanCostCents, locked.basketCostCents);
  assert.equal(
    result.context.potentialSavingsCents,
    baseline.basketCostCents - locked.basketCostCents,
  );
});

test('a partial market produces no personalized claim', () => {
  const stores = [store('alpha', 1), store('beta', 2)];
  const products = [
    priced({ id: 'a-milk', concept: 'milk', storeId: 'alpha', price: 300 }),
    priced({ id: 'b-milk', concept: 'milk', storeId: 'beta', price: 200 }),
  ];
  // `saffron` is stocked nowhere, so neither plan is comparison-eligible.
  const list = basket([{ concept: 'milk' }, { concept: 'saffron' }]);
  const result = paywallValueContext({
    plans: plansFor(stores, products, list),
    hasPlus: false,
    now: NOW,
  });
  assert.ok('refusal' in result);
  assert.ok(
    result.refusal === 'market_incomplete' || result.refusal === 'no_locked_plan',
    `expected an honest refusal, got ${result.refusal}`,
  );
});

test('zero additional saving produces no misleading paywall', () => {
  // One store is cheapest on everything, so splitting the basket gains nothing.
  const stores = [store('alpha', 1), store('beta', 2)];
  const products = [
    priced({ id: 'a-milk', concept: 'milk', storeId: 'alpha', price: 300 }),
    priced({ id: 'a-rice', concept: 'rice', storeId: 'alpha', price: 400 }),
    priced({ id: 'b-milk', concept: 'milk', storeId: 'beta', price: 900 }),
    priced({ id: 'b-rice', concept: 'rice', storeId: 'beta', price: 900 }),
  ];
  const result = paywallValueContext({
    plans: plansFor(stores, products, list()),
    hasPlus: false,
    now: NOW,
  });
  assert.ok('refusal' in result);
  assert.ok(
    result.refusal === 'no_additional_saving' || result.refusal === 'no_locked_plan',
    `expected a refusal, got ${result.refusal}`,
  );

  function list() {
    return basket([{ concept: 'milk' }, { concept: 'rice' }]);
  }
});

test('a low-confidence plan is not sold on a number', () => {
  // The optimizer is telling us it is unsure what it matched, and a saving computed from
  // uncertain matches has a decimal point and no meaning.
  //
  // The confidence is lowered on a real optimizer plan rather than driven through the
  // market, because a *product* observation's confidence feeds the uncertainty ranking
  // penalty, not the plan's published confidence — the two are deliberately different
  // signals, and this gate reads the published one.
  const { stores, products, list } = splitMarket();
  const plans = plansFor(stores, products, list).map((plan) =>
    plan.stops.length > 1 ? { ...plan, confidence: 0.4 } : plan,
  );

  const result = paywallValueContext({ plans, hasPlus: false, now: NOW });
  assert.ok('refusal' in result);
  assert.equal(result.refusal, 'confidence_too_low');

  // And the same market at full confidence does quote, so the refusal is the threshold
  // doing its job rather than the fixture failing for another reason.
  const confident = paywallValueContext({
    plans: plansFor(stores, products, list),
    hasPlus: false,
    now: NOW,
  });
  assert.ok('context' in confident);
});

test('an existing subscriber is never shown a paywall claim', () => {
  const { stores, products, list } = splitMarket();
  const result = paywallValueContext({
    plans: plansFor(stores, products, list),
    hasPlus: true,
    now: NOW,
  });
  assert.ok('refusal' in result);
  assert.equal(result.refusal, 'already_plus');
});

test('an empty plan set refuses rather than quoting nothing', () => {
  const result = paywallValueContext({ plans: [], hasPlus: false, now: NOW });
  assert.ok('refusal' in result);
  assert.equal(result.refusal, 'no_plans');
});

test('a tampered context fails its own soundness check', () => {
  const { stores, products, list } = splitMarket();
  const result = paywallValueContext({
    plans: plansFor(stores, products, list),
    hasPlus: false,
    now: NOW,
  });
  assert.ok('context' in result);

  assert.equal(
    paywallValueIsSound({ ...result.context, potentialSavingsCents: 9_999 }),
    false,
    'a figure that does not follow from its own evidence is rejected',
  );
  assert.equal(
    paywallValueIsSound({ ...result.context, planConfidence: 0.1 }),
    false,
    'as is one below the confidence floor',
  );
});

test('only interesting refusals are worth surfacing in diagnostics', () => {
  assert.equal(refusalIsNoteworthy('already_plus'), false);
  assert.equal(refusalIsNoteworthy('no_plans'), false);
  assert.equal(refusalIsNoteworthy('market_incomplete'), true);
  assert.equal(refusalIsNoteworthy('confidence_too_low'), true);
  assert.ok(MIN_PAYWALL_CONFIDENCE > 0 && MIN_PAYWALL_CONFIDENCE <= 1);
});

// ── Subscription state ──────────────────────────────────────────────────────

function inputs(over: Partial<SubscriptionInputs> = {}): SubscriptionInputs {
  return {
    configured: true,
    loading: false,
    failed: false,
    liveEntitlementActive: undefined,
    cachedEntitlementActive: undefined,
    purchasePending: false,
    ...over,
  };
}

test('a live answer settles the state either way', () => {
  assert.equal(subscriptionState(inputs({ liveEntitlementActive: true })), 'plus');
  assert.equal(subscriptionState(inputs({ liveEntitlementActive: false })), 'free');
});

test('a pending purchase outranks everything', () => {
  assert.equal(
    subscriptionState(inputs({ purchasePending: true, liveEntitlementActive: false })),
    'purchase_pending',
  );
});

test('a cached grant stands in when there is no live answer', () => {
  assert.equal(
    subscriptionState(inputs({ failed: true, cachedEntitlementActive: true })),
    'offline_cached_plus',
  );
  assert.equal(grantsPlus('offline_cached_plus'), true, 'a paying shopper keeps Plus offline');
});

test('a live answer overrides a cached one, in both directions', () => {
  assert.equal(
    subscriptionState(inputs({ liveEntitlementActive: false, cachedEntitlementActive: true })),
    'free',
    'a lapsed subscription is respected',
  );
  assert.equal(
    subscriptionState(inputs({ liveEntitlementActive: true, cachedEntitlementActive: false })),
    'plus',
  );
});

test('a cached false is not evidence of anything', () => {
  // It means "not subscribed when we last looked", which is not the same as "not
  // subscribed now" — so it must not settle the state.
  assert.equal(
    subscriptionState(inputs({ failed: true, cachedEntitlementActive: false })),
    'billing_unavailable',
  );
});

test('a billing outage is never rendered as the free plan', () => {
  const state = subscriptionState(inputs({ failed: true }));
  assert.equal(state, 'billing_unavailable');
  assert.notEqual(state, 'free');
  assert.equal(grantsPlus(state), false, 'an outage is not a way to get Plus');
  assert.equal(canOfferPurchase(state), false, 'nor a moment to sell');
  assert.match(describeSubscription(state), /shopping is unaffected/i);
});

test('a build with purchases switched off is genuinely free, not broken', () => {
  // No key configured: the shopper cannot buy anything, so free is the truthful state.
  assert.equal(subscriptionState(inputs({ configured: false })), 'free');
});

test('the first frame is unknown, and sells nothing', () => {
  const state = subscriptionState(inputs({ loading: true }));
  assert.equal(state, 'unknown');
  assert.equal(canOfferPurchase(state), false, 'never paywall a subscriber mid-load');
  assert.equal(grantsPlus(state), false);
});

test('only the free state may be offered a purchase', () => {
  const states = [
    'unknown',
    'free',
    'plus',
    'purchase_pending',
    'offline_cached_plus',
    'billing_unavailable',
  ] as const;
  for (const state of states) {
    assert.equal(canOfferPurchase(state), state === 'free', state);
    assert.ok(describeSubscription(state).length > 0, `${state} needs copy`);
  }
});

// ── Analytics privacy ───────────────────────────────────────────────────────

test('savings are reported as bands, never as amounts', () => {
  assert.equal(savingsBand(0), 'none');
  assert.equal(savingsBand(-500), 'none');
  assert.equal(savingsBand(99), 'under_1');
  assert.equal(savingsBand(349), '1_to_5');
  assert.equal(savingsBand(1050), '5_to_15');
  assert.equal(savingsBand(2500), '15_to_40');
  assert.equal(savingsBand(9999), 'over_40');
});

test('counts are banded too', () => {
  assert.equal(countBand(0), '0');
  assert.equal(countBand(3), '1_to_5');
  assert.equal(countBand(12), '6_to_15');
  assert.equal(countBand(20), '16_to_30');
  assert.equal(countBand(80), 'over_30');
});

test('raw product and receipt text is rejected, not merely dropped', () => {
  const { safe, rejected } = sanitizeProperties({
    productName: 'Kellogg’s Corn Flakes 18 oz',
    receiptText: 'WHL MLK 1GAL 3.49',
    basketItemCount: 12,
  });
  assert.deepEqual(Object.keys(safe), ['basketItemCount']);
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every((entry) => entry.reason === 'forbidden_key'));
});

test('precise location never survives sanitization', () => {
  const { safe, rejected } = sanitizeProperties({
    latitude: 37.4067782,
    longitude: -122.0873145,
    gpsAccuracy: 5,
    storeCount: 3,
  });
  assert.deepEqual(Object.keys(safe), ['storeCount']);
  assert.equal(rejected.length, 3);
});

test('identifiers, secrets and model payloads are rejected', () => {
  const { safe, rejected } = sanitizeProperties({
    barcode: '019068100232',
    loyaltyId: 'ABC-123',
    cardLast4: '4242',
    openrouterPrompt: 'here is a receipt',
    apiToken: 'sk-live-xyz',
    planCount: 4,
  });
  assert.deepEqual(Object.keys(safe), ['planCount']);
  assert.equal(rejected.length, 5);
});

test('a free-text value is rejected even under an innocent key', () => {
  // The type system blocks this at compile time; this is the runtime backstop for
  // anything arriving from an untyped boundary.
  const { safe, rejected } = sanitizeProperties({ outcome: 'bought 3 bags of rice' });
  assert.deepEqual(safe, {});
  assert.equal(rejected[0]?.reason, 'unsupported_value');
});

test('Juva’s own enumerated values do survive', () => {
  const { safe, rejected } = sanitizeProperties({
    marketCompleteness: 'complete',
    marketMode: 'demo',
    savingsBand: '5_to_15',
    verificationState: 'blocked',
    packageKind: 'annual',
    planChanged: true,
    stopCount: 2,
  });
  assert.deepEqual(rejected, []);
  assert.equal(Object.keys(safe).length, 7);
});

test('a blocked verification is a different event from a completed one', () => {
  // Collapsing them would flatter the verification rate, which is exactly the number
  // nobody should be able to improve without improving the product.
  assert.equal(verificationEventFor('verified'), 'receipt_verification_completed');
  assert.equal(verificationEventFor('blocked'), 'receipt_verification_blocked');
  assert.equal(verificationEventFor('pending'), 'receipt_verification_blocked');
  assert.equal(verificationEventFor('integrity_failed'), 'receipt_integrity_failed');
  assert.notEqual(
    verificationEventFor('integrity_failed'),
    verificationEventFor('verified'),
    'an integrity failure is never a verified completion',
  );
});

test('NaN and infinite numbers do not reach analytics', () => {
  const { safe, rejected } = sanitizeProperties({ a: Number.NaN, b: Infinity, c: 7 });
  assert.deepEqual(Object.keys(safe), ['c']);
  assert.equal(rejected.length, 2);
});
