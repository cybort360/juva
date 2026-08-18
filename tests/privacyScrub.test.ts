import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REDACTED,
  allowlistedKeys,
  isDeniedKey,
  looksSensitive,
  scrubBreadcrumb,
  scrubEvent,
  scrubString,
  scrubUrl,
  scrubValue,
} from '../src/services/privacyScrub';

/** Everything the brief says must be aggressively removed, as it would really appear. */
const REAL_LEAKS = {
  exactLocation: 'planning around 40.70231, -73.98745',
  receiptLine: 'line WHL MLK 1GAL charged $3.49',
  productName: 'Boneless Chicken Breast',
  barcode: 'scanned 0001112223334',
  loyaltyId: 'member 90210447281',
  imagePath: 'file:///var/mobile/Containers/juva-receipts/page-1.jpg',
  openRouterOutput: 'model returned {"totalCents":5900}',
  email: 'contact adedeji@example.com',
};

test('a coordinate is treated as sensitive', () => {
  assert.equal(looksSensitive(REAL_LEAKS.exactLocation), true);
  assert.equal(looksSensitive('40.70231, -73.98745'), true);
});

test('a money figure is treated as sensitive', () => {
  assert.equal(looksSensitive(REAL_LEAKS.receiptLine), true);
  assert.equal(looksSensitive('$3.49'), true);
  assert.equal(looksSensitive('₦2500'), true);
});

test('a long digit run — barcode, loyalty id, card fragment — is sensitive', () => {
  assert.equal(looksSensitive(REAL_LEAKS.barcode), true);
  assert.equal(looksSensitive(REAL_LEAKS.loyaltyId), true);
});

test('a local file path is sensitive', () => {
  assert.equal(looksSensitive(REAL_LEAKS.imagePath), true);
  assert.equal(looksSensitive('ph://ABC-123'), true);
});

test('an email address is sensitive', () => {
  assert.equal(looksSensitive(REAL_LEAKS.email), true);
});

test('an ordinary diagnostic string survives', () => {
  assert.equal(scrubString('optimizer finished'), 'optimizer finished');
  assert.equal(scrubString('adapter open_prices timed out'), 'adapter open_prices timed out');
  assert.equal(scrubString('stage 3 of 5'), 'stage 3 of 5');
});

test('a sensitive string is replaced whole, not masked in place', () => {
  // Masking would leave "failed to price [x] at [y]", which still leaks the shape of
  // the basket.
  assert.equal(scrubString(REAL_LEAKS.receiptLine), REDACTED);
  assert.equal(scrubString(REAL_LEAKS.exactLocation), REDACTED);
});

test('a denied key is removed regardless of its value', () => {
  const scrubbed = scrubValue({
    productName: 'Whole Milk',
    barcode: '1',
    loyaltyId: 'x',
    receiptTotal: 1,
    imageUri: 'a',
    latitude: 1,
    prompt: 'hi',
  }) as Record<string, unknown>;
  for (const key of Object.keys(scrubbed)) {
    assert.equal(scrubbed[key], REDACTED, `${key} must not survive`);
  }
});

test('an unrecognised key is dropped even when it looks harmless', () => {
  // Deny-by-default: guessing wrong here uploads someone's shopping.
  const scrubbed = scrubValue({ somethingNew: 'plain text' }) as Record<string, unknown>;
  assert.equal(scrubbed.somethingNew, REDACTED);
});

test('allowlisted diagnostic keys survive with their values', () => {
  const scrubbed = scrubValue({
    screen: 'plan',
    stage: 'optimize',
    lineCount: 6,
    storeCount: 2,
    hasPlus: false,
    marketMode: 'demo',
    durationMs: 412,
  }) as Record<string, unknown>;
  assert.equal(scrubbed.screen, 'plan');
  assert.equal(scrubbed.lineCount, 6);
  assert.equal(scrubbed.storeCount, 2);
  assert.equal(scrubbed.hasPlus, false);
  assert.equal(scrubbed.durationMs, 412);
});

test('the allowlist never contradicts the denylist', () => {
  // Deny is checked first, so an allowlisted key matching the deny pattern would be
  // silently dropped while claiming to survive. `itemCount` was exactly that bug.
  const contradictions = allowlistedKeys().filter((key) => isDeniedKey(key));
  assert.deepEqual(contradictions, [], 'these keys claim to survive but are denied');
});

test('an allowlisted key still loses a sensitive value', () => {
  const scrubbed = scrubValue({ reason: REAL_LEAKS.exactLocation }) as Record<string, unknown>;
  assert.equal(scrubbed.reason, REDACTED, 'the key is allowed; the value is not');
});

test('nesting cannot smuggle a denied key through', () => {
  const scrubbed = scrubValue({
    screen: 'plan',
    // `contexts` is not allowlisted, so the whole subtree goes.
    contexts: { basket: { productName: 'Whole Milk' } },
  }) as Record<string, unknown>;
  assert.equal(scrubbed.contexts, REDACTED);
});

