import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  comparePackValue,
  displayUnitPriceCents,
  normalizeLabel,
  packsRequired,
  parseQuantity,
  unitPriceFor,
} from '../src/domain/quantity';

// ── Parsing ─────────────────────────────────────────────────────────────────

test('parses plain metric and imperial sizes', () => {
  assert.deepEqual(parseQuantity('500 g'), {
    value: 500,
    unit: 'g',
    dimension: 'mass',
    approximate: false,
    packCount: 1,
  });
  assert.equal(parseQuantity('1 gal')?.dimension, 'volume');
  assert.equal(parseQuantity('2 lb')?.dimension, 'mass');
  assert.equal(parseQuantity('1.5 l')?.value, 1.5);
});

test('treats a bare number and a descriptive noun as a count', () => {
  assert.equal(parseQuantity('6')?.dimension, 'count');
  assert.equal(parseQuantity('6')?.value, 6);
  assert.equal(parseQuantity('12 large')?.dimension, 'count');
  assert.equal(parseQuantity('12 large')?.value, 12);
  assert.equal(parseQuantity('1 loaf')?.dimension, 'count');
});

test('a dozen is twelve', () => {
  assert.equal(normalizeLabel('1 dozen')?.amount, 12);
  assert.equal(normalizeLabel('1 dozen')?.dimension, 'count');
});

test('flags approximate weights without losing the magnitude', () => {
  const parsed = parseQuantity('~2 lb');
  assert.equal(parsed?.approximate, true);
  assert.equal(parsed?.value, 2);
  assert.equal(parsed?.unit, 'lb');
});

test('multiplies out a multipack', () => {
  const parsed = parseQuantity('2 x 500 ml');
  assert.equal(parsed?.value, 1000);
  assert.equal(parsed?.dimension, 'volume');
  assert.equal(parsed?.packCount, 2);
  assert.equal(parseQuantity('6x330ml')?.value, 1980);
});

test('fluid ounces are volume, plain ounces are mass', () => {
  assert.equal(parseQuantity('12 fl oz')?.dimension, 'volume');
  assert.equal(parseQuantity('12 oz')?.dimension, 'mass');
});

test('takes the leading amount when a label repeats itself', () => {
  // Real Open Prices data uses "3.5 oz (100 g)".
  const parsed = parseQuantity('3.5 oz (100 g)');
  assert.equal(parsed?.value, 3.5);
  assert.equal(parsed?.unit, 'oz');
});

test('unreadable or zero labels parse to null rather than a guess', () => {
  assert.equal(parseQuantity(undefined), null);
  assert.equal(parseQuantity(''), null);
  assert.equal(parseQuantity('family size'), null);
  assert.equal(parseQuantity('0 g'), null);
});

test('normalization converts to base units exactly', () => {
  assert.equal(normalizeLabel('1 kg')?.amount, 1000);
  assert.equal(normalizeLabel('1 l')?.amount, 1000);
  assert.equal(normalizeLabel('2 lb')?.amount, 907.18474);
  assert.ok(Math.abs((normalizeLabel('1 gal')?.amount ?? 0) - 3785.411784) < 1e-6);
});

// ── Unit price ──────────────────────────────────────────────────────────────

test('unit price divides price by normalized amount', () => {
  const unit = unitPriceFor(250, '500 g');
  assert.ok(unit);
  assert.equal(unit.dimension, 'mass');
  assert.equal(unit.centsPerBaseUnit, 0.5);
  assert.equal(displayUnitPriceCents(unit), 500, '250c per 500g is 500c per kg');
});

test('unit price is omitted when the pack size cannot be read', () => {
  assert.equal(unitPriceFor(399, 'family size'), null);
  assert.equal(unitPriceFor(399, undefined), null);
});

