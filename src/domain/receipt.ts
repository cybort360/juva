import type { ExtractedReceiptLine, ReceiptLine, ReceiptLineKind } from './types';

/**
 * Reading a printed receipt into something comparable.
 *
 * Receipt descriptions are hostile to matching: they are truncated to a fixed
 * width, vowel-stripped, abbreviated inconsistently between retailers, and mixed
 * in with lines that are not products at all. Everything here is deterministic
 * string and integer work — no model is consulted, and no price is ever derived
 * from a description.
 */

/**
 * Abbreviations that appear on real till rolls, mapped to the words a shopper
 * would recognise.
 *
 * Deliberately conservative. A wrong expansion invents a match, which is worse
 * than leaving a line unmatched and letting the shopper decide.
 *
 * Genuinely ambiguous abbreviations are deliberately absent. "WHT" is the clearest
 * case: it abbreviates both "white" and "wheat", and white bread is not wheat
 * bread. Expanding it either way would silently match one product to the other, so
 * it stays unexpanded and the comparison simply scores lower.
 */
const ABBREVIATIONS: Readonly<Record<string, string>> = {
  whl: 'whole',
  grn: 'green',
  chz: 'cheese',
  chkn: 'chicken',
  chk: 'chicken',
  brst: 'breast',
  bnls: 'boneless',
  sknls: 'skinless',
  gr: 'ground',
  bf: 'beef',
  mlk: 'milk',
  eg: 'eggs',
  egg: 'eggs',
  lrg: 'large',
  lg: 'large',
  sm: 'small',
  med: 'medium',
  brd: 'bread',
  sndwch: 'sandwich',
  swt: 'sweet',
  pot: 'potato',
  tom: 'tomato',
  onn: 'onion',
  ban: 'banana',
  yog: 'yogurt',
  ygrt: 'yogurt',
  grk: 'greek',
  crn: 'corn',
  flk: 'flakes',
  flks: 'flakes',
  cer: 'cereal',
  veg: 'vegetable',
  oliv: 'olive',
  ol: 'oil',
  rc: 'rice',
  lng: 'long',
  grain: 'grain',
  org: 'organic',
  orgnc: 'organic',
  gal: 'gallon',
  qt: 'quart',
  pk: 'pack',
  ct: 'count',
  ea: 'each',
  lb: 'pound',
  lbs: 'pound',
  oz: 'ounce',
};

/**
 * Lines that are not products.
 *
 * Matched against the normalised description, so casing and punctuation on the
 * printed roll do not matter.
 */
const DISCOUNT_MARKERS = [
  'coupon',
  'discount',
  'savings',
  'saved',
  'promo',
  'promotion',
  'member price',
  'member sav',
  'card sav',
  'loyalty',
  'markdown',
  'reward',
  'manuf coupon',
  'mfr coupon',
  'store coupon',
  'off',
];

const FEE_MARKERS = ['bag fee', 'bag charge', 'bottle deposit', 'deposit', 'service fee', 'bag'];

const TAX_MARKERS = ['tax', 'vat', 'gst', 'hst'];

const SUBTOTAL_MARKERS = [
  'subtotal',
  'sub total',
  'total',
  'balance',
  'amount due',
  'change',
  'tender',
  'cash',
  'visa',
  'mastercard',
  'debit',
  'credit',
  'card',
];

/** Collapses punctuation and whitespace so tokens can be compared. */
export function normalizeReceiptText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9%.\s/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Expands a single token if it is a known abbreviation.
 *
 * Tokens that are already words are returned untouched, so "milk" never becomes
 * something else through a partial rule.
 */
export function expandToken(token: string): string {
  const expansion = ABBREVIATIONS[token];
  return expansion ?? token;
}

/**
 * A receipt description rendered into comparable words.
 *
 * Digits and size tokens are kept, because "2 lb" versus "5 lb" is exactly the
 * kind of difference that must not be matched away.
 */
export function expandReceiptDescription(raw: string): string {
  const normalized = normalizeReceiptText(raw);
  if (normalized.length === 0) return '';
  return normalized
    .split(' ')
    .map((token) => expandToken(token))
    .join(' ');
}

function includesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

/**
 * Classifies a printed line.
 *
 * Order matters: a line reading "TOTAL SAVINGS" is a subtotal-ish summary line
 * rather than a discount to apply, so the summary markers are tested first for
 * lines that carry an explicit total word.
 */
export function classifyReceiptLine(raw: string, chargedPriceCents: number): ReceiptLineKind {
  const text = normalizeReceiptText(raw);
  if (text.length === 0) return 'ignored';

  // A summary line is never an item, and never a discount to apply, because its
  // amount already contains the lines above it.
  if (includesAny(text, SUBTOTAL_MARKERS)) return 'subtotal';
  if (includesAny(text, TAX_MARKERS)) return 'tax';
  if (includesAny(text, DISCOUNT_MARKERS)) return 'discount';
  if (includesAny(text, FEE_MARKERS)) return 'fee';
  // A bare negative amount with no marker is still money coming off the basket.
  if (chargedPriceCents < 0) return 'discount';
  return 'item';
}