test('array length is kept while contents are scrubbed', () => {
  const scrubbed = scrubValue(['optimizer finished', REAL_LEAKS.productName]) as unknown[];
  assert.equal(scrubbed.length, 2, 'how many there were is useful and harmless');
  assert.equal(scrubbed[0], 'optimizer finished');
});

test('recursion is bounded rather than following a cycle forever', () => {
  let deep: Record<string, unknown> = { screen: 'plan' };
  for (let i = 0; i < 12; i += 1) deep = { screen: 'plan', nested: deep };
  assert.doesNotThrow(() => scrubValue(deep));
});

test('a url keeps its host and loses its identifiers', () => {
  assert.equal(
    scrubUrl('https://api.juva.app/v1/market/search?postalCode=11201&concepts=milk'),
    'https://api.juva.app/v1/market/search',
  );
  assert.equal(
    scrubUrl('https://api.juva.app/v1/stores/12345/prices'),
    'https://api.juva.app/v1/stores/:id/prices',
  );
});

test('an unparseable url is dropped rather than passed through', () => {
  assert.equal(scrubUrl('not a url at all'), REDACTED);
});

test('user identity and device hostname never leave', () => {
  const scrubbed = scrubEvent({
    user: { id: 'juva_abc', email: 'a@b.com' },
    server_name: "Adedeji's iPhone",
    message: 'crashed',
  });
  assert.equal('user' in scrubbed, false);
  assert.equal('server_name' in scrubbed, false);
});

test('a request body is dropped outright, never inspected and kept', () => {
  // The body is where a receipt payload appears; there is no version of this worth
  // uploading.
  const scrubbed = scrubEvent({
    request: {
      url: 'https://api.juva.app/v1/extract/receipt?x=1',
      data: { images: ['data:image/jpeg;base64,AAAA'] },
      headers: { Authorization: 'Bearer sk-abc' },
      query_string: 'x=1',
    },
  });
  const request = scrubbed.request as Record<string, unknown>;
  assert.equal(request.data, REDACTED);
  assert.equal(request.headers, REDACTED);
  assert.equal(request.query_string, REDACTED);
  assert.equal(request.url, 'https://api.juva.app/v1/extract/receipt');
});

test('an exception keeps its stack but loses a sensitive message', () => {
  const scrubbed = scrubEvent({
    exception: {
      values: [
        {
          type: 'Error',
          value: `could not price ${REAL_LEAKS.productName} at $4.99`,
          stacktrace: { frames: [{ function: 'optimizeBasket' }] },
        },
      ],
    },
  });
  const values = (scrubbed.exception as { values: Record<string, unknown>[] }).values;
  assert.equal(values[0]?.value, REDACTED);
  assert.ok(values[0]?.stacktrace, 'the stack is why crash reporting exists');
  assert.equal(values[0]?.type, 'Error');
});

test('breadcrumbs keep their shape and lose their payload', () => {
  const crumb = scrubBreadcrumb({
    type: 'http',
    category: 'fetch',
    level: 'info',
    timestamp: 1,
    message: REAL_LEAKS.receiptLine,
    data: { productName: 'Whole Milk', screen: 'verify' },
  }) as Record<string, unknown>;
  assert.equal(crumb.category, 'fetch');
  assert.equal(crumb.level, 'info');
  assert.equal(crumb.message, REDACTED);
  const data = crumb.data as Record<string, unknown>;
  assert.equal(data.productName, REDACTED);
  assert.equal(data.screen, 'verify');
});

test('every named leak category is removed from a realistic event', () => {
  const scrubbed = scrubEvent({
    message: REAL_LEAKS.openRouterOutput,
    extra: { ...REAL_LEAKS, screen: 'verify' },
    tags: { barcode: REAL_LEAKS.barcode, environment: 'production' },
    breadcrumbs: [{ category: 'nav', message: REAL_LEAKS.imagePath }],
  });

  const serialized = JSON.stringify(scrubbed);
  for (const [label, leak] of Object.entries(REAL_LEAKS)) {
    assert.equal(
      serialized.includes(leak),
      false,
      `${label} survived scrubbing and would have been uploaded`,
    );
  }
  // The useful parts are still there.
  const extra = scrubbed.extra as Record<string, unknown>;
  assert.equal(extra.screen, 'verify');
  assert.equal((scrubbed.tags as Record<string, unknown>).environment, 'production');
});

test('an unknown future field carrying user content does not pass through', () => {
  // Carried across by allowlist, so a new SDK field is not shipped by default.
  const scrubbed = scrubEvent({ extra: { futureField: REAL_LEAKS.productName } });
  assert.equal(JSON.stringify(scrubbed).includes(REAL_LEAKS.productName), false);
});
