import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BRAND_POLICY_OPTIONS,
  brandPolicyChip,
  brandPolicyTitle,
  nextBrandPolicy,
} from '../src/domain/brandPolicyCopy';
import { demoPreferences } from '../src/domain/demoMarket';
import { isBrandPolicyValue, matchProduct, migrateBrandPolicy } from '../src/domain/matching';
import { migrateState, needsMigration } from '../src/domain/stateMigration';
import type {
  BrandPolicy,
  GroceryList,
  GroceryListItem,
  JuvaState,
  RetailerProduct,
} from '../src/domain/types';

/**
 * The four brand-policy states.
 *
 * The split that matters is `exact_product` from `exact_brand`. Before it, "exact"
 * had to mean one or the other, and it meant "exact brand" — so a shopper who typed
 * "Kellogg's Corn Flakes" could be handed Kellogg's Frosties and Juva would call it
 * an exact match. These tests pin down the distinction and the migration that gets
 * existing devices onto it.
 */

const CONTEXT = { currency: 'USD', defaultBrandPolicy: 'flexible' as const };

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
  brand?: string;
  title?: string;
  concept?: string;
  size?: string;
  price?: number;
}): RetailerProduct {
  return {
    id: 'p1',
    canonicalConcept: overrides.concept ?? 'cereal',
    storeId: 's1',
    title: overrides.title ?? 'Corn Flakes',
    brand: overrides.brand ?? "Kellogg's",
    sizeLabel: overrides.size ?? '18 oz',
    observation: {
      id: 'o1',
      storeId: 's1',
      retailerId: 'grove',
      retailerProductId: 'p1',
      scope: 'store',
      priceCents: overrides.price ?? 499,
      currency: 'USD',
      source: 'demo',
      observedAt: '2026-08-11T00:00:00.000Z',
      freshness: 'demo',
      confidence: 0.9,
      available: true,
      availability: 'in_stock',
    },
  };
}

// ── exact_product ───────────────────────────────────────────────────────────

test('exact_product rejects another product from the same brand', () => {
  // The case the old three-value model could not express. Same brand, same aisle,
  // different product.
  const result = matchProduct(
    item({
      requestedBrand: "Kellogg's",
      requestedVariant: 'corn flakes',
      brandPolicy: 'exact_product',
    }),
    product({ brand: "Kellogg's", title: 'Frosties' }),
    CONTEXT,
  );
  assert.equal(result.matched, false);
  assert.equal(result.rejection, 'variant_required');
});

test('exact_product accepts the named product', () => {
  const result = matchProduct(
    item({
      requestedBrand: "Kellogg's",
      requestedVariant: 'corn flakes',
      brandPolicy: 'exact_product',
    }),
    product({ brand: "Kellogg's", title: "Kellogg's Corn Flakes 18 oz" }),
    CONTEXT,
  );
  assert.equal(result.matched, true);
  assert.equal(result.tier, 'product_identity');
  assert.equal(result.substitution, false);
});

test('exact_product rejects another brand outright', () => {
  const result = matchProduct(
    item({ requestedBrand: "Kellogg's", brandPolicy: 'exact_product' }),
    product({ brand: 'Value Foods' }),
    CONTEXT,
  );
  assert.equal(result.matched, false);
  assert.equal(result.rejection, 'brand_required');
});

test('exact_product still enforces the variant when no brand was named', () => {
  const result = matchProduct(
    item({ requestedVariant: 'unsalted', brandPolicy: 'exact_product' }),
    product({ title: 'Salted Butter', concept: 'cereal' }),
    CONTEXT,
  );
  assert.equal(result.matched, false);
  assert.equal(result.rejection, 'variant_required');
});

// ── exact_brand ─────────────────────────────────────────────────────────────

