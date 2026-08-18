import { compareIdentity } from './identity';
import type { BrandPolicy, GroceryListItem, LegacyBrandPolicy, RetailerProduct } from './types';

/**
 * Canonical product normalization and retailer-specific matching.
 *
 * Retailers name the same thing differently ("Whole Milk", "MILK, WHOLE, 1GAL",
 * "Lait entier"), and a shopper writes something different again. This module is
 * the single place where those are reconciled, so the optimizer only ever sees
 * "does this retailer product satisfy this basket line, yes or no".
 *
 * Matching is deliberately conservative. A false positive prices the wrong
 * product, which produces a real but wrong total — the failure mode that most
 * undermines a savings claim. When evidence is weak the candidate is rejected.
 */

/**
 * Concept aliases. The left side is anything a shopper or retailer might use;
 * the right side is Juva's canonical concept.
 */
const CONCEPT_ALIASES: Record<string, string> = {
  yoghurt: 'yogurt',
  yoghurts: 'yogurt',
  yogurts: 'yogurt',
  'greek yoghurt': 'yogurt',
  'greek yogurt': 'yogurt',
  milks: 'milk',
  'whole milk': 'milk',
  'semi skimmed milk': 'milk',
  egg: 'eggs',
  'chicken breasts': 'chicken breast',
  chicken: 'chicken breast',
  'boneless chicken breast': 'chicken breast',
  breads: 'bread',
  loaf: 'bread',
  'sliced bread': 'bread',
  cereals: 'cereal',
  'corn flakes': 'cereal',
  cornflakes: 'cereal',
  oat: 'oats',
  oatmeal: 'oats',
  'rolled oats': 'oats',
  banana: 'bananas',
  tomato: 'tomatoes',
  onion: 'onions',
  oil: 'cooking oil',
  'vegetable oil': 'cooking oil',
  'olive oil': 'cooking oil',
  rices: 'rice',
};

/**
 * Reduces free text to a comparable form: lowercase, no punctuation, single
 * spaces. Applied to both sides of every comparison so normalization can never
 * be half-applied.
 */
