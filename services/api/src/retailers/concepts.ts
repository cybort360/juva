/**
 * Mapping between Juva grocery concepts and Open Food Facts taxonomy.
 *
 * Category tags alone are not a reliable concept match. Measured against the
 * live API, `en:breads` returns croutons and matzo meal, and `en:yogurts`
 * returns a butter spread. So a category tag is used to *narrow* the query and a
 * name check is used to *confirm* the match. Anything that fails confirmation is
 * dropped rather than priced, because pricing a butter spread as yogurt would be
 * a fabricated price for the item the shopper actually asked for.
 */

export interface ConceptMapping {
  readonly concept: string;
  /** OFF category tags queried via `product__categories_tags__contains`. */
  readonly categoryTags: readonly string[];
  /** At least one must appear in the product name for a confirmed match. */
  readonly nameIncludes: readonly string[];
  /** Any of these in the name disqualifies the match. */
  readonly nameExcludes: readonly string[];
}

const MAPPINGS: readonly ConceptMapping[] = [
  {
    concept: 'milk',
    categoryTags: ['en:milks'],
    nameIncludes: ['milk'],
    nameExcludes: ['milkshake', 'chocolate', 'condensed', 'evaporated', 'powder', 'soap'],
  },
  {
    concept: 'eggs',
    categoryTags: ['en:eggs', 'en:chicken-eggs'],
    nameIncludes: ['egg'],
    nameExcludes: ['eggplant', 'nog', 'plant egg', 'substitute'],
  },
  {
    concept: 'bread',
    categoryTags: ['en:breads', 'en:sliced-breads'],
    nameIncludes: ['bread', 'loaf'],
    nameExcludes: ['crouton', 'crumb', 'matzo', 'breadstick', 'pudding', 'meal'],
  },
  {
    concept: 'rice',
    categoryTags: ['en:rices', 'en:white-rices'],
    nameIncludes: ['rice'],
    nameExcludes: ['cake', 'drink', 'milk', 'vinegar', 'noodle', 'paper'],
  },
  {
    concept: 'cereal',
    categoryTags: ['en:breakfast-cereals', 'en:corn-flakes'],
    nameIncludes: ['cereal', 'flakes', 'granola', 'muesli'],
    nameExcludes: ['bar', 'snack'],
  },
  {
    concept: 'yogurt',
    categoryTags: ['en:yogurts', 'en:greek-yogurts'],
    nameIncludes: ['yogurt', 'yoghurt', 'yogurtz'],
    nameExcludes: ['drink', 'spread', 'butter', 'covered'],
  },
  {
    concept: 'oats',
    categoryTags: ['en:rolled-oats', 'en:oat-flakes', 'en:porridge-oats'],
    nameIncludes: ['oat', 'oatmeal', 'porridge'],
    nameExcludes: ['milk', 'drink', 'bar', 'cookie'],
  },
  {
    concept: 'cooking oil',
    categoryTags: ['en:vegetable-oils', 'en:olive-oils', 'en:sunflower-oils'],
    nameIncludes: ['oil'],
    nameExcludes: ['essential', 'motor', 'engine', 'infused', 'spray'],
  },
  {
    concept: 'tomatoes',
    categoryTags: ['en:tomatoes', 'en:canned-tomatoes'],
    nameIncludes: ['tomato'],
    nameExcludes: ['ketchup', 'sauce', 'soup', 'juice', 'paste'],
  },
  {
    concept: 'onions',
    categoryTags: ['en:onions'],
    nameIncludes: ['onion'],
    nameExcludes: ['ring', 'powder', 'soup', 'fried', 'dip'],
  },
  {
    concept: 'bananas',
    categoryTags: ['en:bananas'],
    nameIncludes: ['banana'],
    nameExcludes: ['chip', 'bread', 'flavour', 'flavor', 'dried'],
  },
  {
    concept: 'chicken breast',
    categoryTags: ['en:chicken-breasts', 'en:chicken-meat-preparations'],
    nameIncludes: ['chicken'],
    nameExcludes: ['soup', 'stock', 'broth', 'flavour', 'flavor', 'seasoning', 'nugget'],
  },
];

const BY_CONCEPT = new Map(MAPPINGS.map((mapping) => [mapping.concept, mapping]));

export function mappingForConcept(concept: string): ConceptMapping | undefined {
  return BY_CONCEPT.get(concept.trim().toLowerCase());
}

export function mappedConcepts(): readonly string[] {
  return MAPPINGS.map((mapping) => mapping.concept);
}

export interface ConceptMatch {
  matched: boolean;
  /**
   * How well the product name supports the concept, 0..1. Used to scale
   * observation confidence, never to alter a price.
   */
  strength: number;
  reason: 'name_and_category' | 'name_only' | 'excluded' | 'no_name_evidence';
}

/**
 * Confirms whether a product really is the requested concept.
 *
 * A category hit without name evidence is treated as unmatched: OFF categories
 * are contributor-assigned and demonstrably leak unrelated products.
 */
export function matchConcept(
  concept: string,
  productName: string | undefined,
  categoryTags: readonly string[] = [],
): ConceptMatch {
  const mapping = mappingForConcept(concept);
  if (!mapping) return { matched: false, strength: 0, reason: 'no_name_evidence' };

  const name = (productName ?? '').toLowerCase();
  if (!name) return { matched: false, strength: 0, reason: 'no_name_evidence' };

  if (mapping.nameExcludes.some((token) => name.includes(token))) {
    return { matched: false, strength: 0, reason: 'excluded' };
  }
  if (!mapping.nameIncludes.some((token) => name.includes(token))) {
    return { matched: false, strength: 0, reason: 'no_name_evidence' };
  }

  const categoryConfirms = mapping.categoryTags.some((tag) => categoryTags.includes(tag));
  return categoryConfirms
    ? { matched: true, strength: 1, reason: 'name_and_category' }
    : { matched: true, strength: 0.75, reason: 'name_only' };
}