test('exact_brand accepts a compatible variant from the same brand', () => {
  // The distinction from exact_product, stated as the same fixture with one field
  // changed: what was a rejection above is a match here.
  const result = matchProduct(
    item({
      requestedBrand: "Kellogg's",
      requestedVariant: 'corn flakes',
      brandPolicy: 'exact_brand',
    }),
    product({ brand: "Kellogg's", title: 'Frosties' }),
    CONTEXT,
  );
  assert.equal(result.matched, true);
  assert.equal(result.tier, 'brand_attributes');
  assert.equal(result.substitution, false, 'same brand is not a substitution');
});

test('exact_brand rejects another brand', () => {
  const result = matchProduct(
    item({ requestedBrand: "Kellogg's", brandPolicy: 'exact_brand' }),
    product({ brand: 'Value Foods' }),
    CONTEXT,
  );
  assert.equal(result.matched, false);
  assert.equal(result.rejection, 'brand_required');
});

test('exact_brand tolerates a brand written differently', () => {
  // "Kelloggs" and "Kellogg's" are the same brand, and a policy this strict would be
  // unusable if punctuation broke it.
  const result = matchProduct(
    item({ requestedBrand: 'Kelloggs', brandPolicy: 'exact_brand' }),
    product({ brand: "Kellogg's" }),
    CONTEXT,
  );
  assert.equal(result.matched, true);
});

test('exact_brand does not accept a brand that merely shares letters', () => {
  const result = matchProduct(
    item({ requestedBrand: 'Grove', brandPolicy: 'exact_brand' }),
    product({ brand: 'Grovewood' }),
    CONTEXT,
  );
  assert.equal(result.matched, false);
  assert.equal(result.rejection, 'brand_required');
});

// ── flexible ────────────────────────────────────────────────────────────────

test('flexible allows an equivalent product from another brand', () => {
  const result = matchProduct(
    item({ requestedBrand: "Kellogg's", brandPolicy: 'flexible' }),
    product({ brand: 'Value Foods' }),
    CONTEXT,
  );
  assert.equal(result.matched, true);
  assert.equal(result.substitution, true, 'and reports it as a substitution');
});

test('flexible marks a differing variant as needing confirmation', () => {
  // A different brand *and* a different variant is two steps from the request. Juva
  // will price it, but it is not something to buy on Juva's word alone.
  const result = matchProduct(
    item({ requestedBrand: "Kellogg's", requestedVariant: 'corn flakes', brandPolicy: 'flexible' }),
    product({ brand: 'Value Foods', title: 'Bran Squares' }),
    CONTEXT,
  );
  assert.equal(result.matched, true);
  assert.equal(result.needsConfirmation, true);
  assert.equal(result.tier, 'manual_confirmation');
});

// ── cheapest ────────────────────────────────────────────────────────────────

test('cheapest still respects the product concept', () => {
  // "Cheapest acceptable equivalent" — a tin of beans is not a cheap cereal.
  const result = matchProduct(
    item({ concept: 'cereal', brandPolicy: 'cheapest' }),
    product({ concept: 'baked beans', price: 89 }),
    CONTEXT,
  );
  assert.equal(result.matched, false);
  assert.equal(result.rejection, 'concept_mismatch');
});

test('cheapest still respects currency and availability', () => {
  const base = product({ price: 99 });
  const euro: RetailerProduct = {
    ...base,
    observation: { ...base.observation, currency: 'EUR' },
  };
  assert.equal(
    matchProduct(item({ brandPolicy: 'cheapest' }), euro, CONTEXT).rejection,
    'currency_mismatch',
  );

  const gone: RetailerProduct = { ...base, observation: { ...base.observation, available: false } };
  assert.equal(
    matchProduct(item({ brandPolicy: 'cheapest' }), gone, CONTEXT).rejection,
    'unavailable',
  );
});

