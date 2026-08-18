import type { ProductIdentifiers } from './types';

/**
 * Trade identifier normalization.
 *
 * A barcode is the strongest evidence Juva can have that two listings are the same
 * article — but only once both sides are expressed the same way. The same tin of
 * beans is printed as a 12-digit UPC in the US, a 13-digit EAN in Europe, and
 * appears in feeds with spaces, hyphens or a leading apostrophe from a spreadsheet
 * export. Comparing those as raw strings finds nothing.
 *
 * So every identifier is folded to a single canonical form — GTIN-14, zero-padded —
 * and validated by its check digit. A code that fails its own check digit is
 * discarded rather than repaired: a mistyped barcode that still compares equal to
 * something is worse than no barcode, because it would price the wrong product with
 * maximum confidence.
 */

/** Canonical form: 14 digits, left-zero-padded. */
export type Gtin = string;

const GTIN_LENGTHS = new Set([8, 12, 13, 14]);

/**
 * Strips formatting and returns digits only.
 *
 * Spreadsheet exports are the reason for the leading-apostrophe case: Excel writes
 * `'012345678905` to stop a barcode being read as a number, and that apostrophe
 * survives a CSV round trip.
 */
function digitsOnly(raw: string): string {
  return raw.replace(/[\s\-_'’.]/g, '');
}

/**
 * GS1 modulo-10 check digit over the payload (all but the last digit).
 *
 * Weights alternate 3 and 1 from the rightmost payload digit leftwards, which is
 * the same rule for GTIN-8, 12, 13 and 14 once the code is right-aligned.
 */
function checkDigitFor(payload: string): number {
  let sum = 0;
  for (let index = 0; index < payload.length; index += 1) {
    const digit = Number(payload[payload.length - 1 - index]);
    sum += digit * (index % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Normalizes any barcode/UPC/GTIN string to a validated GTIN-14.
 *
 * Returns `undefined` for anything that is not a well-formed, check-digit-valid
 * trade identifier. That includes empty strings, non-numeric text, wrong lengths,
 * and all-zero codes — `00000000000000` is a placeholder several feeds emit for
 * "unknown", and treating it as an identifier would match every such product to
 * every other.
 */
export function normalizeGtin(raw: string | undefined): Gtin | undefined {
  if (raw === undefined) return undefined;
  const digits = digitsOnly(raw);
  if (!/^\d+$/.test(digits)) return undefined;
  if (!GTIN_LENGTHS.has(digits.length)) return undefined;
  if (/^0+$/.test(digits)) return undefined;

  const payload = digits.slice(0, -1);
  const stated = Number(digits[digits.length - 1]);
  if (checkDigitFor(payload) !== stated) return undefined;

  // Zero-pad to GTIN-14 so a UPC-A and its EAN-13 form compare equal. This is
  // GS1's own rule, not a convenience: the shorter forms *are* the padded ones.
  return digits.padStart(14, '0');
}

/**
 * The single GTIN a set of identifiers resolves to.
 *
 * `gtin`, `upc` and `barcode` are checked in that order — most specific field
 * first. If two populated fields disagree the identifiers are self-contradictory
 * and `undefined` is returned, because Juva cannot know which one names the product
 * and guessing would be the same mistake as accepting a bad check digit.
 */
export function resolveGtin(identifiers: ProductIdentifiers | undefined): Gtin | undefined {
  if (identifiers === undefined) return undefined;
  const candidates = [identifiers.gtin, identifiers.upc, identifiers.barcode]
    .map(normalizeGtin)
    .filter((value): value is Gtin => value !== undefined);
  const first = candidates[0];
  if (first === undefined) return undefined;
  return candidates.every((value) => value === first) ? first : undefined;
}

/** Normalizes a retailer SKU for comparison. Case and padding are not meaningful. */
export function normalizeSku(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim().toLowerCase().replace(/\s+/g, '');
  return trimmed.length === 0 ? undefined : trimmed;
}

export type IdentityVerdict =
  /** Both sides carry a GTIN and they are the same article. */
  | 'gtin_match'
  /** Both sides carry a GTIN and they are different articles. */
  | 'gtin_mismatch'
  /** Same retailer, both sides carry a SKU, and they are the same article. */
  | 'sku_match'
  /** Nothing to compare: one side or both published no usable identifier. */
  | 'no_identifiers';

/**
 * Compares two identifier sets.
 *
 * SKU equality is only meaningful inside one retailer — two chains reuse the same
 * article numbers freely — so `sameRetailer` is a required argument rather than
 * something inferred, to make the caller state that it holds.
 *
 * A SKU *mismatch* is deliberately not a verdict. One retailer lists the same
 * article under several SKUs (different pack, different depot), so unequal SKUs say
 * nothing. An unequal GTIN does say something, which is why that case is named.
 */
export function compareIdentity(
  requested: ProductIdentifiers | undefined,
  candidate: ProductIdentifiers | undefined,
  sameRetailer: boolean,
): IdentityVerdict {
  const requestedGtin = resolveGtin(requested);
  const candidateGtin = resolveGtin(candidate);
  if (requestedGtin !== undefined && candidateGtin !== undefined) {
    return requestedGtin === candidateGtin ? 'gtin_match' : 'gtin_mismatch';
  }

  if (sameRetailer) {
    const requestedSku = normalizeSku(requested?.retailerSku);
    const candidateSku = normalizeSku(candidate?.retailerSku);
    if (requestedSku !== undefined && candidateSku !== undefined && requestedSku === candidateSku) {
      return 'sku_match';
    }
  }

  return 'no_identifiers';
}
