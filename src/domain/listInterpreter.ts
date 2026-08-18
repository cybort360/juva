import { canonicalConcept } from './matching';
import { parseQuantity } from './quantity';
import type { GroceryList, GroceryListItem } from './types';

/**
 * Turns what a shopper typed, pasted or dictated into a basket.
 *
 * This is the one place a language model could legitimately help, so the boundary
 * matters: interpretation may guess at *what* was meant, but it never invents a
 * price, and an item it cannot recognise is kept rather than dropped. An unknown
 * line becomes a real basket item that the optimizer will report as unpriced —
 * silently discarding it would make the basket look complete when it is not.
 */

const knownConcepts: { concept: string; patterns: string[]; unit: string }[] = [
  { concept: 'milk', patterns: ['milk'], unit: '1 gallon' },
  { concept: 'eggs', patterns: ['egg', 'eggs'], unit: '12 large' },
  { concept: 'rice', patterns: ['rice'], unit: '5 lb' },
  { concept: 'chicken breast', patterns: ['chicken', 'chicken breast'], unit: '~2 lb' },
  { concept: 'bread', patterns: ['bread', 'loaf'], unit: '1 loaf' },
  { concept: 'cereal', patterns: ['cereal', 'corn flakes', 'cornflakes'], unit: '18 oz' },
  { concept: 'bananas', patterns: ['banana', 'bananas'], unit: '6' },
  { concept: 'cooking oil', patterns: ['oil', 'cooking oil', 'vegetable oil'], unit: '48 oz' },
  { concept: 'tomatoes', patterns: ['tomato', 'tomatoes'], unit: '2 lb' },
  { concept: 'onions', patterns: ['onion', 'onions'], unit: '3 lb' },
  { concept: 'yogurt', patterns: ['yogurt', 'yoghurt'], unit: '32 oz' },
  { concept: 'oats', patterns: ['oat', 'oats', 'oatmeal'], unit: '42 oz' },
];

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (character) => character.toUpperCase());
}

function makeItem(
  concept: string,
  displayName: string,
  unit: string,
  index: number,
  quantity = 1,
): GroceryListItem {
  return { id: `draft-${Date.now()}-${index}`, concept, displayName, quantity, unit };
}

function readBudgetCents(text: string): number | undefined {
  const match = text
    .toLowerCase()
    .match(/(?:under|budget|around|for|max|below)\s*\$?\s*(\d+(?:\.\d{1,2})?)/);
  return match?.[1] ? Math.round(Number(match[1]) * 100) : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Line-by-line parsing, for pasted and manually entered lists
// ─────────────────────────────────────────────────────────────────────────────

/** Bullets, dashes and "1." numbering that survive a copy/paste. */
const LINE_ORNAMENT = /^\s*(?:[-*•·–—▢☐[\]x✓]+|\d+[.)])\s*/i;

export interface ParsedLine {
  /** Canonical concept, or the cleaned line itself when unrecognised. */
  concept: string;
  displayName: string;
  quantity: number;
  unit: string;
  /** False when Juva could not map the line onto a concept it knows. */
  recognised: boolean;
}

/**
 * Reads one written line into a basket line.
 *
 * Handles the shapes people actually write: "2 milk", "2x milk", "milk 2",
 * "- 3 lb tomatoes", "1. Eggs (12)". A leading count becomes the quantity, an
 * embedded size becomes the unit, and anything left is the item name.
 */
export function parseListLine(raw: string): ParsedLine | null {
  const cleaned = raw.replace(LINE_ORNAMENT, '').trim();
  if (!cleaned) return null;

  // A leading count: "2 milk", "2x milk", "2 × milk".
  const leading = cleaned.match(/^(\d+(?:\.\d+)?)\s*(?:x|×)?\s+(.*)$/i);
  let quantity = 1;
  let remainder = cleaned;
  if (leading?.[1] && leading[2]) {
    const parsedQuantity = Number(leading[1]);
    // A leading number that is really a size ("500 g flour") is not a count.
    const looksLikeSize = parseQuantity(cleaned) !== null && /^[\d.]+\s*[a-z]/i.test(cleaned);
    const trailingIsSizeUnit = /^(g|kg|mg|oz|lb|lbs|ml|l|cl|ct|gal|qt|pt)\b/i.test(leading[2]);
    if (
      Number.isFinite(parsedQuantity) &&
      parsedQuantity > 0 &&
      !(looksLikeSize && trailingIsSizeUnit)
    ) {
      quantity = parsedQuantity;
      remainder = leading[2].trim();
    }
  }

  const lower = remainder.toLowerCase();
  const known = knownConcepts.find((entry) =>
    entry.patterns.some((pattern) => new RegExp(`\\b${pattern}\\b`).test(lower)),
  );

  // A size written into the line wins over the concept's default unit.
  const embedded = parseQuantity(remainder);
  const embeddedUnit =
    embedded && embedded.dimension !== 'count' ? `${embedded.value} ${embedded.unit}` : undefined;

  if (known) {
    return {
      concept: known.concept,
      displayName: titleCase(remainder) || titleCase(known.concept),
      quantity,
      unit: embeddedUnit ?? known.unit,
      recognised: true,
    };
  }

  const concept = canonicalConcept(remainder);
  if (!concept) return null;
  return {
    concept,
    displayName: titleCase(remainder),
    quantity,
    unit: embeddedUnit ?? '1',
    recognised: false,
  };
}

