/**
 * Quantity normalization, unit pricing and pack-size comparison.
 *
 * Groceries are quoted in whatever unit the retailer prints, so comparing
 * "1 gal" against "2 x 64 fl oz" needs a canonical base. Everything here reduces
 * to one base unit per dimension (grams, millilitres, count) and refuses to
 * compare across dimensions.
 *
 * Refusing is the important part: `oz` is ambiguous between weight and fluid
 * ounces, so an unresolvable comparison yields `null` rather than a plausible
 * wrong answer. A wrong unit conversion would silently corrupt every downstream
 * price comparison, which is worse than declining to compare.
 */

export type Dimension = 'mass' | 'volume' | 'count';

export interface ParsedQuantity {
  /** Magnitude in the parsed unit, already multiplied out for multipacks. */
  readonly value: number;
  /** Canonical unit token the value was expressed in. */
  readonly unit: string;
  readonly dimension: Dimension;
  /** True for "~2 lb" style labels, where the printed amount is nominal. */
  readonly approximate: boolean;
  /** Packs in a multipack, e.g. 2 for "2 x 500 ml". 1 otherwise. */
  readonly packCount: number;
}

export interface NormalizedQuantity {
  /** Amount in the dimension's base unit: g, ml, or ct. */
  readonly amount: number;
  readonly dimension: Dimension;
  readonly approximate: boolean;
}

/** Base unit per dimension. All comparisons happen in these units. */
export const BASE_UNIT: Record<Dimension, string> = {
  mass: 'g',
  volume: 'ml',
  count: 'ct',
};

/**
 * Conversion factors into base units. US customary volumes are used because
 * Juva's shipped market and its first real coverage are US.
 */
const UNITS: Record<string, { dimension: Dimension; toBase: number }> = {
  // mass
  mg: { dimension: 'mass', toBase: 0.001 },
  g: { dimension: 'mass', toBase: 1 },
  gram: { dimension: 'mass', toBase: 1 },
  grams: { dimension: 'mass', toBase: 1 },
  kg: { dimension: 'mass', toBase: 1000 },
  kilogram: { dimension: 'mass', toBase: 1000 },
  kilograms: { dimension: 'mass', toBase: 1000 },
  oz: { dimension: 'mass', toBase: 28.349523125 },
  ounce: { dimension: 'mass', toBase: 28.349523125 },
  ounces: { dimension: 'mass', toBase: 28.349523125 },
  lb: { dimension: 'mass', toBase: 453.59237 },
  lbs: { dimension: 'mass', toBase: 453.59237 },
  pound: { dimension: 'mass', toBase: 453.59237 },
  pounds: { dimension: 'mass', toBase: 453.59237 },

  // volume
  ml: { dimension: 'volume', toBase: 1 },
  millilitre: { dimension: 'volume', toBase: 1 },
  milliliter: { dimension: 'volume', toBase: 1 },
  cl: { dimension: 'volume', toBase: 10 },
  l: { dimension: 'volume', toBase: 1000 },
  litre: { dimension: 'volume', toBase: 1000 },
  liter: { dimension: 'volume', toBase: 1000 },
  litres: { dimension: 'volume', toBase: 1000 },
  liters: { dimension: 'volume', toBase: 1000 },
  'fl oz': { dimension: 'volume', toBase: 29.5735295625 },
  floz: { dimension: 'volume', toBase: 29.5735295625 },
  pt: { dimension: 'volume', toBase: 473.176473 },
  pint: { dimension: 'volume', toBase: 473.176473 },
  pints: { dimension: 'volume', toBase: 473.176473 },
  qt: { dimension: 'volume', toBase: 946.352946 },
  quart: { dimension: 'volume', toBase: 946.352946 },
  quarts: { dimension: 'volume', toBase: 946.352946 },
  gal: { dimension: 'volume', toBase: 3785.411784 },
  gallon: { dimension: 'volume', toBase: 3785.411784 },
  gallons: { dimension: 'volume', toBase: 3785.411784 },

  // count
  ct: { dimension: 'count', toBase: 1 },
  count: { dimension: 'count', toBase: 1 },
  ea: { dimension: 'count', toBase: 1 },
  each: { dimension: 'count', toBase: 1 },
  pack: { dimension: 'count', toBase: 1 },
  packs: { dimension: 'count', toBase: 1 },
  pk: { dimension: 'count', toBase: 1 },
  loaf: { dimension: 'count', toBase: 1 },
  loaves: { dimension: 'count', toBase: 1 },
  dozen: { dimension: 'count', toBase: 12 },
  doz: { dimension: 'count', toBase: 12 },
};

