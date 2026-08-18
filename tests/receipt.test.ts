import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyReceiptLine,
  comparableItemLines,
  derivedUnitPriceCents,
  expandReceiptDescription,
  normalizeReceiptText,
  readPrintedQuantity,
  receiptDiscountTotalCents,
  redactLine,
  toReceiptLines,
} from '../src/domain/receipt';
import type { ExtractedReceiptLine, ReceiptLine } from '../src/domain/types';

function extracted(over: Partial<ExtractedReceiptLine> = {}): ExtractedReceiptLine {
  return {
    rawText: 'WHL MLK 1GAL',
    productName: 'Whole Milk',
    chargedPriceCents: 349,
    quantity: 1,
    kind: 'item',
    ...over,
  };
}

function line(over: Partial<ReceiptLine> = {}): ReceiptLine {
  return {
    id: 'l1',
    rawText: 'WHL MLK',
    productName: 'Whole Milk',
    chargedPriceCents: 349,
    quantity: 1,
    kind: 'item',
    ...over,
  };
}

test('normalisation strips punctuation but keeps digits and sizes', () => {
  assert.equal(normalizeReceiptText('WHL MLK 1GAL***'), 'whl mlk 1gal');
  assert.equal(normalizeReceiptText('  CHKN   BRST  '), 'chkn brst');
  assert.equal(normalizeReceiptText('2 @ 3.49'), '2 3.49');
});

test('abbreviations expand to recognisable words', () => {
  assert.equal(expandReceiptDescription('WHL MLK'), 'whole milk');
  assert.equal(expandReceiptDescription('BNLS CHKN BRST'), 'boneless chicken breast');
  assert.equal(expandReceiptDescription('SNDWCH BRD'), 'sandwich bread');
});

test('an ambiguous abbreviation is left alone rather than guessed', () => {
  // "WHT" is both white and wheat, and those are different breads. Expanding it
  // either way would match one product to the other.
  assert.equal(expandReceiptDescription('WHT BRD'), 'wht bread');
});

test('a word that is already a word is never rewritten', () => {
  assert.equal(expandReceiptDescription('milk'), 'milk');
  assert.equal(expandReceiptDescription('chicken breast'), 'chicken breast');
});

test('size tokens survive expansion so 2 lb never matches 5 lb', () => {
  const two = expandReceiptDescription('RICE 2LB');
  const five = expandReceiptDescription('RICE 5LB');
  assert.notEqual(two, five);
  assert.ok(two.includes('2lb'));
});

test('an item line is classified as an item', () => {
  assert.equal(classifyReceiptLine('WHL MLK 1GAL', 349), 'item');
  assert.equal(classifyReceiptLine('BANANAS', 159), 'item');
});

test('coupons and member savings are classified as discounts', () => {
  assert.equal(classifyReceiptLine('MFR COUPON', -100), 'discount');
  assert.equal(classifyReceiptLine('MEMBER SAVINGS', -50), 'discount');
  assert.equal(classifyReceiptLine('STORE COUPON 1.00 OFF', -100), 'discount');
});

test('a negative amount with no marker is still a discount', () => {
  assert.equal(classifyReceiptLine('ADJUSTMENT', -25), 'discount');
});

test('tax, fees and summary lines are not items', () => {
  assert.equal(classifyReceiptLine('SALES TAX', 217), 'tax');
  assert.equal(classifyReceiptLine('BAG FEE', 10), 'fee');
  assert.equal(classifyReceiptLine('SUBTOTAL', 4608), 'subtotal');
  assert.equal(classifyReceiptLine('TOTAL', 5000), 'subtotal');
  assert.equal(classifyReceiptLine('VISA DEBIT', 5000), 'subtotal');
});

test('a summary line naming savings is a summary, not a discount to apply', () => {
  // "TOTAL SAVINGS 4.20" already aggregates the coupon lines above it; treating it
  // as another discount would double-count the shopper's money.
  assert.equal(classifyReceiptLine('TOTAL SAVINGS', 420), 'subtotal');
});

test('an empty description is ignored rather than treated as an item', () => {
  assert.equal(classifyReceiptLine('', 100), 'ignored');
  assert.equal(classifyReceiptLine('   ', 100), 'ignored');
});

test('printed quantities are read from the shapes receipts actually use', () => {
  assert.equal(readPrintedQuantity('2 @ 3.49'), 2);
  assert.equal(readPrintedQuantity('MILK X2 6.98'), 2);
  assert.equal(readPrintedQuantity('3 BANANAS'), 3);
});

test('a description with no printed quantity returns undefined, not 1', () => {
  // The distinction matters: "the receipt said one" is evidence, "the receipt said
  // nothing" is not.
  assert.equal(readPrintedQuantity('WHOLE MILK'), undefined);
});

test('a unit price is derived only when it divides exactly', () => {
  assert.equal(derivedUnitPriceCents(698, 2), 349);
  assert.equal(derivedUnitPriceCents(699, 2), undefined, 'would round to an invented price');
  assert.equal(derivedUnitPriceCents(349, 1), undefined, 'a single unit has no derived unit price');
  assert.equal(derivedUnitPriceCents(0, 2), undefined);
});

test('extraction is converted with stable ids and re-derived classification', () => {
  const lines = toReceiptLines([
    extracted(),
    // The model claims this is an item; the classifier disagrees, and wins.
    extracted({ rawText: 'MFR COUPON', productName: 'Coupon', chargedPriceCents: -100 }),
  ]);
  assert.equal(lines[0]?.id, 'line-0');
  assert.equal(lines[1]?.id, 'line-1');
  assert.equal(lines[1]?.kind, 'discount', 'classification is not taken on trust from the model');
});

test('a quantity of zero from the extractor falls back to the printed text', () => {
  const lines = toReceiptLines([extracted({ rawText: '2 @ 3.49', quantity: 0 })]);
  assert.equal(lines[0]?.quantity, 2);
});

test('receipt discounts total as positive magnitudes however they were printed', () => {
  const total = receiptDiscountTotalCents([
    line({ id: 'a', kind: 'discount', chargedPriceCents: -100 }),
    line({ id: 'b', kind: 'discount', chargedPriceCents: 50 }),
    line({ id: 'c', kind: 'item', chargedPriceCents: 349 }),
  ]);
  assert.equal(total, 150);
});

test('redacted lines contribute nothing to a discount total', () => {
  const total = receiptDiscountTotalCents([
    line({ id: 'a', kind: 'discount', chargedPriceCents: -100, redacted: true }),
  ]);
  assert.equal(total, 0);
});

test('only unredacted item lines are comparable', () => {
  const comparable = comparableItemLines([
    line({ id: 'a' }),
    line({ id: 'b', kind: 'tax' }),
    line({ id: 'c', redacted: true }),
  ]);
  assert.deepEqual(
    comparable.map((entry) => entry.id),
    ['a'],
  );
});

test('redaction removes the text, the price and the barcode', () => {
  const redacted = redactLine(line({ barcode: '0001112223334', chargedPriceCents: 349 }));
  assert.equal(redacted.rawText, '');
  assert.equal(redacted.chargedPriceCents, 0);
  assert.equal(redacted.redacted, true);
  assert.equal(
    'barcode' in redacted,
    false,
    'a barcode would still identify the product being hidden',
  );
});

test('redaction keeps the line in place rather than deleting it', () => {
  const redacted = redactLine(line({ id: 'l7' }));
  assert.equal(redacted.id, 'l7', 'the shopper should see that a line was withheld');
});
