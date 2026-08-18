import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  interpretListPrompt,
  interpretPastedList,
  looksLikeList,
} from '../src/domain/listInterpreter';

test('picks up the concepts named in the prompt', () => {
  const list = interpretListPrompt('Milk, eggs, rice, chicken, bread, cereal');
  const concepts = list.items.map((item) => item.concept);
  for (const expected of ['milk', 'eggs', 'rice', 'chicken breast', 'bread', 'cereal']) {
    assert.ok(concepts.includes(expected), `expected ${expected}`);
  }
});

test('reads a budget when one is stated', () => {
  assert.equal(interpretListPrompt('Weekly groceries for two under $80').budgetCents, 8000);
  assert.equal(interpretListPrompt('groceries around $42.50').budgetCents, 4250);
});

test('omits the budget entirely when none is stated', () => {
  const list = interpretListPrompt('Milk and eggs');
  assert.equal('budgetCents' in list, false, 'no invented budget');
});

test('a weekly prompt produces a full starter basket', () => {
  const list = interpretListPrompt('Weekly groceries for two');
  assert.equal(list.title, 'Weekly groceries');
  assert.ok(list.items.length >= 5);
});

test('item ids are unique within a list', () => {
  const list = interpretListPrompt('Milk, eggs, rice, bread, cereal, bananas');
  assert.equal(new Set(list.items.map((item) => item.id)).size, list.items.length);
});

test('an unrecognised request keeps what was written rather than dropping it', () => {
  // The item stays in the basket and the optimizer reports it as unpriced, which
  // is honest; guessing a substitute would not be.
  const list = interpretListPrompt('something completely unrelated');
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0]?.displayName, 'Something Completely Unrelated');
});

test('an empty request invents no basket', () => {
  // The composer blocks empty submission; if one arrives anyway, Juva returns
  // nothing rather than a basket the shopper never asked for.
  assert.deepEqual(interpretListPrompt('').items, []);
  assert.deepEqual(interpretListPrompt('   ').items, []);
});

test('quantities and units are always populated', () => {
  for (const item of interpretListPrompt('Weekly groceries').items) {
    assert.ok(item.quantity >= 1);
    assert.ok(item.unit.length > 0);
    assert.ok(item.displayName.length > 0);
  }
});

// ── Pasted and hand-entered lists ───────────────────────────────────────────

test('a pasted list becomes one item per line', () => {
  const list = interpretPastedList('Milk\nEggs\nBread');
  assert.deepEqual(
    list.items.map((item) => item.concept),
    ['milk', 'eggs', 'bread'],
  );
});

test('an unrecognised line is kept, not silently dropped', () => {
  // The old behaviour matched known concepts and discarded the rest, which made a
  // basket look complete when the shopper had asked for more.
  const list = interpretPastedList('Milk\nSaffron threads\nEggs');
  const concepts = list.items.map((item) => item.concept);
  assert.equal(list.items.length, 3);
  assert.ok(concepts.includes('saffron threads'), 'the unknown line survives');
});

test('copy-paste ornaments are stripped', () => {
  for (const line of ['- Milk', '* Milk', '1. Milk', '• Milk', '[ ] Milk', '☐ Milk']) {
    const list = interpretPastedList(line);
    assert.equal(list.items[0]?.concept, 'milk', line);
  }
});

test('a leading count becomes the quantity', () => {
  assert.equal(interpretPastedList('2 milk').items[0]?.quantity, 2);
  assert.equal(interpretPastedList('3x eggs').items[0]?.quantity, 3);
  assert.equal(interpretPastedList('2 × bread').items[0]?.quantity, 2);
  assert.equal(interpretPastedList('milk').items[0]?.quantity, 1);
});

test('a leading size is a size, not a count', () => {
  const item = interpretPastedList('500 g rice').items[0];
  assert.equal(item?.quantity, 1, '500 is the size, not five hundred bags');
  assert.equal(item?.unit, '500 g');
});

test('an embedded size overrides the default unit', () => {
  const item = interpretPastedList('tomatoes 5 lb').items[0];
  assert.equal(item?.concept, 'tomatoes');
  assert.equal(item?.unit, '5 lb', 'the written size wins over the 2 lb default');
});

test('repeated lines merge into one item with a summed quantity', () => {
  const list = interpretPastedList('Milk\n2 milk');
  assert.equal(list.items.length, 1, 'two lines of milk is one shopping decision');
  assert.equal(list.items[0]?.quantity, 3);
});

test('a comma-separated line is still a list', () => {
  const list = interpretPastedList('milk, eggs, bread');
  assert.equal(list.items.length, 3);
});

test('a pasted list reads a budget when one is written into it', () => {
  assert.equal(interpretPastedList('milk\neggs\nbudget $40').budgetCents, 4000);
});

test('list-shaped text typed into the composer is treated as a list', () => {
  assert.equal(looksLikeList('milk\neggs\nbread'), true);
  assert.equal(looksLikeList('milk, eggs, bread'), true);
  assert.equal(looksLikeList('Weekly groceries for two under $80'), false);

  // Routed through the composer, an unknown line still survives.
  const list = interpretListPrompt('milk\nsaffron\neggs');
  assert.equal(list.items.length, 3);
});

test('a natural-language request no longer drops an unmatched item', () => {
  const list = interpretListPrompt('I need milk and eggs for the week');
  const concepts = list.items.map((item) => item.concept);
  assert.ok(concepts.includes('milk'));
  assert.ok(concepts.includes('eggs'));
});

test('a bare word does not match a longer concept by accident', () => {
  // "oil" must not be found inside "boiling", which substring matching would do.
  const list = interpretListPrompt('boiling water');
  assert.ok(!list.items.some((item) => item.concept === 'cooking oil'));
});

test('every parsed line yields a usable quantity and unit', () => {
  const list = interpretPastedList('2 milk\n- 3 lb tomatoes\n1. Eggs\nSaffron');
  for (const item of list.items) {
    assert.ok(item.quantity >= 1, item.displayName);
    assert.ok(item.unit.length > 0, item.displayName);
    assert.ok(item.displayName.length > 0);
    assert.ok(item.concept.length > 0);
  }
});

test('blank and ornament-only lines are ignored', () => {
  const list = interpretPastedList('Milk\n\n   \n-\nEggs');
  assert.equal(list.items.length, 2);
});
