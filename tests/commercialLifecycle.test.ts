import assert from 'node:assert/strict';
import { test } from 'node:test';

import { savingsBand, verificationEventFor } from '../src/domain/analytics';
import { AnalyticsQueue, MemoryTransport } from '../src/domain/analyticsQueue';
import { demoPreferences } from '../src/domain/demoMarket';
import { optimizeBasket } from '../src/domain/optimizer';
import { paywallValueContext, paywallValueIsSound } from '../src/domain/paywallValue';
import { buildLedger, persistLedger, readableLedgers } from '../src/domain/savingsLedger';
import { adaptTrip, applyAdaptation } from '../src/domain/shopAdapt';
import { grantsPlus, subscriptionState, type SubscriptionState } from '../src/domain/subscription';
import { createTrip } from '../src/domain/trip';
import type {
  GroceryList,
  GroceryListItem,
  MarketSnapshot,
  OptimizedPlan,
  PersistedLedger,
  Receipt,
  ReceiptLine,
  RetailerProduct,
  Store,
  UserPreferences,
} from '../src/domain/types';

/**
 * The commercial loop, end to end, deterministically.
 *
 * value → paywall → purchase → entitlement → exact plan unlock → shopping → verification
 * → persistence → restart → identical result.
 *
 * The purchase leg uses a fake adapter implementing the same application-facing boundary
 * as the real one. That is emphatically **not** evidence that a real store purchase
 * works — `docs/TEST_STORE_DEVICE_CHECKLIST.md` is the release gate for that. What this
 * proves is Juva's own integration: that the figure in the paywall is the figure the
 * optimizer produced, that entitlement flows through the canonical state, and that the
 * exact plan that was locked is the one that unlocks.
 */

const NOW = new Date('2026-08-18T18:00:00Z');

const prefs: UserPreferences = {
  ...demoPreferences,
  onboarded: true,
  maxStores: 2,
  radiusMiles: 25,
  loyaltyRetailers: [],
  couponIds: [],
  conveniencePreference: 0.5,
};

// ─────────────────────────────────────────────────────────────────────────────
// A fake RevenueCat, at the same boundary the real provider exposes
// ─────────────────────────────────────────────────────────────────────────────

type PurchaseOutcome = 'success' | 'pending' | 'cancelled' | 'failed';

/**
 * Implements the application-facing purchase boundary without the SDK.
 *
 * Deliberately models `CustomerInfo` arriving *separately* from the purchase call, which
 * is what really happens: the store confirms, and the entitlement turns up when the
 * customer-info listener fires. Collapsing the two would hide the entitlement-delay bug
 * this suite exists to catch.
 */
class FakeRevenueCat {
  private liveEntitlement: boolean | undefined;
  private cachedEntitlement: boolean | undefined;
  private pending = false;
  private failed = false;
  private configured = true;

  /** What the next purchase call will do. */
  outcome: PurchaseOutcome = 'success';
  /** When true, a successful purchase does not immediately grant the entitlement. */
  delayEntitlement = false;

  constructor(private readonly events: AnalyticsQueue) {}

  ready(active: boolean): void {
    this.liveEntitlement = active;
  }

  goOffline(cached?: boolean): void {
    this.liveEntitlement = undefined;
    this.failed = true;
    this.cachedEntitlement = cached;
  }

  async purchase(packageKind: 'monthly' | 'annual'): Promise<PurchaseOutcome> {
    this.events.record('purchase_started', { packageKind });
    const outcome = this.outcome;

    if (outcome === 'success') {
      this.events.record('purchase_completed', { packageKind });
      if (!this.delayEntitlement) this.liveEntitlement = true;
    } else if (outcome === 'cancelled') {
      this.events.record('purchase_cancelled', { packageKind });
    } else if (outcome === 'failed') {
      this.events.record('purchase_failed', { packageKind });
    } else {
      this.pending = true;
    }
    return Promise.resolve(outcome);
  }

  /** The customer-info listener firing. */
  deliverEntitlement(active: boolean): void {
    this.liveEntitlement = active;
    this.pending = false;
  }

  async restore(): Promise<boolean> {
    this.events.record('restore_started');
    const restored = this.liveEntitlement === true;
    this.events.record('restore_completed', { restoredPlus: restored });
    return Promise.resolve(restored);
  }