test('cheapest takes another brand without flagging it as a preference miss', () => {
  const result = matchProduct(
    item({ requestedBrand: "Kellogg's", brandPolicy: 'cheapest' }),
    product({ brand: 'Value Foods', price: 199 }),
    CONTEXT,
  );
  assert.equal(result.matched, true);
  assert.equal(result.substitution, true);
  assert.equal(result.tier, 'token', 'cheapest is indifferent, so no fuzzy demotion');
});

// ── The line policy overrides the default ───────────────────────────────────

test('a per-item policy overrides the shopper default in both directions', () => {
  const strictLine = item({ requestedBrand: "Kellogg's", brandPolicy: 'exact_brand' });
  assert.equal(
    matchProduct(strictLine, product({ brand: 'Value Foods' }), {
      ...CONTEXT,
      defaultBrandPolicy: 'cheapest',
    }).matched,
    false,
    'a strict line is not loosened by a loose default',
  );

  const looseLine = item({ requestedBrand: "Kellogg's", brandPolicy: 'cheapest' });
  assert.equal(
    matchProduct(looseLine, product({ brand: 'Value Foods' }), {
      ...CONTEXT,
      defaultBrandPolicy: 'exact_product',
    }).matched,
    true,
    'nor is a loose line tightened by a strict default',
  );
});

// ── Migration of persisted values ───────────────────────────────────────────

test('the legacy exact value becomes exact_product, the stricter reading', () => {
  // Old "exact" promised "never substitute a named brand". Of the two new states,
  // only exact_product cannot surprise someone who chose it.
  assert.equal(migrateBrandPolicy('exact'), 'exact_product');
});

test('the other legacy values are unchanged', () => {
  assert.equal(migrateBrandPolicy('flexible'), 'flexible');
  assert.equal(migrateBrandPolicy('cheapest'), 'cheapest');
});

test('the new values survive migration unchanged', () => {
  for (const option of BRAND_POLICY_OPTIONS) {
    assert.equal(migrateBrandPolicy(option.value), option.value);
  }
});

test('an unrecognised or absent value falls back to flexible', () => {
  assert.equal(migrateBrandPolicy(undefined), 'flexible');
  assert.equal(isBrandPolicyValue('exact'), true);
  assert.equal(isBrandPolicyValue('exact_product'), true);
  assert.equal(isBrandPolicyValue('nonsense'), false);
  assert.equal(isBrandPolicyValue(undefined), false);
});

function stateWith(overrides: Partial<JuvaState> = {}): JuvaState {
  return {
    preferences: { ...demoPreferences, onboarded: true },
    draftPrompt: '',
    plans: [],
    receipts: [],
    savingsRecords: [],
    savedLists: [],
    journeyHistory: [],
    ...overrides,
  };
}

function listWith(policy: BrandPolicy | 'exact'): GroceryList {
  return {
    id: 'l1',
    title: 'Saved',
    prompt: 'saved',
    currency: 'USD',
    createdAt: '2026-08-01T00:00:00.000Z',
    items: [{ ...item(), brandPolicy: policy as BrandPolicy }],
  };
}

test('a persisted legacy preference is migrated rather than discarded', () => {
  const stale = stateWith({
    preferences: { ...demoPreferences, brandPolicy: 'exact' as unknown as BrandPolicy },
  });
  assert.equal(needsMigration(stale), true);
  assert.equal(migrateState(stale).preferences.brandPolicy, 'exact_product');
});

test('legacy policies inside saved and active lists are migrated too', () => {
  // A migration that only touched preferences would leave every saved list quietly
  // planning under a value no branch handles.
  const stale = stateWith({
    savedLists: [listWith('exact')],
    activeList: listWith('exact'),
  });
  assert.equal(needsMigration(stale), true);
  const migrated = migrateState(stale);
  assert.equal(migrated.savedLists[0]?.items[0]?.brandPolicy, 'exact_product');
  assert.equal(migrated.activeList?.items[0]?.brandPolicy, 'exact_product');
});

