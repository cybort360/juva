import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareIdentity, normalizeGtin, normalizeSku, resolveGtin } from '../src/domain/identity';
import { matchProduct, tierRank } from '../src/domain/matching';
import type { GroceryListItem, ProductIdentifiers, RetailerProduct } from '../src/domain/types';

/**
 * Trade identity: barcodes, UPCs, GTINs and retailer SKUs.
 *
 * The reason this is worth its own suite is that a barcode is the only signal strong
 * enough to overrule the text, which makes a *wrong* barcode the most dangerous input
 * Juva can receive. So these tests are as concerned with what is rejected as with
 * what matches.
 */

// Real, check-digit-valid codes. `019068100237` is a UPC-A; its EAN-13 form is the
// same digits with a leading zero, which is the case that motivates GTIN-14 folding.
const UPC = '019068100232';
const UPC_AS_EAN13 = '0019068100232';
const OTHER_UPC = '012000161155';

const CONTEXT = { currency: 'USD', defaultBrandPolicy: 'flexible' as const };

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
  identifiers?: ProductIdentifiers;
  concept?: string;
  title?: string;
  brand?: string;
  retailerId?: string;
  price?: number;
  id?: string;
}): RetailerProduct {
  return {
    id: overrides.id ?? 'p1',
    canonicalConcept: overrides.concept ?? 'milk',
    storeId: 's1',
    title: overrides.title ?? 'Whole Milk',
    brand: overrides.brand ?? 'Grove',
    sizeLabel: '1 gal',
    ...(overrides.identifiers === undefined ? {} : { identifiers: overrides.identifiers }),
    observation: {
      id: 'o1',
      storeId: 's1',
      retailerId: overrides.retailerId ?? 'grove',
      retailerProductId: overrides.id ?? 'p1',
      scope: 'store',
      priceCents: overrides.price ?? 399,
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

// ── Normalization ───────────────────────────────────────────────────────────

test('a valid UPC normalizes to a zero-padded GTIN-14', () => {
  assert.equal(normalizeGtin(UPC), `00${UPC}`);
  assert.equal(normalizeGtin(UPC)?.length, 14);
});

test('the same article as UPC-12 and EAN-13 normalizes to one identifier', () => {
  // This is the whole reason for canonicalizing rather than string-comparing: these
  // are the same tin, printed under two standards.
  assert.equal(normalizeGtin(UPC), normalizeGtin(UPC_AS_EAN13));
});

test('formatting is stripped before validation', () => {
  assert.equal(normalizeGtin('0 19068 10023 2'), normalizeGtin(UPC));
  assert.equal(normalizeGtin('019068-100232'), normalizeGtin(UPC));
  // A spreadsheet export writes a leading apostrophe to stop Excel eating the code.
  assert.equal(normalizeGtin("'019068100232"), normalizeGtin(UPC));
});

test('a malformed barcode is discarded, never repaired', () => {
  assert.equal(normalizeGtin(''), undefined);
  assert.equal(normalizeGtin('not-a-barcode'), undefined);
  assert.equal(normalizeGtin('12345'), undefined, 'wrong length');
  assert.equal(normalizeGtin('0190681002321234567'), undefined, 'too long');
  assert.equal(normalizeGtin('019068 1002X'), undefined, 'non-numeric');
  assert.equal(normalizeGtin(undefined), undefined);
});

test('a bad check digit is rejected', () => {
  // Same digits, last one wrong. A mistyped barcode that still matched something
  // would price the wrong product with maximum confidence — worse than no barcode.
  assert.equal(normalizeGtin('019068100236'), undefined);
  assert.ok(normalizeGtin('019068100232'), 'the correct check digit still passes');
});

test('an all-zero placeholder is not an identifier', () => {
  // Several feeds emit this for "unknown". Accepting it would match every such
  // product to every other one.
  assert.equal(normalizeGtin('00000000000000'), undefined);
  assert.equal(normalizeGtin('000000000000'), undefined);
});

test('the gtin field is preferred, then upc, then barcode', () => {
  assert.equal(resolveGtin({ gtin: UPC_AS_EAN13, upc: UPC, barcode: UPC }), normalizeGtin(UPC));
  assert.equal(resolveGtin({ upc: UPC }), normalizeGtin(UPC));
  assert.equal(resolveGtin({ barcode: UPC }), normalizeGtin(UPC));
  assert.equal(resolveGtin({}), undefined);
  assert.equal(resolveGtin(undefined), undefined);
});

test('self-contradictory identifiers resolve to nothing', () => {
  // Two populated fields naming different articles is a broken record. Picking one
  // is the same class of mistake as accepting a bad check digit.
  assert.equal(resolveGtin({ gtin: UPC, upc: OTHER_UPC }), undefined);
});

test('a malformed field is ignored rather than poisoning a good one', () => {
  assert.equal(resolveGtin({ gtin: 'garbage', upc: UPC }), normalizeGtin(UPC));
});

test('a SKU is compared case- and space-insensitively, but punctuation is kept', () => {
  assert.equal(normalizeSku(' AB-1234 '), 'ab-1234');
  assert.equal(normalizeSku('ab 1234'), 'ab1234');
  // Hyphens are *not* stripped. "AB-1" and "A-B1" are plausibly different articles,
  // and conflating two real SKUs is the failure this module exists to avoid.
  assert.notEqual(normalizeSku('AB-1'), normalizeSku('ab1'));
  assert.equal(normalizeSku('   '), undefined);
  assert.equal(normalizeSku(undefined), undefined);
});

// ── compareIdentity ─────────────────────────────────────────────────────────

test('two sides with the same GTIN are the same article', () => {
  assert.equal(compareIdentity({ gtin: UPC }, { gtin: UPC_AS_EAN13 }, false), 'gtin_match');
});

test('two sides with different GTINs are a mismatch', () => {
  assert.equal(compareIdentity({ gtin: UPC }, { gtin: OTHER_UPC }, false), 'gtin_mismatch');
});

test('a missing barcode on either side means no identifiers, not a mismatch', () => {
  assert.equal(compareIdentity({ gtin: UPC }, {}, false), 'no_identifiers');
  assert.equal(compareIdentity({}, { gtin: UPC }, false), 'no_identifiers');
  assert.equal(compareIdentity(undefined, undefined, false), 'no_identifiers');
});

test('a SKU matches only within the same retailer', () => {
  const same = compareIdentity({ retailerSku: ' AB-1 ' }, { retailerSku: 'ab-1' }, true);
  assert.equal(same, 'sku_match');
  const cross = compareIdentity({ retailerSku: ' AB-1 ' }, { retailerSku: 'ab-1' }, false);
  assert.equal(cross, 'no_identifiers', 'article numbers are not portable between chains');
});

test('unequal SKUs are not treated as negative evidence', () => {
  // One retailer lists the same article under several SKUs, so this says nothing.
  assert.equal(
    compareIdentity({ retailerSku: 'AB-1' }, { retailerSku: 'ZZ-9' }, true),
    'no_identifiers',
  );
});

// ── matchProduct: identity in the hierarchy ─────────────────────────────────

test('an exact barcode match is the strongest tier', () => {
  const result = matchProduct(
    item({ requestedIdentifiers: { upc: UPC } }),
    product({ identifiers: { gtin: UPC_AS_EAN13 } }),
    CONTEXT,
  );
  assert.equal(result.matched, true);
  assert.equal(result.tier, 'gtin');
  assert.equal(tierRank('gtin'), 0);
});

test('the same product name with a different barcode is rejected', () => {
  // Identical titles, provably different articles. The text agreeing is exactly the
  // trap a barcode exists to catch.
  const result = matchProduct(
    item({ requestedIdentifiers: { upc: UPC } }),
    product({ identifiers: { upc: OTHER_UPC }, title: 'Whole Milk' }),
    CONTEXT,
  );
  assert.equal(result.matched, false);
  assert.equal(result.rejection, 'barcode_mismatch');
});

test('a barcode match beats text similarity, even across differing titles', () => {
  // The candidate's own words say "Lait Entier 3.78L" and its concept is recorded as
  // something else entirely. Fuzzy text would score this near zero; the barcode is
  // still decisive, and the tier records that identity — not the words — settled it.
  const result = matchProduct(
    item({ requestedIdentifiers: { upc: UPC }, concept: 'milk' }),
    product({
      identifiers: { upc: UPC },
      concept: 'unrelated-concept-token',
      title: 'Lait Entier 3.78L',
    }),
    CONTEXT,
  );
  assert.equal(result.matched, true);
  assert.equal(result.tier, 'gtin');
});

test('a barcode mismatch beats text similarity in the other direction too', () => {
  const result = matchProduct(
    item({ requestedIdentifiers: { upc: UPC }, concept: 'milk' }),
    product({ identifiers: { upc: OTHER_UPC }, concept: 'milk', title: 'Whole Milk 1 gal' }),
    CONTEXT,
  );
  assert.equal(result.matched, false, 'strong negative evidence outranks a perfect text match');
});

test('a missing barcode on one side falls through to text matching', () => {
  // Most sources publish no identifier at all, so this must never be a rejection.
  const result = matchProduct(
    item({ requestedIdentifiers: { upc: UPC } }),
    product({ identifiers: {} }),
    CONTEXT,
  );
  assert.equal(result.matched, true);
  assert.equal(result.tier, 'token', 'matched on the concept, and says so');
});

test('a malformed barcode is treated as absent, not as a mismatch', () => {
  const result = matchProduct(
    item({ requestedIdentifiers: { upc: UPC } }),
    product({ identifiers: { upc: '019068100236' } }),
    CONTEXT,
  );
  assert.equal(result.matched, true, 'an unusable code cannot be evidence either way');
  assert.equal(result.tier, 'token');
});

test('duplicate listings sharing one barcode both match, and price decides', () => {
  // A retailer listing the same article twice is routine (two depots, a re-list).
  // Both are the product; the cheaper is the one to buy.
  const requested = item({ requestedIdentifiers: { upc: UPC } });
  const first = product({ id: 'dup-a', identifiers: { upc: UPC }, price: 399 });
  const second = product({ id: 'dup-b', identifiers: { upc: UPC_AS_EAN13 }, price: 349 });

  const a = matchProduct(requested, first, CONTEXT);
  const b = matchProduct(requested, second, CONTEXT);
  assert.equal(a.tier, 'gtin');
  assert.equal(b.tier, 'gtin');
  assert.ok(
    second.observation.priceCents < first.observation.priceCents,
    'nothing about identity dedupes them; the optimizer picks on price',
  );
});

test('a retailer SKU match is used when scoped to that retailer', () => {
  const result = matchProduct(
    item({ requestedIdentifiers: { retailerSku: 'AB-1' } }),
    product({ identifiers: { retailerSku: 'ab-1' }, retailerId: 'grove' }),
    { ...CONTEXT, requestedRetailerId: 'grove' },
  );
  assert.equal(result.matched, true);
  assert.equal(result.tier, 'retailer_sku');
});

test('a SKU from another retailer is not used as identity', () => {
  const result = matchProduct(
    item({ requestedIdentifiers: { retailerSku: 'AB-1' } }),
    product({ identifiers: { retailerSku: 'ab-1' }, retailerId: 'north' }),
    { ...CONTEXT, requestedRetailerId: 'grove' },
  );
  assert.equal(result.matched, true);
  assert.notEqual(result.tier, 'retailer_sku', 'fell through to text, as it must');
});

test('a SKU is not used as identity when the caller does not say which retailer', () => {
  // Leaving `requestedRetailerId` unset is the safe default and must not be read as
  // "any retailer".
  const result = matchProduct(
    item({ requestedIdentifiers: { retailerSku: 'AB-1' } }),
    product({ identifiers: { retailerSku: 'ab-1' } }),
    CONTEXT,
  );
  assert.notEqual(result.tier, 'retailer_sku');
});

test('GTIN outranks SKU when both would match', () => {
  const result = matchProduct(
    item({ requestedIdentifiers: { upc: UPC, retailerSku: 'AB-1' } }),
    product({ identifiers: { upc: UPC, retailerSku: 'ab-1' }, retailerId: 'grove' }),
    { ...CONTEXT, requestedRetailerId: 'grove' },
  );
  assert.equal(result.tier, 'gtin');
  assert.ok(tierRank('gtin') < tierRank('retailer_sku'));
});

test('an identifier match still cannot buy an unsellable row', () => {
  // Identity is not permission. A barcode match to a row priced in another currency,
  // or out of stock, is still not something Juva can plan on.
  const wrongCurrency = product({ identifiers: { upc: UPC } });
  const euro: RetailerProduct = {
    ...wrongCurrency,
    observation: { ...wrongCurrency.observation, currency: 'EUR' },
  };
  assert.equal(
    matchProduct(item({ requestedIdentifiers: { upc: UPC } }), euro, CONTEXT).rejection,
    'currency_mismatch',
  );

  const gone: RetailerProduct = {
    ...wrongCurrency,
    observation: { ...wrongCurrency.observation, available: false },
  };
  assert.equal(
    matchProduct(item({ requestedIdentifiers: { upc: UPC } }), gone, CONTEXT).rejection,
    'unavailable',
  );
});

test('a barcode match overrides a brand rule, because it is provably that product', () => {
  // The brand string disagreeing is a data-quality problem in the feed, not evidence
  // that this is a different article.
  const result = matchProduct(
    item({
      requestedIdentifiers: { upc: UPC },
      requestedBrand: 'Grove',
      brandPolicy: 'exact_product',
    }),
    product({ identifiers: { upc: UPC }, brand: 'GROVE FARMS LLC' }),
    CONTEXT,
  );
  assert.equal(result.matched, true);
  assert.equal(result.tier, 'gtin');
  assert.equal(result.substitution, false);
});
