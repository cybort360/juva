import assert from 'node:assert/strict';
import test from 'node:test';

import { observedAgo, sourceLabel } from '../src/utils/observedAgo';

const NOW = new Date('2026-08-17T12:00:00.000Z');
const ago = (ms: number) => observedAgo(new Date(NOW.getTime() - ms).toISOString(), NOW);

test('a very recent observation reads as just now', () => {
  assert.equal(ago(10_000), 'checked just now');
});

test('minutes, hours, days and months are reported at their own scale', () => {
  assert.equal(ago(18 * 60_000), 'checked 18 min ago');
  assert.equal(ago(3 * 3_600_000), 'checked 3 hours ago');
  assert.equal(ago(2 * 86_400_000), 'checked 2 days ago');
  assert.equal(ago(75 * 86_400_000), 'checked 2 months ago');
});

test('singular units are not pluralised', () => {
  assert.equal(ago(3_600_000), 'checked 1 hour ago');
  assert.equal(ago(86_400_000), 'checked 1 day ago');
});

test('elapsed time is never rounded up into sounding fresher', () => {
  // 59 minutes must not become "1 hour ago", which reads as older, but 119 minutes must not
  // become "2 hours" either — flooring keeps every claim conservative.
  assert.equal(ago(59 * 60_000), 'checked 59 min ago');
  assert.equal(ago(119 * 60_000), 'checked 1 hour ago');
});

test('a future timestamp is never described as fresh', () => {
  // A source clock error must not manufacture a "just now" price.
  assert.equal(
    observedAgo(new Date(NOW.getTime() + 60_000).toISOString(), NOW),
    'checked at an unknown time',
  );
});

test('an unparseable timestamp says so rather than guessing', () => {
  assert.equal(observedAgo('not a date', NOW), 'checked at an unknown time');
  assert.equal(observedAgo('', NOW), 'checked at an unknown time');
});

test('every source kind has an honest label', () => {
  assert.equal(sourceLabel('retailer_api'), 'Retailer API');
  assert.equal(sourceLabel('community_feed'), 'Community-contributed');
  assert.equal(sourceLabel('demo'), 'Demo data');
  // An unknown source must never be dressed up as a retailer feed.
  assert.equal(sourceLabel('something_new'), 'Unknown source');
});