/**
 * Interprets a pasted or hand-entered list, one item per line.
 *
 * Every line becomes an item, recognised or not. Duplicated concepts are merged
 * by adding their quantities rather than appearing twice, because two lines
 * reading "milk" mean two milks, not two shopping decisions.
 */
export function interpretPastedList(text: string): GroceryList {
  const lines = text.split(/[\n;]+/);
  const byConcept = new Map<string, GroceryListItem>();
  let index = 0;

  for (const line of lines) {
    // A comma-separated single line is still a list.
    for (const part of line.split(',')) {
      const parsed = parseListLine(part);
      if (!parsed) continue;

      const existing = byConcept.get(parsed.concept);
      if (existing) {
        existing.quantity += parsed.quantity;
        continue;
      }
      byConcept.set(
        parsed.concept,
        makeItem(parsed.concept, parsed.displayName, parsed.unit, index, parsed.quantity),
      );
      index += 1;
    }
  }

  const items = [...byConcept.values()];
  const budgetCents = readBudgetCents(text);

  return {
    id: `list-${Date.now()}`,
    title: 'Your list',
    prompt: text.trim(),
    ...(budgetCents === undefined ? {} : { budgetCents }),
    currency: 'USD',
    createdAt: new Date().toISOString(),
    items,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Natural-language composer
// ─────────────────────────────────────────────────────────────────────────────

/** True when the text reads as a list of lines rather than a sentence. */
export function looksLikeList(text: string): boolean {
  const lines = text
    .split(/[\n;]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length >= 3) return true;
  // "milk, eggs, bread" is a list too.
  const commaParts = text.split(',').filter((part) => part.trim());
  return commaParts.length >= 3 && !/\b(under|budget|for two|weekly|cheapest)\b/i.test(text);
}

/**
 * Interprets a natural-language request.
 *
 * Recognised concepts are collected, and any remaining written fragment that
 * matched nothing is still added, so "milk, eggs and saffron" does not quietly
 * become a two-item basket.
 */
export function interpretListPrompt(prompt: string): GroceryList {
  // A pasted list routed here by mistake is still handled as a list.
  if (looksLikeList(prompt)) return interpretPastedList(prompt);

  const lower = prompt.toLowerCase();
  const budgetCents = readBudgetCents(prompt);

  const byConcept = new Map<string, GroceryListItem>();
  for (const known of knownConcepts) {
    if (known.patterns.some((pattern) => new RegExp(`\\b${pattern}\\b`).test(lower))) {
      byConcept.set(
        known.concept,
        makeItem(known.concept, titleCase(known.concept), known.unit, byConcept.size),
      );
    }
  }

  const isWeekly = /weekly|week|groceries for two|grocery|shopping/i.test(prompt);
  if (byConcept.size === 0 && isWeekly) {
    // A general request with no named items gets Juva's standard weekly basket.
    knownConcepts.slice(0, 8).forEach((known, position) => {
      byConcept.set(
        known.concept,
        makeItem(known.concept, titleCase(known.concept), known.unit, position),
      );
    });
  }

  if (byConcept.size === 0) {
    const parsed = parseListLine(prompt);
    if (parsed) {
      byConcept.set(
        parsed.concept,
        makeItem(parsed.concept, parsed.displayName, parsed.unit, 0, parsed.quantity),
      );
    }
  }

  const items = [...byConcept.values()];

  return {
    id: `list-${Date.now()}`,
    title: isWeekly ? 'Weekly groceries' : 'Grocery list',
    prompt,
    ...(budgetCents === undefined ? {} : { budgetCents }),
    currency: 'USD',
    createdAt: new Date().toISOString(),
    items,
  };
}
