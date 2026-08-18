import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decimalToCents } from '../src/utils/money';

test('parses plain decimal amounts into integer cents', () => {
  assert.equal(decimalToCents('12.34'), 1234);
  assert.equal(decimalToCents('0.05'), 5);
  assert.equal(decimalToCents('80'), 8000);
});

test('tolerates currency symbols, spaces and separators', () => {
  assert.equal(decimalToCents('$12.34'), 1234);
  assert.equal(decimalToCents(' 12.34 '), 1234);
  assert.equal(decimalToCents('£7.50'), 750);
});

test('rounds to the nearest cent rather than truncating', () => {
  assert.equal(decimalToCents('12.345'), 1235);
  assert.equal(decimalToCents('12.344'), 1234);
});

test('avoids binary floating point drift on classic cases', () => {
  assert.equal(decimalToCents('1.15'), 115);
  assert.equal(decimalToCents('4.35'), 435);
  assert.equal(decimalToCents('1.005'), 101);
});

test('rejects anything that is not a usable positive amount', () => {
  assert.equal(decimalToCents(''), null);
  assert.equal(decimalToCents('abc'), null);
  assert.equal(decimalToCents('-5.00'), null);
  assert.equal(decimalToCents('.'), null);
});
