import assert from 'node:assert/strict';
import { test } from 'node:test';

import { blockingIssues, resolveEnv, type RawEnvInput } from '../src/config/env';

const base: RawEnvInput = {
  juvaEnv: undefined,
  marketMode: undefined,
  apiBaseUrl: undefined,
  revenueCatTestKey: undefined,
  revenueCatIosKey: undefined,
  revenueCatAndroidKey: undefined,
  sentryDsn: undefined,
  oneSignalAppId: undefined,
  platform: 'ios',
};

test('an entirely unconfigured build still resolves to something launchable', () => {
  const env = resolveEnv(base);
  assert.equal(env.environment, 'development');
  assert.equal(env.marketMode, 'demo');
  assert.equal(env.apiBaseUrl, undefined);
  assert.equal(env.revenueCatApiKey, undefined);
  assert.deepEqual(blockingIssues(env), [], 'nothing missing is fatal');
});

test('the demo profile forces the demo market even if remote is requested', () => {
  const env = resolveEnv({
    ...base,
    juvaEnv: 'demo',
    marketMode: 'remote',
    apiBaseUrl: 'https://api.example.com',
  });
  assert.equal(env.requestedMarketMode, 'demo');
  assert.equal(env.marketMode, 'demo');
});

test('an unknown environment falls back to development with a warning', () => {
  const env = resolveEnv({ ...base, juvaEnv: 'staging' });
  assert.equal(env.environment, 'development');
  assert.ok(env.issues.some((issue) => issue.key === 'EXPO_PUBLIC_JUVA_ENV'));
  assert.deepEqual(blockingIssues(env), []);
});

test('remote mode without an API URL degrades to demo and says so loudly', () => {
  const env = resolveEnv({ ...base, juvaEnv: 'development', marketMode: 'remote' });
  assert.equal(env.requestedMarketMode, 'remote');
  assert.equal(env.marketMode, 'demo', 'never present demo prices as a live lookup');
  assert.ok(blockingIssues(env).some((issue) => issue.key === 'EXPO_PUBLIC_API_BASE_URL'));
});

test('a malformed API URL is rejected rather than used', () => {
  const env = resolveEnv({ ...base, marketMode: 'remote', apiBaseUrl: 'not-a-url' });
  assert.equal(env.apiBaseUrl, undefined);
  assert.equal(env.marketMode, 'demo');
});

test('trailing slashes are normalized away', () => {
  const env = resolveEnv({ ...base, apiBaseUrl: 'https://api.example.com///' });
  assert.equal(env.apiBaseUrl, 'https://api.example.com');
});

test('plaintext http is allowed in development but not in preview or production', () => {
  const dev = resolveEnv({ ...base, juvaEnv: 'development', apiBaseUrl: 'http://localhost:8787' });
  assert.equal(dev.apiBaseUrl, 'http://localhost:8787');

  for (const juvaEnv of ['preview', 'production'] as const) {
    const env = resolveEnv({
      ...base,
      juvaEnv,
      marketMode: 'remote',
      apiBaseUrl: 'http://api.example.com',
      revenueCatIosKey: 'appl_live',
    });
    assert.equal(env.apiBaseUrl, undefined, `${juvaEnv} rejects http`);
    assert.ok(blockingIssues(env).length > 0);
  }
});

test('development prefers the RevenueCat Test Store key', () => {
  const env = resolveEnv({
    ...base,
    juvaEnv: 'development',
    revenueCatTestKey: 'test_key',
    revenueCatIosKey: 'appl_live',
  });
  assert.equal(env.revenueCatApiKey, 'test_key');
  assert.equal(env.revenueCatUsesTestStore, true);
});

test('production refuses the Test Store key instead of shipping it', () => {
  const env = resolveEnv({
    ...base,
    juvaEnv: 'production',
    marketMode: 'remote',
    apiBaseUrl: 'https://api.example.com',
    revenueCatTestKey: 'test_key',
    revenueCatIosKey: 'test_key',
  });
  assert.equal(env.revenueCatApiKey, undefined);
  assert.ok(blockingIssues(env).some((issue) => issue.message.includes('Test Store')));
});

test('production uses the real store key for the current platform', () => {
  const ios = resolveEnv({
    ...base,
    juvaEnv: 'production',
    marketMode: 'remote',
    apiBaseUrl: 'https://api.example.com',
    revenueCatIosKey: 'appl_live',
    revenueCatAndroidKey: 'goog_live',
  });
  assert.equal(ios.revenueCatApiKey, 'appl_live');
  assert.equal(ios.revenueCatUsesTestStore, false);
  assert.deepEqual(blockingIssues(ios), []);

  const android = resolveEnv({
    ...base,
    platform: 'android',
    juvaEnv: 'production',
    marketMode: 'remote',
    apiBaseUrl: 'https://api.example.com',
    revenueCatIosKey: 'appl_live',
    revenueCatAndroidKey: 'goog_live',
  });
  assert.equal(android.revenueCatApiKey, 'goog_live');
});

test('a production build with no store key reports a blocking issue', () => {
  const env = resolveEnv({
    ...base,
    juvaEnv: 'production',
    marketMode: 'remote',
    apiBaseUrl: 'https://api.example.com',
  });
  assert.equal(env.revenueCatApiKey, undefined);
  assert.ok(blockingIssues(env).length > 0);
});

test('blank strings are treated as unset, not as values', () => {
  const env = resolveEnv({
    ...base,
    juvaEnv: '   ',
    marketMode: '',
    apiBaseUrl: '  ',
    revenueCatTestKey: '   ',
  });
  assert.equal(env.environment, 'development');
  assert.equal(env.marketMode, 'demo');
  assert.equal(env.apiBaseUrl, undefined);
  assert.equal(env.revenueCatApiKey, undefined);
});

test('the resolved environment is frozen', () => {
  const env = resolveEnv(base);
  assert.throws(() => {
    (env as { environment: string }).environment = 'production';
  });
});
