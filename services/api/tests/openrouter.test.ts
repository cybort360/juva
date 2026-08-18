import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { extractionEndpoint } from '../src/openrouter.js';

const original = process.env.OPENROUTER_BASE_URL;

afterEach(() => {
  if (original === undefined) delete process.env.OPENROUTER_BASE_URL;
  else process.env.OPENROUTER_BASE_URL = original;
});

test('an unset base URL falls back to OpenRouter', () => {
  delete process.env.OPENROUTER_BASE_URL;
  const { baseUrl, isOpenRouter } = extractionEndpoint();
  assert.equal(baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(isOpenRouter, true);
});

test('an empty base URL counts as unset rather than throwing', () => {
  // `??` only falls back on null/undefined, so a bare `OPENROUTER_BASE_URL=` line — which
  // is exactly what `.env.example` ships — produced an empty string, then `new URL('')`
  // threw `Invalid URL` and broke receipt extraction for anyone who copied the example
  // file without editing it.
  process.env.OPENROUTER_BASE_URL = '';
  assert.doesNotThrow(() => extractionEndpoint());
  assert.equal(extractionEndpoint().baseUrl, 'https://openrouter.ai/api/v1');
});

test('a whitespace-only base URL also counts as unset', () => {
  process.env.OPENROUTER_BASE_URL = '   ';
  assert.equal(extractionEndpoint().baseUrl, 'https://openrouter.ai/api/v1');
});

test('a trailing slash is trimmed so the path is never doubled', () => {
  process.env.OPENROUTER_BASE_URL = 'https://example.test/v1///';
  assert.equal(extractionEndpoint().baseUrl, 'https://example.test/v1');
});

test('a non-OpenRouter host is recognised as such', () => {
  // This is what gates `require_parameters` and the attribution headers: sending either to
  // a host that does not understand them is a rejected request.
  process.env.OPENROUTER_BASE_URL = 'https://opencode.ai/zen/go/v1';
  const { baseUrl, isOpenRouter } = extractionEndpoint();
  assert.equal(baseUrl, 'https://opencode.ai/zen/go/v1');
  assert.equal(isOpenRouter, false);
});

test('a lookalike hostname is not mistaken for OpenRouter', () => {
  // Substring matching would accept `openrouter.ai.evil.test`, and with it the assumption
  // that the schema is enforced.
  process.env.OPENROUTER_BASE_URL = 'https://openrouter.ai.evil.test/v1';
  assert.equal(extractionEndpoint().isOpenRouter, false);
});

test('an OpenRouter subdomain is still OpenRouter', () => {
  process.env.OPENROUTER_BASE_URL = 'https://api.openrouter.ai/api/v1';
  assert.equal(extractionEndpoint().isOpenRouter, true);
});