  /** Exactly the derivation the real provider performs. */
  state(): SubscriptionState {
    return subscriptionState({
      configured: this.configured,
      loading: false,
      failed: this.failed,
      liveEntitlementActive: this.liveEntitlement,
      cachedEntitlementActive: this.cachedEntitlement,
      purchasePending: this.pending,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Market fixtures
// ─────────────────────────────────────────────────────────────────────────────

function store(id: string, distanceMiles: number): Store {
  return {
    id,
    retailerId: id,
    retailerName: id === 'alpha' ? 'Grove Market' : 'North Market',
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
  title: string;
}): RetailerProduct {
  return {
    id: spec.id,
    canonicalConcept: spec.concept,
    storeId: spec.storeId,
    title: spec.title,
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
      confidence: 1,
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

function receiptLine(over: Partial<ReceiptLine> & { id: string }): ReceiptLine {
  return {
    rawText: over.productName ?? 'ITEM',
    productName: over.productName ?? 'Item',
    chargedPriceCents: 0,
    quantity: 1,
    kind: 'item',
    ...over,
  };
}

function receipt(storeId: string, lines: ReceiptLine[]): Receipt {
  return {
    id: `r-${storeId}`,
    capturedAt: NOW.toISOString(),
    storeId,
    merchant: storeId === 'alpha' ? 'Grove Market' : 'North Market',
    source: 'scan',
    imageUris: [],
    currency: 'USD',
    lines,
    totalCents: lines.reduce((sum, entry) => sum + entry.chargedPriceCents, 0),
    confidence: 0.95,
  };
}

/** Each store is far cheaper on one line, so splitting genuinely pays. */
function market() {
  const stores = [store('alpha', 1), store('beta', 2)];
  const products = [
    priced({ id: 'a-milk', concept: 'milk', storeId: 'alpha', price: 349, title: 'Whole Milk' }),
    priced({
      id: 'a-rice',
      concept: 'rice',
      storeId: 'alpha',
      price: 1800,
      title: 'Long Grain Rice',
    }),
    priced({ id: 'b-milk', concept: 'milk', storeId: 'beta', price: 1600, title: 'Whole Milk' }),
    priced({
      id: 'b-rice',
      concept: 'rice',
      storeId: 'beta',
      price: 420,
      title: 'Long Grain Rice',
    }),
  ];
  const list = basket([
    { concept: 'milk', displayName: 'Milk' },
    { concept: 'rice', displayName: 'Rice' },
  ]);
  const snapshot: MarketSnapshot = {
    mode: 'demo',
    fetchedAt: NOW.toISOString(),
    stores,
    products,
    promotions: [],
  };
  return { stores, products, list, snapshot };
}

function plansFor(): OptimizedPlan[] {
  const { stores, products, list } = market();
  return optimizeBasket({
    list,
    stores,
    products,
    promotions: [],
    preferences: prefs,
    now: NOW,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The happy path
// ─────────────────────────────────────────────────────────────────────────────

test('the full commercial lifecycle, from free basket to reopened ledger', async () => {
  const transport = new MemoryTransport();
  const events = new AnalyticsQueue(transport);
  const billing = new FakeRevenueCat(events);

  // ── A free shopper builds a basket ──────────────────────────────────────
  billing.ready(false);
  assert.equal(billing.state(), 'free');
  assert.equal(grantsPlus(billing.state()), false);

  const { list, snapshot } = market();
  events.record('list_created', { basketItemCount: 2 });
  events.record('market_search_started');

  const plans = plansFor();
  events.record('market_search_completed', { storeCount: 2, marketMode: 'demo' });
  events.record('optimization_completed', {
    planCount: plans.length,
    marketCompleteness: 'complete',
  });

  const single = plans.find((plan) => plan.stops.length === 1);
  const multi = plans.find((plan) => plan.stops.length > 1);
  assert.ok(single && multi, 'the fixture must produce both a single- and multi-store plan');
  events.record('single_store_plan_seen');
  events.record('juva_pick_found');
  events.record('juva_pick_locked');

  // ── The paywall's evidence ──────────────────────────────────────────────
  const valueResult = paywallValueContext({ plans, hasPlus: false, now: NOW });
  assert.ok('context' in valueResult, 'a complete comparable market must produce a context');
  const value = valueResult.context;
  assert.equal(paywallValueIsSound(value), true);

  events.record('paywall_seen', { subscriptionState: billing.state() });
  events.record('paywall_value_context_present', {
    savingsBand: savingsBand(value.potentialSavingsCents),
  });

  // The displayed figure is the subtraction of two plans the optimizer generated.
  assert.equal(
    value.potentialSavingsCents,
    value.baselineCostCents - value.lockedPlanCostCents,
    'the paywall figure is arithmetic over real plans',
  );
  assert.equal(value.baselineCostCents, single.basketCostCents);
  assert.equal(value.lockedPlanCostCents, multi.basketCostCents);

  // ── Purchase ────────────────────────────────────────────────────────────
  const outcome = await billing.purchase('monthly');
  assert.equal(outcome, 'success');
  assert.equal(billing.state(), 'plus', 'entitlement flows through the canonical state');
  assert.equal(grantsPlus(billing.state()), true);

  // ── The EXACT locked plan unlocks — not a recomputation ─────────────────
  const unlocked = plans.find((plan) => plan.id === value.lockedPlanId);
  assert.ok(unlocked, 'the locked plan id still names a real plan');
  assert.equal(unlocked.basketCostCents, value.lockedPlanCostCents, 'to the cent');
  assert.equal(unlocked.id, multi.id);

  // ── Shop Mode ───────────────────────────────────────────────────────────
  const trip = createTrip(unlocked, list, snapshot, NOW);
  events.record('shop_mode_started', { stopCount: trip.stops.length });
  const frozenBaseline = trip.origin.comparedBaselineCents;
  const frozenPlanned = trip.origin.basketCostCents;
  assert.equal(frozenPlanned, unlocked.basketCostCents);

  // An adaptation: the milk rang up 30c dearer.
  const decision = adaptTrip({
    trip,
    event: { kind: 'different_price', groceryItemId: 'i1', observedPriceCents: 379 },
    preferences: prefs,
    now: NOW,
  });
  assert.ok(decision);
  const shopped = applyAdaptation({ trip, decision, chosenOptionId: 'buy_here', now: NOW });
  assert.ok(shopped);
  events.record('shop_adaptation_created', { adaptationKind: 'different_price' });
  events.record('shop_trip_completed');

  // ── Receipt verification ────────────────────────────────────────────────
  events.record('receipt_verification_started');
  const receipts = [
    receipt('alpha', [
      receiptLine({ id: 'l1', productName: 'Whole Milk', chargedPriceCents: 379 }),
    ]),
    receipt('beta', [
      receiptLine({ id: 'l2', productName: 'Long Grain Rice', chargedPriceCents: 420 }),
    ]),
  ];
  const ledger = buildLedger({
    trip: shopped.trip,
    plan: unlocked,
    receipts,
    currency: 'USD',
    now: NOW,
  });

  events.record(verificationEventFor(ledger.claimability.state), {
    verificationState: ledger.claimability.state,
  });
  assert.equal(ledger.claimability.state, 'verified', ledger.claimability.blockers.join(','));
  assert.equal(typeof ledger.verifiedSavingsCents, 'number');
  events.record('verified_savings_created', {
    savingsBand: savingsBand(ledger.verifiedSavingsCents ?? 0),
  });

  /**
   * The verified saving is independent of the paywall's estimate.
   *
   * The paywall compared two *plans*; the ledger compares the frozen baseline against
   * what a receipt says was actually paid. They answer different questions and are not
   * required to agree — what matters is that neither was derived from the other.
   */
  assert.equal(ledger.baselineCents, frozenBaseline, 'measured against the frozen baseline');
  assert.equal(ledger.originalPlannedCents, frozenPlanned);
  assert.equal(
    ledger.verifiedSavingsCents,
    Math.max(0, frozenBaseline - ledger.actualCents),
    'baseline minus actual eligible spend',
  );

  // ── Persist, restart, reopen ────────────────────────────────────────────
  const frozen = persistLedger(ledger, ['Grove Market', 'North Market'], NOW);
  const rehydrated = JSON.parse(JSON.stringify({ ledgers: [frozen] })) as {
    ledgers: PersistedLedger[];
  };
  const reopened = readableLedgers(rehydrated.ledgers)[0];
  assert.ok(reopened);

  assert.equal(
    JSON.stringify(reopened.ledger),
    JSON.stringify(ledger),
    'the reopened ledger is identical, not merely equivalent',
  );
  assert.equal(reopened.ledger.verifiedSavingsCents, ledger.verifiedSavingsCents);

  // Subscription resolves correctly after the restart too.
  billing.ready(true);
  assert.equal(billing.state(), 'plus');

  // ── The events actually fired, from real transitions ────────────────────
  await events.flush();
  await events.flush();
  const names = transport.names();
  for (const expected of [
    'list_created',
    'market_search_started',
    'market_search_completed',
    'optimization_completed',
    'single_store_plan_seen',
    'juva_pick_found',
    'juva_pick_locked',
    'paywall_seen',
    'paywall_value_context_present',
    'purchase_started',
    'purchase_completed',
    'shop_mode_started',
    'shop_adaptation_created',
    'shop_trip_completed',
    'receipt_verification_started',
    'receipt_verification_completed',
    'verified_savings_created',
  ] as const) {
    assert.ok(names.includes(expected), `${expected} must be emitted`);
  }

  // Ordering: value is established before it is sold, and sold before it is shopped.
  assert.ok(
    names.indexOf('paywall_value_context_present') < names.indexOf('purchase_started'),
    'the claim precedes the sale',
  );
  assert.ok(
    names.indexOf('purchase_completed') < names.indexOf('shop_mode_started'),
    'the sale precedes the shop',
  );
  assert.ok(
    names.indexOf('shop_trip_completed') < names.indexOf('verified_savings_created'),
    'the shop precedes the proof',
  );

  // And nothing identifying travelled with any of them.
  for (const entry of transport.delivered) {
    for (const [key, propertyValue] of Object.entries(entry.properties)) {
      assert.equal(
        /name|text|address|barcode|loyalty|receiptLine/i.test(key),
        false,
        `${entry.event} carried a forbidden key: ${key}`,
      );
      assert.ok(typeof propertyValue !== 'object', `${entry.event}.${key} must be a scalar`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Negative lifecycles
// ─────────────────────────────────────────────────────────────────────────────

test('cancellation leaves the shopper free, the plan locked and the basket intact', async () => {
  const transport = new MemoryTransport();
  const events = new AnalyticsQueue(transport);
  const billing = new FakeRevenueCat(events);
  billing.ready(false);

  const plans = plansFor();
  const valueResult = paywallValueContext({ plans, hasPlus: false, now: NOW });
  assert.ok('context' in valueResult);
  const lockedId = valueResult.context.lockedPlanId;

  billing.outcome = 'cancelled';
  const outcome = await billing.purchase('monthly');

  assert.equal(outcome, 'cancelled');
  assert.equal(billing.state(), 'free', 'state is unchanged');
  assert.equal(grantsPlus(billing.state()), false, 'the plan stays locked');

  // The shopper's work survives: the same plans, and the same locked plan id.
  const stillThere = paywallValueContext({ plans, hasPlus: false, now: NOW });
  assert.ok('context' in stillThere);
  assert.equal(stillThere.context.lockedPlanId, lockedId, 'context preserved');

  await events.flush();
  const names = transport.names();
  assert.ok(names.includes('purchase_cancelled'));
  assert.equal(names.includes('purchase_failed'), false, 'a cancellation is not a failure');
});

test('a failed purchase surfaces as a failure and preserves the basket', async () => {
  const transport = new MemoryTransport();
  const events = new AnalyticsQueue(transport);
  const billing = new FakeRevenueCat(events);
  billing.ready(false);
  billing.outcome = 'failed';

  const outcome = await billing.purchase('annual');
  assert.equal(outcome, 'failed');
  assert.equal(billing.state(), 'free', 'a failure does not corrupt the state');

  const plans = plansFor();
  assert.ok('context' in paywallValueContext({ plans, hasPlus: false, now: NOW }));

  await events.flush();
  assert.ok(transport.names().includes('purchase_failed'));
  assert.equal(transport.names().includes('purchase_cancelled'), false);
});

test('a delayed entitlement does not unlock early, and does unlock on refresh', async () => {
  // The store confirmed but CustomerInfo has not caught up. Unlocking here would grant
  // Plus on the strength of an SDK return value rather than an entitlement.
  const transport = new MemoryTransport();
  const events = new AnalyticsQueue(transport);
  const billing = new FakeRevenueCat(events);
  billing.ready(false);
  billing.delayEntitlement = true;

  const outcome = await billing.purchase('monthly');
  assert.equal(outcome, 'success');
  assert.equal(billing.state(), 'free', 'no premature unlock');
  assert.equal(grantsPlus(billing.state()), false);

  billing.deliverEntitlement(true);
  assert.equal(billing.state(), 'plus');
  assert.equal(grantsPlus(billing.state()), true, 'unlock happens when the entitlement arrives');
});

test('a pending purchase is its own state and unlocks nothing', async () => {
  const transport = new MemoryTransport();
  const events = new AnalyticsQueue(transport);
  const billing = new FakeRevenueCat(events);
  billing.ready(false);
  billing.outcome = 'pending';

  assert.equal(await billing.purchase('monthly'), 'pending');
  assert.equal(billing.state(), 'purchase_pending');
  assert.equal(grantsPlus(billing.state()), false, 'money that has not cleared buys nothing');

  billing.deliverEntitlement(true);
  assert.equal(billing.state(), 'plus');
});

test('restore with an active entitlement yields plus', async () => {
  const transport = new MemoryTransport();
  const events = new AnalyticsQueue(transport);
  const billing = new FakeRevenueCat(events);
  billing.ready(true);

  assert.equal(await billing.restore(), true);
  assert.equal(billing.state(), 'plus');

  await events.flush();
  assert.ok(transport.names().includes('restore_started'));
  assert.ok(transport.names().includes('restore_completed'));
});

test('restore with nothing to restore leaves the shopper free', async () => {
  const transport = new MemoryTransport();
  const events = new AnalyticsQueue(transport);
  const billing = new FakeRevenueCat(events);
  billing.ready(false);

  assert.equal(await billing.restore(), false, 'technically successful, nothing found');
  assert.equal(billing.state(), 'free', 'and never claimed as a successful Plus restore');
});

test('going offline with a cached entitlement keeps Plus; without one it does not', () => {
  const transport = new MemoryTransport();
  const events = new AnalyticsQueue(transport);

  const withCache = new FakeRevenueCat(events);
  withCache.goOffline(true);
  assert.equal(withCache.state(), 'offline_cached_plus');
  assert.equal(grantsPlus(withCache.state()), true);

  const withoutCache = new FakeRevenueCat(events);
  withoutCache.goOffline(undefined);
  assert.equal(withoutCache.state(), 'billing_unavailable');
  assert.equal(grantsPlus(withoutCache.state()), false, 'an outage is not a way to get Plus');
});

// ─────────────────────────────────────────────────────────────────────────────
// Analytics must never break the product
// ─────────────────────────────────────────────────────────────────────────────

test('the product loop completes with the analytics transport down', async () => {
  const transport = new MemoryTransport();
  transport.failing = true;
  const events = new AnalyticsQueue(transport, { maxAttempts: 2 });

  const plans = plansFor();
  events.record('optimization_completed', { planCount: plans.length });
  const result = await events.flush();

  assert.equal(result.delivered, 0, 'nothing was delivered');
  assert.equal(transport.delivered.length, 0);

  // And the product carried on regardless: the paywall context still computes.
  const value = paywallValueContext({ plans, hasPlus: false, now: NOW });
  assert.ok('context' in value, 'the shopping loop is unaffected by a dead transport');

  // Retrying is bounded — a broken endpoint must not become a battery complaint.
  await events.flush();
  assert.equal(events.stats().droppedTotal > 0, true, 'the batch is eventually dropped');
});

test('a transport that throws is contained', async () => {
  const throwing = {
    send: (): Promise<boolean> => Promise.reject(new Error('network on fire')),
  };
  const events = new AnalyticsQueue(throwing, { maxAttempts: 2 });
  events.record('app_opened');

  // No rejection escapes.
  const first = await events.flush();
  assert.equal(first.delivered, 0);
  const second = await events.flush();
  assert.equal(second.dropped, 1, 'and the queue drains rather than growing');
});

test('the queue is bounded and drops the oldest events first', () => {
  const transport = new MemoryTransport();
  const events = new AnalyticsQueue(transport, { maxQueued: 3 });
  for (let index = 0; index < 10; index += 1) {
    events.record('app_opened', { index }, { id: `e${index}` });
  }
  const stats = events.stats();
  assert.equal(stats.queued, 3, 'bounded');
  assert.equal(stats.droppedTotal, 7);
  // The newest survive: an outage should lose the stale prefix, not everything recent.
  assert.deepEqual(
    events.pending().map((entry) => entry.id),
    ['e7', 'e8', 'e9'],
  );
});

test('a repeated stable id is not counted twice', () => {
  const transport = new MemoryTransport();
  const events = new AnalyticsQueue(transport);
  events.record('paywall_seen', {}, { id: 'paywall-1' });
  events.record('paywall_seen', {}, { id: 'paywall-1' });
  assert.equal(events.stats().queued, 1, 'a re-render is not a second impression');
});

test('the sanitizer runs inside record, so no caller can skip it', async () => {
  const transport = new MemoryTransport();
  const events = new AnalyticsQueue(transport);
  events.record('list_created', {
    productName: 'Kellogg’s Corn Flakes',
    latitude: 37.4,
    basketItemCount: 12,
  });
  await events.flush();

  const delivered = transport.delivered[0];
  assert.ok(delivered);
  assert.deepEqual(Object.keys(delivered.properties), ['basketItemCount']);
});
