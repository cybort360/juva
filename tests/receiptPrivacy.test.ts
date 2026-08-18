import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * Structural privacy guards for receipt data.
 *
 * These assert facts about the source tree rather than runtime behaviour, because the
 * risk is someone wiring a sink to receipt data later.
 *
 * An earlier version of this file asserted that no crash-reporting or push SDK existed
 * at all. Sentry and OneSignal have since been added deliberately, and that assertion
 * firing is what forced the decision to be made explicitly rather than by accident —
 * which was the point of writing it. The rule it encoded has therefore been replaced,
 * not removed: those SDKs may exist, but they may not be reachable from any module
 * that touches receipts, and receipt content may not reach them.
 */

/**
 * The repository root.
 *
 * Resolved from the working directory rather than from this module: the domain
 * suite is compiled to CommonJS into a temporary directory, so a path relative to
 * the built file would point into the build output instead of the source tree these
 * guards need to read.
 */
const root = process.cwd();

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts')) acc.push(full);
  }
  return acc;
}

const appFiles = sourceFiles(path.join(root, 'src'));
const apiFiles = sourceFiles(path.join(root, 'services', 'api', 'src'));
const allFiles = [...appFiles, ...apiFiles];

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/** Third-party sinks a receipt must never reach, whatever else they are used for. */
const SINK_PATTERNS = [
  'onesignal',
  '@sentry',
  'mixpanel',
  'amplitude',
  'posthog',
  'analytics.track',
  'firebase/analytics',
];

/**
 * The only modules allowed to import a telemetry SDK.
 *
 * Keeping the list short is the whole mechanism: an SDK reachable from three files is
 * auditable, one reachable from thirty is not.
 */
const TELEMETRY_OWNERS = [
  'src/services/monitoring.ts',
  'src/services/pushJourneys.ts',
  'src/app/_layout.tsx',
  'src/app/diagnostics.tsx',
];

/** Modules that handle receipt images, lines or reconciliation. */
const RECEIPT_MODULES = [
  'src/services/vision.ts',
  'src/services/receiptImages.ts',
  'src/domain/receipt.ts',
  'src/domain/reconcile.ts',
  'src/components/ReceiptCapture.tsx',
  'src/components/CropOverlay.tsx',
  'src/app/verify.tsx',
  'services/api/src/openrouter.ts',
  'services/api/src/server.ts',
];

test('a telemetry SDK is only imported by the modules that own it', () => {
  const offenders: string[] = [];
  for (const file of allFiles) {
    const relative = path.relative(root, file);
    if (TELEMETRY_OWNERS.includes(relative)) continue;
    const text = read(file);
    for (const sink of SINK_PATTERNS) {
      if (text.includes(sink)) offenders.push(`${relative} → ${sink}`);
    }
  }
  assert.deepEqual(offenders, [], 'telemetry must stay behind its own modules');
});

test('no receipt-handling module can reach a telemetry SDK', () => {
  // The strongest form of the guarantee: not "we are careful with receipt data near
  // Sentry", but "receipt code cannot see Sentry at all".
  for (const relative of RECEIPT_MODULES) {
    const text = read(path.join(root, relative));
    for (const sink of SINK_PATTERNS) {
      assert.equal(
        text.includes(sink),
        false,
        `${relative} references ${sink}; receipt code must not be able to report anything`,
      );
    }
  }
});

test('crash reports are scrubbed by the tested scrubber, not by hand', () => {
  const monitoring = read(path.join(root, 'src', 'services', 'monitoring.ts'));
  assert.ok(monitoring.includes('beforeSend'), 'every event must pass through a transform');
  assert.ok(
    monitoring.includes('scrubEvent'),
    'the transform must be the tested one, not an inline reimplementation',
  );
  // The defaults that make a crash reporter leak are switched off at the source.
  for (const guard of [
    'sendDefaultPii: false',
    'attachScreenshot: false',
    'attachViewHierarchy: false',
  ]) {
    assert.ok(monitoring.includes(guard), `${guard} must be set explicitly`);
  }
});

