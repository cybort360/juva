#!/usr/bin/env node
/**
 * Reports what is configured, what each value unlocks, and what is still blocked.
 *
 * Never prints a value — only whether it is set, and for keys a short prefix so you can
 * tell a `test_` key from an `appl_` one without exposing the secret. Safe to run and
 * paste anywhere.
 *
 * Exits 0 always: nothing here is a failure. Juva runs with none of it set, and that is
 * the point. This is a map, not a gate — `npm run validate` is the gate.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function readEnv(file) {
  try {
    const text = readFileSync(path.join(root, file), 'utf8');
    const out = new Map();
    for (const line of text.split('\n')) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (match?.[1] !== undefined) out.set(match[1], (match[2] ?? '').trim());
    }
    return out;
  } catch {
    return undefined;
  }
}

const app = readEnv('.env');
const api = readEnv('services/api/.env');

/** Masks a value: shows a prefix for keys so the flavour is visible, never the secret. */
function show(value, { key = false, fileExists = true } = {}) {
  // Distinguish a missing file from a key absent within an existing file: the fix differs.
  if (value === undefined) return fileExists ? 'not in file' : 'file missing';
  if (value.length === 0) return 'empty';
  if (key) return `set (${value.slice(0, 5)}…, ${value.length} chars)`;
  return `set (${value})`;
}

const GREEN = '[32m';
const AMBER = '[33m';
const DIM = '[2m';
const RESET = '[0m';

function section(title) {
  console.log(`\n${title}`);
  console.log('─'.repeat(title.length));
}

function row(name, value, unlocks, { key = false, required = false, fileExists = true } = {}) {
  const set = value !== undefined && value.length > 0;
  const mark = set ? `${GREEN}●${RESET}` : `${AMBER}○${RESET}`;
  console.log(`${mark} ${name.padEnd(38)} ${show(value, { key, fileExists })}`);
  if (!set) console.log(`  ${DIM}└ ${required ? 'REQUIRED for' : 'unlocks'}: ${unlocks}${RESET}`);
}

console.log('Juva environment');
console.log('Nothing below is required to run the app. Each line adds a capability.');

section('App — .env  (EXPO_PUBLIC_* is inlined into the bundle and PUBLIC)');
if (!app) console.log(`${AMBER}.env is missing. Copy .env.example to .env.${RESET}`);
row('EXPO_PUBLIC_JUVA_ENV', app?.get('EXPO_PUBLIC_JUVA_ENV'), 'profile selection');
row('EXPO_PUBLIC_MARKET_MODE', app?.get('EXPO_PUBLIC_MARKET_MODE'), 'demo vs remote prices');
row(
  'EXPO_PUBLIC_API_BASE_URL',
  app?.get('EXPO_PUBLIC_API_BASE_URL'),
  'real prices + receipt reading',
);
row(
  'EXPO_PUBLIC_REVENUECAT_TEST_API_KEY',
  app?.get('EXPO_PUBLIC_REVENUECAT_TEST_API_KEY'),
  'purchases in demo/development',
  { key: true },
);
row(
  'EXPO_PUBLIC_REVENUECAT_IOS_API_KEY',
  app?.get('EXPO_PUBLIC_REVENUECAT_IOS_API_KEY'),
  'real App Store billing (preview/production)',
  { key: true },
);
row(
  'EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY',
  app?.get('EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY'),
  'real Play billing (preview/production)',
  { key: true },
);
row(
  'EXPO_PUBLIC_SENTRY_DSN',
  app?.get('EXPO_PUBLIC_SENTRY_DSN'),
  'crash + performance monitoring',
  { fileExists: app !== undefined },
);
row(
  'EXPO_PUBLIC_ONESIGNAL_APP_ID',
  app?.get('EXPO_PUBLIC_ONESIGNAL_APP_ID'),
  'lifecycle push (needs a dev build)',
  { fileExists: app !== undefined },
);

section('API — services/api/.env  (secrets live here only)');
if (!api)
  console.log(`${AMBER}services/api/.env is missing. Copy services/api/.env.example.${RESET}`);
row(
  'JUVA_RETAILER_ADAPTERS',
  api?.get('JUVA_RETAILER_ADAPTERS'),
  'real prices — without it /v1/market/search returns 503',
);
row(
  'JUVA_CONTACT_USER_AGENT',
  api?.get('JUVA_CONTACT_USER_AGENT'),
  'OpenStreetMap access — anonymous traffic is blocked',
  { required: true },
);
row(
  'OPENROUTER_API_KEY',
  api?.get('OPENROUTER_API_KEY'),
  'reading receipt photos (typed totals work without it)',
  { key: true },
);
row(
  'OPENROUTER_MODEL',
  api?.get('OPENROUTER_MODEL'),
  'reading receipt photos — needs image + json_schema support',
);

/** Consequences, derived rather than restated, so this cannot drift from the values above. */
section('What this configuration means right now');

const env = app?.get('EXPO_PUBLIC_JUVA_ENV') ?? 'development';
const mode = app?.get('EXPO_PUBLIC_MARKET_MODE') ?? 'demo';
const notes = [];

if (env === 'demo') {
  notes.push('Profile is `demo`, which forces the demo market — MARKET_MODE is ignored.');
  notes.push('Set EXPO_PUBLIC_JUVA_ENV=development to let MARKET_MODE=remote take effect.');
} else if (mode === 'remote') {
  notes.push('Remote market is active: prices come from the API, labelled by freshness.');
} else {
  notes.push('Demo market is active: every price is fictional and labelled DEMO.');
}

const hasTest = (app?.get('EXPO_PUBLIC_REVENUECAT_TEST_API_KEY') ?? '').length > 0;
const hasStore =
  (app?.get('EXPO_PUBLIC_REVENUECAT_IOS_API_KEY') ?? '').length > 0 ||
  (app?.get('EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY') ?? '').length > 0;
if (hasTest && (env === 'demo' || env === 'development')) {
  notes.push('Purchases use the RevenueCat Test Store: simulated, no money, no payment method.');
}
if (!hasStore)
  notes.push('No store key, so preview/production builds ship with purchases DISABLED.');
if ((api?.get('OPENROUTER_API_KEY') ?? '').length === 0) {
  notes.push('Receipt photo reading is off; the scan affordance is hidden and typed totals work.');
}
if ((app?.get('EXPO_PUBLIC_SENTRY_DSN') ?? '').length === 0)
  notes.push('No crash reporting at all.');
if ((app?.get('EXPO_PUBLIC_ONESIGNAL_APP_ID') ?? '').length === 0)
  notes.push('No push; journeys are inert.');

for (const note of notes) console.log(`  • ${note}`);

console.log(
  `\n${DIM}EXPO_PUBLIC_* values are inlined at BUILD time. After changing one, restart with\n` +
    `npx expo start --clear or you will debug a stale bundle.${RESET}`,
);