/**
 * Reads a quantity out of a printed description.
 *
 * Handles the three shapes that actually appear: a leading count ("2 MILK"), an
 * explicit multiplier ("MILK 2 @ 3.49", "MILK X2"), and nothing at all.
 * Returns undefined rather than 1 when nothing was printed, so a caller can tell
 * "the receipt said one" from "the receipt said nothing".
 */
export function readPrintedQuantity(raw: string): number | undefined {
  /**
   * Deliberately not `normalizeReceiptText`: that strips `@`, which is the very
   * marker being looked for here. Quantity is read from a light normalisation that
   * keeps the multiplier symbols intact.
   */
  const text = raw.toLowerCase().replace(/\s+/g, ' ').trim();

  const read = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };

  // "2 @ 3.49" — count before the unit price.
  const at = read(/(\d+)\s*@/.exec(text)?.[1]);
  if (at !== undefined) return at;

  // "MILK X2" — count after the multiplier.
  const times = read(/\bx\s*(\d+)\b/.exec(text)?.[1]);
  if (times !== undefined) return times;

  // "3 BANANAS" — a leading count.
  const leading = read(/^(\d{1,2})\s+[a-z]/.exec(text)?.[1]);
  if (leading !== undefined) return leading;

  return undefined;
}

/**
 * Derives a per-unit price when the receipt did not print one.
 *
 * Integer division only, and only when it divides exactly. A per-unit price that
 * does not divide evenly would be a rounded invention, and unit prices are used
 * for comparison, so a wrong one is worse than none.
 */
export function derivedUnitPriceCents(
  chargedPriceCents: number,
  quantity: number,
): number | undefined {
  if (quantity <= 1) return undefined;
  if (chargedPriceCents <= 0) return undefined;
  if (chargedPriceCents % quantity !== 0) return undefined;
  return chargedPriceCents / quantity;
}

/**
 * Turns extracted lines into stored receipt lines with stable ids.
 *
 * Classification is re-derived here rather than trusted from the extractor: the
 * model may label a line, but what Juva acts on is decided by code that can be
 * tested. Redacted lines keep their place and their id so the shopper can see
 * that something was withheld rather than silently dropped.
 */
export function toReceiptLines(
  extracted: readonly ExtractedReceiptLine[],
  idPrefix = 'line',
): ReceiptLine[] {
  return extracted.map((line, index) => {
    const quantity = line.quantity > 0 ? line.quantity : (readPrintedQuantity(line.rawText) ?? 1);
    const unitPrice =
      line.unitPriceCents ?? derivedUnitPriceCents(line.chargedPriceCents, quantity);
    return {
      id: `${idPrefix}-${index}`,
      rawText: line.rawText,
      productName: line.productName,
      chargedPriceCents: line.chargedPriceCents,
      quantity,
      kind: classifyReceiptLine(line.rawText, line.chargedPriceCents),
      ...(line.barcode === undefined ? {} : { barcode: line.barcode }),
      ...(unitPrice === undefined ? {} : { unitPriceCents: unitPrice }),
      ...(line.discountCents === undefined ? {} : { discountCents: line.discountCents }),
    };
  });
}

/**
 * Total of the basket-level discounts on a receipt, as a positive magnitude.
 *
 * Only lines classified as discounts count, and the magnitude is taken as an
 * absolute value because retailers print these either way.
 */
export function receiptDiscountTotalCents(lines: readonly ReceiptLine[]): number {
  return lines
    .filter((line) => line.kind === 'discount' && line.redacted !== true)
    .reduce((sum, line) => sum + Math.abs(line.chargedPriceCents), 0);
}

/** The item lines a reconciliation may draw on: products, not summaries. */
export function comparableItemLines(lines: readonly ReceiptLine[]): ReceiptLine[] {
  return lines.filter((line) => line.kind === 'item' && line.redacted !== true);
}

/**
 * Redacts a line in place of removing it.
 *
 * The line survives with its text and price blanked so the shopper can see the
 * receipt still had a line there. Nothing redacted is ever sent for extraction
 * or used in a figure.
 */
export function redactLine(line: ReceiptLine): ReceiptLine {
  // Destructured out rather than overwritten: a redacted line must not carry a
  // barcode, which would still identify the product it was hiding.
  const { barcode: _barcode, unitPriceCents: _unitPrice, ...rest } = line;
  return {
    ...rest,
    rawText: '',
    productName: 'Redacted',
    chargedPriceCents: 0,
    redacted: true,
  };
}