test('no push tag or journey body can carry shopping content', () => {
  const push = read(path.join(root, 'src', 'services', 'pushJourneys.ts'));
  // Tags are a closed vocabulary of states and counts; a product or store name in one
  // would be published to a third party.
  for (const forbidden of ['productTitle', 'productName', 'retailerName', 'storeName', 'address']) {
    assert.equal(push.includes(forbidden), false, `push must not send ${forbidden}`);
  }
});

test('Sentry is never given an identity', () => {
  // A crash report tied to a person turns a debugging tool into a tracking one.
  // Matches a call, not a mention: the comment explaining that Juva never identifies a
  // user is exactly the documentation this rule wants to encourage.
  for (const file of allFiles) {
    assert.equal(
      /\bsetUser\s*\(/.test(read(file)),
      false,
      `${path.relative(root, file)} identifies a Sentry user`,
    );
  }
});

test('receipt images leave the device through exactly one function', () => {
  // If a second uploader appears, the single audited egress point is no longer the
  // whole story and this test should be the thing that says so.
  const senders = appFiles.filter((file) => {
    const text = read(file);
    return text.includes('data:image/jpeg;base64,') && text.includes('fetch(');
  });
  assert.deepEqual(
    senders.map((file) => path.relative(root, file)),
    ['src/services/vision.ts'],
  );
});

test('the extraction endpoint is the only network destination for receipt data', () => {
  const vision = read(path.join(root, 'src', 'services', 'vision.ts'));
  const urls = vision.match(/fetch\(`?[^`)]*/g) ?? [];
  assert.equal(urls.length, 1, 'one request, one destination');
  assert.ok(
    urls[0]?.includes('/v1/extract/receipt'),
    'receipt images go to the extraction endpoint and nowhere else',
  );
});

test('no receipt image, page URI or extracted line is ever logged', () => {
  const receiptModules = [
    path.join(root, 'src', 'services', 'vision.ts'),
    path.join(root, 'src', 'services', 'receiptImages.ts'),
    path.join(root, 'src', 'domain', 'receipt.ts'),
    path.join(root, 'src', 'domain', 'reconcile.ts'),
    path.join(root, 'services', 'api', 'src', 'openrouter.ts'),
  ];
  for (const file of receiptModules) {
    const text = read(file);
    assert.equal(
      /console\.(log|warn|error|info|debug)/.test(text),
      false,
      `${path.relative(root, file)} must not log: a file path or a line is enough to expose a receipt`,
    );
  }
});

test('the OpenRouter credential exists only on the server', () => {
  for (const file of appFiles) {
    assert.equal(
      read(file).includes('OPENROUTER_API_KEY'),
      false,
      `${path.relative(root, file)} references the provider key; extraction is server-side only`,
    );
  }
  const server = read(path.join(root, 'services', 'api', 'src', 'openrouter.ts'));
  assert.ok(server.includes('process.env.OPENROUTER_API_KEY'));
});

test('the API never writes an uploaded receipt to disk', () => {
  const server = read(path.join(root, 'services', 'api', 'src', 'server.ts'));
  const openrouter = read(path.join(root, 'services', 'api', 'src', 'openrouter.ts'));
  for (const [name, text] of [
    ['server.ts', server],
    ['openrouter.ts', openrouter],
  ] as const) {
    assert.equal(
      /writeFile|createWriteStream|mkdtemp|tmpdir/.test(text),
      false,
      `${name} must not persist an upload; the images live in the request and nowhere else`,
    );
  }
});

test('the extraction schema gives the model no way to express a saving', () => {
  const schema = read(path.join(root, 'services', 'api', 'src', 'schemas.ts'));
  for (const forbidden of ['saving', 'savings', 'verdict', 'recommend', 'overcharge', 'fraud']) {
    // Prose in comments is fine; a schema property is not.
    const asProperty = new RegExp(`\\b${forbidden}[A-Za-z]*\\s*:\\s*\\{`, 'i');
    assert.equal(
      asProperty.test(schema),
      false,
      `the schema must not contain a "${forbidden}" field for the model to fill in`,
    );
  }
  assert.ok(
    schema.includes('additionalProperties: false'),
    'the model must not be able to add fields of its own',
  );
});