test('unit price is not rounded internally, so comparisons stay exact', () => {
  const a = unitPriceFor(100, '3 ct');
  assert.ok(a);
  // 100/3 must not collapse to 33 before comparison.
  assert.ok(Math.abs(a.centsPerBaseUnit - 33.3333333) < 1e-5);
});

// ── Pack-size comparison ────────────────────────────────────────────────────

test('the larger pack can win on unit price', () => {
  const result = comparePackValue(
    { priceCents: 499, packLabel: '1 gal' },
    { priceCents: 279, packLabel: '64 fl oz' },
  );
  assert.ok(result);
  assert.equal(result.cheaper, 'a', 'a gallon at 4.99 beats a half gallon at 2.79');
  assert.ok(result.ratio > 1);
});

test('packs in different dimensions are not comparable', () => {
  assert.equal(
    comparePackValue(
      { priceCents: 399, packLabel: '20 oz' },
      { priceCents: 399, packLabel: '1 qt' },
    ),
    null,
    'mass against volume must be no information, not equal',
  );
});

test('identical value reports equal rather than an arbitrary winner', () => {
  const result = comparePackValue(
    { priceCents: 200, packLabel: '500 g' },
    { priceCents: 400, packLabel: '1 kg' },
  );
  assert.deepEqual(result, { cheaper: 'equal', ratio: 1 });
});

// ── Packs required ──────────────────────────────────────────────────────────

test('a request matching the pack size needs one pack', () => {
  const result = packsRequired({ quantity: 1, unit: '1 gal' }, '1 gal', false);
  assert.equal(result.packs, 1);
  assert.equal(result.basis, 'pack_multiple');
  assert.equal(result.roundedUp, false);
});

test('discrete packs round up, because half a carton cannot be bought', () => {
  const result = packsRequired({ quantity: 1, unit: '1 gal' }, '64 fl oz', false);
  assert.equal(result.packs, 2, 'a gallon needs two half-gallons');
  assert.equal(result.roundedUp, false, 'two halves are exactly a gallon');

  const partial = packsRequired({ quantity: 1, unit: '500 g' }, '300 g', false);
  assert.equal(partial.packs, 2);
  assert.equal(partial.roundedUp, true, 'the shopper ends up with 600g');
  assert.equal(partial.acquiredBaseAmount, 600);
});

test('a larger pack than requested still needs one pack', () => {
  const result = packsRequired({ quantity: 1, unit: '500 g' }, '1 kg', false);
  assert.equal(result.packs, 1);
  assert.equal(result.roundedUp, true);
});

test('requested quantity multiplies the requested size', () => {
  const result = packsRequired({ quantity: 3, unit: '1 l' }, '500 ml', false);
  assert.equal(result.packs, 6, 'three litres from half-litre bottles');
});

test('goods sold by weight use a fractional multiplier', () => {
  const result = packsRequired({ quantity: 1, unit: '2 lb' }, '1 lb', true);
  assert.equal(result.packs, 2);
  assert.equal(result.basis, 'weighed');
  assert.equal(result.roundedUp, false);

  const partial = packsRequired({ quantity: 1, unit: '1.5 lb' }, '1 lb', true);
  assert.equal(partial.packs, 1.5, 'weighed goods are not rounded up to whole units');
});

test('incomparable units fall back to the requested pack count', () => {
  const result = packsRequired({ quantity: 2, unit: '1 loaf' }, '20 oz', false);
  assert.equal(result.packs, 2);
  assert.equal(result.basis, 'requested_count');
  assert.equal(result.acquiredBaseAmount, undefined, 'no amount is invented');
});

test('float dust does not inflate the pack count', () => {
  // 3 x 0.333 l against a 1 l pack must not become 2 packs.
  const result = packsRequired({ quantity: 3, unit: '333.333333 ml' }, '1 l', false);
  assert.equal(result.packs, 1);
});

test('at least one pack is always required', () => {
  const result = packsRequired({ quantity: 1, unit: '1 g' }, '1 kg', false);
  assert.equal(result.packs, 1);
});