/** Words that describe a pack without changing its magnitude. */
const COUNT_NOUNS = /\b(large|small|medium|jumbo|extra|xl|ct|count|ea|each|pack|pk|eggs?)\b/;

function normalizeUnitToken(raw: string): string {
  return raw.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
}

function lookupUnit(token: string): { dimension: Dimension; toBase: number } | undefined {
  const normalized = normalizeUnitToken(token);
  return UNITS[normalized] ?? UNITS[normalized.replace(/\s+/g, '')];
}

/**
 * Parses a printed size label into a magnitude and unit.
 *
 * Handles the shapes real retailer and OFF data actually use: "1 gal",
 * "500 g", "12 ct", "~2 lb", "2 x 500 ml", "12 large", "1 loaf", "6",
 * "3.5 oz (100 g)". Returns null when nothing usable can be read, so callers
 * fall back to counting packs instead of guessing an amount.
 */
export function parseQuantity(label: string | undefined): ParsedQuantity | null {
  if (!label) return null;
  const text = label.trim().toLowerCase();
  if (!text) return null;

  const approximate = /^[~≈]|approx/.test(text);
  const cleaned = text.replace(/^[~≈]\s*/, '').replace(/approx\.?\s*/, '');

  // Multipack: "2 x 500 ml", "6x330ml", "2 × 1 l".
  const multipack = cleaned.match(/^(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*([a-z][a-z\s]*)?/);
  if (multipack) {
    const packCount = Number(multipack[1]);
    const each = Number(multipack[2]);
    const unitToken = multipack[3]?.trim();
    const resolved = unitToken ? lookupUnit(unitToken) : undefined;
    if (Number.isFinite(packCount) && Number.isFinite(each) && packCount > 0 && each > 0) {
      if (resolved) {
        return {
          value: packCount * each,
          unit: normalizeUnitToken(unitToken ?? 'ct'),
          dimension: resolved.dimension,
          approximate,
          packCount,
        };
      }
      // "6 x 2" with no unit is a count of individual items.
      return {
        value: packCount * each,
        unit: 'ct',
        dimension: 'count',
        approximate,
        packCount,
      };
    }
  }

  // "500 g", "1 gal", "3.5 oz (100 g)", "12 large", "1 loaf"
  const single = cleaned.match(/(\d+(?:\.\d+)?)\s*([a-z][a-z\s]*)?/);
  if (!single) return null;
  const value = Number(single[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const rest = single[2]?.trim() ?? '';
  // Longest-first so "fl oz" wins over "oz".
  const tokens = rest.split(/[\s(),/]+/).filter(Boolean);
  const twoWord = tokens.length >= 2 ? `${tokens[0]} ${tokens[1]}` : undefined;
  const resolved =
    (twoWord ? lookupUnit(twoWord) : undefined) ?? (tokens[0] ? lookupUnit(tokens[0]) : undefined);

  if (resolved) {
    const unitToken = (twoWord && lookupUnit(twoWord) ? twoWord : tokens[0]) ?? 'ct';
    return {
      value,
      unit: normalizeUnitToken(unitToken),
      dimension: resolved.dimension,
      approximate,
      packCount: 1,
    };
  }

  // A bare number, or a number with a descriptive noun ("12 large"), is a count.
  if (rest === '' || COUNT_NOUNS.test(rest)) {
    return { value, unit: 'ct', dimension: 'count', approximate, packCount: 1 };
  }

  return null;
}

/** Reduces a parsed quantity to its dimension's base unit. */
export function normalizeQuantity(parsed: ParsedQuantity | null): NormalizedQuantity | null {
  if (!parsed) return null;
  const unit = lookupUnit(parsed.unit);
  if (!unit) return null;
  return {
    amount: parsed.value * unit.toBase,
    dimension: unit.dimension,
    approximate: parsed.approximate,
  };
}

/** Convenience: parse and normalize in one step. */
export function normalizeLabel(label: string | undefined): NormalizedQuantity | null {
  return normalizeQuantity(parseQuantity(label));
}

export interface UnitPrice {
  /**
   * Cents per base unit. Fractional on purpose: this is a comparison ratio, not
   * a charged amount, so rounding it would distort pack-size comparisons.
   */
  readonly centsPerBaseUnit: number;
  readonly dimension: Dimension;
  /** Human-readable basis, e.g. "per kg", "per L", "per item". */
  readonly label: string;
}

/** Display basis per dimension: the unit shoppers actually reason in. */
const DISPLAY_BASIS: Record<Dimension, { label: string; perBase: number }> = {
  mass: { label: 'per kg', perBase: 1000 },
  volume: { label: 'per L', perBase: 1000 },
  count: { label: 'per item', perBase: 1 },
};

/**
 * Unit price for a pack, used only to compare like with like.
 *
 * Returns null when the pack size cannot be read, so a product with an
 * unparseable label is never given a fabricated unit price.
 */
export function unitPriceFor(priceCents: number, packLabel: string | undefined): UnitPrice | null {
  const normalized = normalizeLabel(packLabel);
  if (!normalized || normalized.amount <= 0) return null;
  return {
    centsPerBaseUnit: priceCents / normalized.amount,
    dimension: normalized.dimension,
    label: DISPLAY_BASIS[normalized.dimension].label,
  };
}

/** Unit price expressed in the basis a shopper reads, rounded to whole cents. */
export function displayUnitPriceCents(unitPrice: UnitPrice): number {
  return Math.round(unitPrice.centsPerBaseUnit * DISPLAY_BASIS[unitPrice.dimension].perBase);
}

export interface PackRequirement {
  /**
   * Packs to buy. Whole packs for discrete goods; fractional for goods sold by
   * weight, where the shopper takes an arbitrary amount.
   */
  readonly packs: number;
  /** How the figure was reached, for explanation and testing. */
  readonly basis: 'weighed' | 'pack_multiple' | 'requested_count';
  /** True when packs were rounded up, so the shopper buys more than asked. */
  readonly roundedUp: boolean;
  /** Amount actually acquired in base units, when computable. */
  readonly acquiredBaseAmount?: number;
}

/**
 * How many packs satisfy a requested amount.
 *
 * Three distinct cases, because conflating them produces wrong totals:
 *
 * - **Weighed goods** (loose chicken at $3.99/lb): the shopper takes exactly the
 *   requested weight, so the multiplier is fractional.
 * - **Discrete packs** where both sizes are known: whole packs, rounded up,
 *   because half a carton cannot be bought.
 * - **Unknown sizes**: fall back to the requested pack count rather than
 *   inventing a conversion.
 */
export function packsRequired(
  requested: { quantity: number; unit: string | undefined },
  packLabel: string | undefined,
  soldByWeight: boolean,
): PackRequirement {
  const requestedNormalized = normalizeLabel(requested.unit);
  const packNormalized = normalizeLabel(packLabel);

  const comparable =
    requestedNormalized !== null &&
    packNormalized !== null &&
    requestedNormalized.dimension === packNormalized.dimension &&
    packNormalized.amount > 0;

  if (!comparable) {
    return { packs: requested.quantity, basis: 'requested_count', roundedUp: false };
  }

  // Total wanted: the printed size times how many of that size were requested.
  const wanted = requestedNormalized.amount * requested.quantity;
  const raw = wanted / packNormalized.amount;

  if (soldByWeight) {
    return {
      packs: raw,
      basis: 'weighed',
      roundedUp: false,
      acquiredBaseAmount: wanted,
    };
  }

  // Guard against float dust turning 2.0000000004 into 3 packs.
  const packs = Math.max(1, Math.ceil(Number(raw.toFixed(6))));
  return {
    packs,
    basis: 'pack_multiple',
    roundedUp: packs > raw + 1e-9,
    acquiredBaseAmount: packs * packNormalized.amount,
  };
}

/**
 * Compares two packs by unit price.
 *
 * Returns null when they are not comparable, which callers must treat as "no
 * information" rather than "equal".
 */
export function comparePackValue(
  a: { priceCents: number; packLabel: string | undefined },
  b: { priceCents: number; packLabel: string | undefined },
): { cheaper: 'a' | 'b' | 'equal'; ratio: number } | null {
  const unitA = unitPriceFor(a.priceCents, a.packLabel);
  const unitB = unitPriceFor(b.priceCents, b.packLabel);
  if (!unitA || !unitB || unitA.dimension !== unitB.dimension) return null;
  if (unitA.centsPerBaseUnit === unitB.centsPerBaseUnit) return { cheaper: 'equal', ratio: 1 };
  return unitA.centsPerBaseUnit < unitB.centsPerBaseUnit
    ? { cheaper: 'a', ratio: unitB.centsPerBaseUnit / unitA.centsPerBaseUnit }
    : { cheaper: 'b', ratio: unitA.centsPerBaseUnit / unitB.centsPerBaseUnit };
}
