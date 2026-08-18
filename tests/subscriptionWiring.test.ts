import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  canOfferPurchase,
  grantsPlus,
  subscriptionState,
  type SubscriptionInputs,
} from '../src/domain/subscription';

/**
 * Structural guard: one subscription truth source.
 *
 * The failure this prevents is not hypothetical. Before the canonical state existed, six
 * screens each combined `hasPlus`, `status` and `error` in slightly different ways, which
 * is how one surface shows a paywall while another shows Plus features — and how a
 * billing outage gets rendered as "you are on the free plan" on exactly one screen.
 *
 * A type cannot express "do not compute this here", so this is a grep. It reads the real
 * screen sources and fails if any of them reaches past the canonical state to RevenueCat's
 * own data.
 */

const UI_ROOTS = ['src/app', 'src/components'];

/** Every `.tsx` under the UI roots, which is where the rule applies. */
function uiSources(): { file: string; source: string }[] {
  const out: { file: string; source: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith('.tsx')) continue;
      out.push({ file: full, source: readFileSync(full, 'utf8') });
    }
  };
  for (const root of UI_ROOTS) walk(path.join(process.cwd(), root));
  return out;
}

test('no screen reads RevenueCat CustomerInfo to decide entitlement', () => {
  // `customerInfo.entitlements` is the raw source. Only the provider may read it; a
  // screen that does is deciding entitlement for itself.
  const offenders = uiSources().filter(({ file, source }) => {
    if (file.endsWith('RevenueCatProvider.tsx')) return false;
    return /customerInfo\s*[.?]/.test(source) || /entitlements\s*\.\s*active/.test(source);
  });
  assert.deepEqual(
    offenders.map((entry) => path.relative(process.cwd(), entry.file)),
    [],
    'screens must consume `subscription`, not RevenueCat data',
  );
});

test('no screen names the juva_plus entitlement directly', () => {
  const offenders = uiSources().filter(({ source }) => source.includes('juva_plus'));
  assert.deepEqual(
    offenders.map((entry) => path.relative(process.cwd(), entry.file)),
    [],
    'the entitlement identifier belongs to the provider and the domain',
  );
});

test('no screen keeps its own subscription boolean in state', () => {
  // `useState<boolean>` named for Plus is the shape of a second truth source.
  const offenders = uiSources().filter(({ source }) =>
    /useState[^\n]*\b(hasPlus|isPlus|isPremium|isSubscribed|plusActive)\b/i.test(source),
  );
  assert.deepEqual(
    offenders.map((entry) => path.relative(process.cwd(), entry.file)),
    [],
    'premium state is derived, never stored per screen',
  );
});

test('the provider derives hasPlus rather than storing it', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/state/RevenueCatProvider.tsx'), 'utf8');
  assert.ok(
    source.includes('hasPlus: grantsPlus(state)'),
    'hasPlus must be computed from the canonical state',
  );
  assert.ok(!/useState[^\n]*hasPlus/i.test(source), 'and never held in its own piece of state');
  assert.ok(source.includes('subscriptionState('), 'the canonical deriver is the entry point');
});

test('every premium gate in the app routes through grantsPlus', () => {
  // The screens that gate a feature must ask the domain, not compare strings.
  const gated = ['src/app/plan.tsx', 'src/app/paywall.tsx', 'src/app/profile.tsx'];
  for (const file of gated) {
    const source = readFileSync(path.join(process.cwd(), file), 'utf8');
    assert.ok(source.includes('grantsPlus('), `${file} must gate through grantsPlus`);
  }
});

// ── The transitions the wiring has to produce ───────────────────────────────

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

test('CustomerInfo with juva_plus active yields plus, and unlocks', () => {
  const state = subscriptionState(inputs({ liveEntitlementActive: true }));
  assert.equal(state, 'plus');
  assert.equal(grantsPlus(state), true);
  assert.equal(canOfferPurchase(state), false, 'never sell to an existing subscriber');
});

test('CustomerInfo without the entitlement yields free, and may be sold to', () => {
  const state = subscriptionState(inputs({ liveEntitlementActive: false }));
  assert.equal(state, 'free');
  assert.equal(grantsPlus(state), false);
  assert.equal(canOfferPurchase(state), true);
});

test('initializing yields unknown and gates nothing either way', () => {
  const state = subscriptionState(inputs({ loading: true }));
  assert.equal(state, 'unknown');
  assert.equal(grantsPlus(state), false);
  assert.equal(canOfferPurchase(state), false);
});

test('a purchase in progress yields purchase_pending without unlocking', () => {
  const state = subscriptionState(inputs({ purchasePending: true }));
  assert.equal(state, 'purchase_pending');
  assert.equal(grantsPlus(state), false, 'money that has not cleared buys nothing yet');
});

test('billing unavailable is its own state and grants nothing', () => {
  const state = subscriptionState(inputs({ failed: true }));
  assert.equal(state, 'billing_unavailable');
  assert.notEqual(state, 'free');
  assert.equal(grantsPlus(state), false);
});

test('a legitimate cached entitlement yields offline_cached_plus and unlocks', () => {
  const state = subscriptionState(inputs({ failed: true, cachedEntitlementActive: true }));
  assert.equal(state, 'offline_cached_plus');
  assert.equal(grantsPlus(state), true, 'a paying shopper keeps Plus on a train');
});

test('a refresh that removes the entitlement removes premium access', () => {
  // The sequence that matters when a subscription lapses: the cache said yes, the live
  // answer now says no, and the live answer wins.
  const before = subscriptionState(inputs({ cachedEntitlementActive: true, failed: true }));
  assert.equal(grantsPlus(before), true);

  const after = subscriptionState(
    inputs({ cachedEntitlementActive: true, liveEntitlementActive: false }),
  );
  assert.equal(after, 'free');
  assert.equal(grantsPlus(after), false, 'premium disappears as soon as the truth arrives');
});