test('saved lists and verified savings are never dropped by the migration', () => {
  // The point of migrating rather than resetting: a shopper does not lose their
  // history to a schema change.
  const stale = stateWith({
    preferences: { ...demoPreferences, brandPolicy: 'exact' as unknown as BrandPolicy },
    savedLists: [listWith('exact'), listWith('flexible')],
    savingsRecords: [
      {
        id: 'sr1',
        tripId: 't1',
        createdAt: '2026-08-01T00:00:00.000Z',
        currency: 'USD',
        plannedCents: 4200,
        expectedTotalCents: 4200,
        actualCents: 4200,
        differenceCents: 0,
        baselineCents: 5000,
        estimatedSavingsCents: 800,
        verifiedSavingsCents: 800,
        storeSelectionSavingsCents: 800,
        promotionSavingsCents: 0,
        substitutionSavingsCents: 0,
        receiptConfirmed: true,
        confidence: 1,
        provenance: [],
        unmatchedLineCount: 0,
        missingItemCount: 0,
        lines: [],
      },
    ],
  });
  const migrated = migrateState(stale);
  assert.equal(migrated.savedLists.length, 2);
  assert.equal(migrated.savingsRecords.length, 1);
  assert.equal(migrated.savingsRecords[0]?.verifiedSavingsCents, 800);
});

test('a missing couponIds list reads as holding no coupons, never all of them', () => {
  const stale = stateWith({
    preferences: { ...demoPreferences, couponIds: undefined as unknown as string[] },
  });
  assert.equal(needsMigration(stale), true);
  assert.deepEqual(migrateState(stale).preferences.couponIds, []);
});

test('stored plans are dropped only when a migration actually happened', () => {
  // Plans are computed results optimized under the old rules; rewriting one would
  // produce a plan claiming rules it never saw. But a normal restart must keep them.
  const current = stateWith({ plans: [], draftPrompt: 'eggs' });
  assert.equal(needsMigration(current), false);
  assert.equal(migrateState(current), current, 'an ordinary launch is a no-op');

  const stale = stateWith({
    preferences: { ...demoPreferences, brandPolicy: 'exact' as unknown as BrandPolicy },
    selectedPlanId: 'plan-recommended-x',
  });
  const migrated = migrateState(stale);
  assert.deepEqual(migrated.plans, []);
  assert.equal(migrated.selectedPlanId, undefined);
});

// ── Copy ────────────────────────────────────────────────────────────────────

test('every policy has one title and one chip, shared by every screen', () => {
  const policies: BrandPolicy[] = ['exact_product', 'exact_brand', 'flexible', 'cheapest'];
  assert.equal(BRAND_POLICY_OPTIONS.length, 4);
  for (const policy of policies) {
    assert.ok(brandPolicyTitle(policy).length > 0);
    assert.ok(brandPolicyChip(policy).length > 0);
  }
  const titles = policies.map(brandPolicyTitle);
  assert.equal(new Set(titles).size, 4, 'two states must never share a label');
});

test('the per-item chip cycles through all four states and wraps', () => {
  assert.equal(nextBrandPolicy('exact_product'), 'exact_brand');
  assert.equal(nextBrandPolicy('exact_brand'), 'flexible');
  assert.equal(nextBrandPolicy('flexible'), 'cheapest');
  assert.equal(nextBrandPolicy('cheapest'), 'exact_product');

  // Reachability: tapping four times from anywhere returns to the start, so no state
  // is stranded.
  let policy: BrandPolicy = 'flexible';
  const seen = new Set<BrandPolicy>();
  for (let index = 0; index < 4; index += 1) {
    seen.add(policy);
    policy = nextBrandPolicy(policy);
  }
  assert.equal(seen.size, 4);
  assert.equal(policy, 'flexible');
});

test('the options are ordered strictest to loosest', () => {
  assert.deepEqual(
    BRAND_POLICY_OPTIONS.map((option) => option.value),
    ['exact_product', 'exact_brand', 'flexible', 'cheapest'],
  );
});