export function normalizeText(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      // Drop combining marks so "crème" and "creme" compare equal.
      .replace(/[̀-ͯ]/g, '')
      .replace(/['’`]s\b/g, '')
      .replace(/['’`]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ')
  );
}

/** Maps any spelling of a concept onto Juva's canonical concept. */
export function canonicalConcept(raw: string): string {
  const normalized = normalizeText(raw);
  if (!normalized) return '';
  const aliased = CONCEPT_ALIASES[normalized];
  if (aliased) return aliased;
  // Try a naive singular form before giving up, so "avocados" finds "avocado".
  if (normalized.endsWith('s')) {
    const singular = normalized.slice(0, -1);
    const singularAlias = CONCEPT_ALIASES[singular];
    if (singularAlias) return singularAlias;
  }
  return normalized;
}

export function conceptsMatch(a: string, b: string): boolean {
  return canonicalConcept(a) === canonicalConcept(b);
}

/** Normalizes a brand for comparison: "Kellogg's" and "Kelloggs" become equal. */
export function normalizeBrand(brand: string): string {
  return normalizeText(brand);
}

/**
 * Folds a trailing plural so "Kelloggs" and "Kellogg's" compare equal.
 *
 * Possessive stripping alone is not enough: it turns "Kellogg's" into "kellogg"
 * while "Kelloggs" stays "kelloggs", and the two would then fail to match. Short
 * tokens are left alone so "oats" does not become "oat" and collide with
 * unrelated words.
 */
function foldToken(token: string): string {
  return token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token;
}

/**
 * Whether a product's brand satisfies a requested brand.
 *
 * Token-containment rather than substring: "Grove Farms" satisfies a request for
 * "Grove", but "Grovewood" does not satisfy "Grove", because a substring match
 * would happily accept an unrelated brand that merely shares letters.
 */
export function brandSatisfies(productBrand: string, requestedBrand: string): boolean {
  const product = normalizeBrand(productBrand);
  const requested = normalizeBrand(requestedBrand);
  if (!requested) return true;
  if (!product) return false;
  if (product === requested) return true;

  const productTokens = product.split(' ').map(foldToken);
  const requestedTokens = requested.split(' ').map(foldToken);
  // Every requested token must appear as a whole token in the product brand.
  return requestedTokens.every((token) => productTokens.includes(token));
}

export type MatchRejection =
  | 'concept_mismatch'
  | 'currency_mismatch'
  | 'unavailable'
  | 'brand_required'
  | 'variant_required'
  | 'barcode_mismatch'
  | 'price_not_positive';

/**
 * Which rung of the matching hierarchy accepted a candidate.
 *
 * Ordered strongest to weakest. The tier is carried on the result rather than
 * collapsed into a boolean because a plan has to be able to say *why* it believes a
 * product is the right one — "matched by barcode" and "matched because the words
 * looked similar" are very different claims to put in front of a shopper.
 */
export type MatchTier =
  /** 1. Both sides published a GTIN and they are the same article. */
  | 'gtin'
  /** 2. Same retailer, same article number. */
  | 'retailer_sku'
  /** 3. Same canonical product, and the named variant agrees. */
  | 'product_identity'
  /** 4. Same brand, compatible product attributes. */
  | 'brand_attributes'
  /** 5. Normalized product tokens agree; brand differs or is unstated. */
  | 'token'
  /** 6. Tokens agree only once pack size and unit are taken into account. */
  | 'pack_size'
  /** 7. Weak textual similarity. Accepted only where the policy allows it. */
  | 'fuzzy'
  /** 8. Plausible but ambiguous. Needs the shopper to confirm before it is used. */
  | 'manual_confirmation';

/** Strength order, strongest first. Used to rank and to compare tiers. */
export const MATCH_TIER_ORDER: readonly MatchTier[] = [
  'gtin',
  'retailer_sku',
  'product_identity',
  'brand_attributes',
  'token',
  'pack_size',
  'fuzzy',
  'manual_confirmation',
];

export function tierRank(tier: MatchTier): number {
  return MATCH_TIER_ORDER.indexOf(tier);
}

export interface MatchResult {
  readonly matched: boolean;
  readonly rejection?: MatchRejection;
  /** True when the product is not the requested brand but is still allowed. */
  readonly substitution: boolean;
  /** Which rung accepted it. Absent on a rejection. */
  readonly tier?: MatchTier;
  /**
   * True when the evidence is too weak to buy on without asking. The optimizer may
   * still price it, but it is surfaced as needing confirmation rather than treated
   * as settled.
   */
  readonly needsConfirmation?: boolean;
}

export interface MatchContext {
  /** The basket's currency. A price in any other currency is not comparable. */
  readonly currency: string;
  /** Default policy when the line does not override it. */
  readonly defaultBrandPolicy: BrandPolicy;
  /**
   * Retailer the shopper's own identifiers came from, when they came from one.
   *
   * Only set this when a SKU the shopper supplied is genuinely that retailer's.
   * Article numbers are not portable between chains, so leaving it unset is the
   * safe default and means SKU comparison is skipped.
   */
  readonly requestedRetailerId?: string;
}

/**
 * Whether the candidate's variant agrees with the one the shopper named.
 *
 * Token containment, in the same spirit as `brandSatisfies`: a request for "whole"
 * milk is satisfied by "Grove Whole Milk, 1 gal" but not by "Grove Skim Milk". The
 * candidate's own extra words are allowed — a retailer's title carries pack size and
 * marketing copy the shopper never typed.
 */
export function variantSatisfies(product: RetailerProduct, requestedVariant: string): boolean {
  const requested = normalizeText(requestedVariant);
  if (!requested) return true;
  const haystack = new Set(
    `${normalizeText(product.title)} ${normalizeText(product.sizeLabel)}`.split(' ').map(foldToken),
  );
  return requested
    .split(' ')
    .map(foldToken)
    .every((token) => haystack.has(token));
}

/**
 * Decides whether one retailer product can fill one basket line.
 *
 * Every rejection reason is named so the optimizer can explain coverage gaps
 * instead of silently dropping candidates.
 */
export function matchProduct(
  item: GroceryListItem,
  product: RetailerProduct,
  context: MatchContext,
): MatchResult {
  // ── Rung 1 and 2: trade identity ──────────────────────────────────────────
  //
  // Evaluated before anything textual, and *before* the concept check, because a
  // barcode is a stronger claim than any words. Two feeds titling the same tin
  // differently is routine; two different articles sharing a valid GTIN is not.
  const identity = compareIdentity(
    item.requestedIdentifiers,
    product.identifiers,
    context.requestedRetailerId !== undefined &&
      context.requestedRetailerId === product.observation.retailerId,
  );

  // A barcode mismatch is strong negative evidence, so it rejects outright rather
  // than falling through to text. If the shopper scanned one pack and this is
  // demonstrably a different article, no amount of title similarity redeems it.
  if (identity === 'gtin_mismatch') {
    return { matched: false, rejection: 'barcode_mismatch', substitution: false };
  }

  const identityTier: MatchTier | undefined =
    identity === 'gtin_match' ? 'gtin' : identity === 'sku_match' ? 'retailer_sku' : undefined;

  // Sellability checks apply at every tier. A barcode match to an unbuyable or
  // wrongly-priced row is still not something Juva can plan on.
  if (product.observation.currency !== context.currency) {
    return { matched: false, rejection: 'currency_mismatch', substitution: false };
  }
  if (!product.observation.available) {
    return { matched: false, rejection: 'unavailable', substitution: false };
  }
  if (product.observation.priceCents <= 0) {
    return { matched: false, rejection: 'price_not_positive', substitution: false };
  }

  // An identifier match settles identity. Brand and variant rules are requirements
  // *about which product to buy*, and this is provably that product.
  if (identityTier !== undefined) {
    return { matched: true, substitution: false, tier: identityTier };
  }

  // ── Rung 3 onwards: textual identity ──────────────────────────────────────
  if (!conceptsMatch(product.canonicalConcept, item.concept)) {
    return { matched: false, rejection: 'concept_mismatch', substitution: false };
  }

  const policy = effectiveBrandPolicy(item, context.defaultBrandPolicy);
  const requestedVariant = item.requestedVariant;
  const variantOk = requestedVariant === undefined || variantSatisfies(product, requestedVariant);
  const requestedBrand = item.requestedBrand;

  // No brand named: identity rests on the concept alone. That is rung 5, not rung 3
  // — "some milk" is a weaker claim than "this milk", and the tier should say so.
  if (!requestedBrand) {
    if (policy === 'exact_product' && !variantOk) {
      return { matched: false, rejection: 'variant_required', substitution: false };
    }
    return { matched: true, substitution: false, tier: variantOk ? 'token' : 'pack_size' };
  }

  const brandOk = brandSatisfies(product.brand, requestedBrand);

  if (brandOk) {
    switch (policy) {
      case 'exact_product':
        // The named product only. Another article from the same brand is a
        // different product, and this is the rule that says so.
        return variantOk
          ? { matched: true, substitution: false, tier: 'product_identity' }
          : { matched: false, rejection: 'variant_required', substitution: false };
      case 'exact_brand':
        // Any compatible product from this brand. The variant is a preference here,
        // not a requirement, so a differing variant is accepted one rung lower.
        return {
          matched: true,
          substitution: false,
          tier: variantOk ? 'product_identity' : 'brand_attributes',
        };
      case 'flexible':
      case 'cheapest':
        return {
          matched: true,
          substitution: false,
          tier: variantOk ? 'product_identity' : 'brand_attributes',
        };
    }
  }

  // Right concept, wrong brand.
  if (policy === 'exact_product' || policy === 'exact_brand') {
    return { matched: false, rejection: 'brand_required', substitution: false };
  }

  // A substitution. `flexible` wants the shopper to see it as one and pays a ranking
  // penalty for it; `cheapest` is indifferent and takes the equivalent on its price.
  // Either way the concept and any named variant still have to hold — "cheapest"
  // never means "a different product that happens to cost less".
  if (!variantOk) {
    return {
      matched: true,
      substitution: true,
      tier: 'manual_confirmation',
      needsConfirmation: true,
    };
  }
  return { matched: true, substitution: true, tier: policy === 'flexible' ? 'fuzzy' : 'token' };
}

/**
 * Upgrades a persisted policy value to the four-state model.
 *
 * Called on load rather than in a migration script, so a device that has not opened
 * Juva since the change still reads its own saved preference correctly instead of
 * silently falling back to a default. The old `exact` meant "do not swap the brand",
 * and the strictest of the two new exact states is the one that keeps that promise.
 */
export function migrateBrandPolicy(
  value: BrandPolicy | LegacyBrandPolicy | undefined,
): BrandPolicy {
  switch (value) {
    case 'exact':
    case 'exact_product':
      return 'exact_product';
    case 'exact_brand':
      return 'exact_brand';
    case 'cheapest':
      return 'cheapest';
    case 'flexible':
      return 'flexible';
    default:
      return 'flexible';
  }
}

/** Whether a stored value is a policy this build understands, old or new. */
export function isBrandPolicyValue(value: unknown): value is BrandPolicy | LegacyBrandPolicy {
  return (
    value === 'exact' ||
    value === 'exact_product' ||
    value === 'exact_brand' ||
    value === 'flexible' ||
    value === 'cheapest'
  );
}

export function effectiveBrandPolicy(
  item: GroceryListItem,
  defaultPolicy: BrandPolicy,
): BrandPolicy {
  return item.brandPolicy ?? defaultPolicy;
}

/**
 * Cost added to a candidate that misses a requested brand, in cents.
 *
 * This is a ranking penalty only — it never enters a price, a total or a saving.
 * `flexible` prefers the requested brand but will substitute to save money;
 * `cheapest` is indifferent.
 */
export const BRAND_SUBSTITUTION_RANK_PENALTY_CENTS = 60;

export function brandRankPenaltyCents(policy: BrandPolicy, substitution: boolean): number {
  if (!substitution) return 0;
  // `exact_product` and `exact_brand` never produce a substitution at all, so they
  // are unreachable here; `cheapest` is indifferent by definition.
  return policy === 'flexible' ? BRAND_SUBSTITUTION_RANK_PENALTY_CENTS : 0;
}
