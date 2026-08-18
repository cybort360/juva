/**
 * Juva environment resolution and validation.
 *
 * Rules this module exists to enforce:
 * - The app must always boot, even when every optional external service is
 *   unconfigured. Validation therefore never throws at import time; it records
 *   issues that the UI can surface.
 * - Demo market data must never be presented as live retailer data. When a
 *   remote market is requested but not configured, we fall back to the demo
 *   market *and* record an error issue so the fallback stays visible.
 *
 * `EXPO_PUBLIC_*` variables are inlined by babel at build time, so every one of
 * them must be read as a literal static member expression. Do not refactor
 * these reads into a dynamic lookup such as `process.env[key]`.
 */

export type JuvaEnvironment = 'demo' | 'development' | 'preview' | 'production';
export type MarketMode = 'demo' | 'remote';
export type IssueSeverity = 'error' | 'warning';

export interface EnvIssue {
  readonly key: string;
  readonly severity: IssueSeverity;
  readonly message: string;
}

export interface JuvaEnv {
  /** Which configuration profile this bundle was built for. */
  readonly environment: JuvaEnvironment;
  /** Market mode requested by configuration. */
  readonly requestedMarketMode: MarketMode;
  /** Market mode actually usable with the current configuration. */
  readonly marketMode: MarketMode;
  /** Normalized API origin without a trailing slash, when configured. */
  readonly apiBaseUrl: string | undefined;
  /** Public RevenueCat SDK key for this platform/profile, when configured. */
  readonly revenueCatApiKey: string | undefined;
  /** True when the resolved RevenueCat key is the Test Store key. */
  readonly revenueCatUsesTestStore: boolean;
  /** Sentry DSN. Absent means no crash or performance monitoring at all. */
  readonly sentryDsn: string | undefined;
  /** OneSignal app id. Absent means no push, and no lifecycle journeys. */
  readonly oneSignalAppId: string | undefined;
  readonly issues: readonly EnvIssue[];
}

const ENVIRONMENTS: readonly JuvaEnvironment[] = ['demo', 'development', 'preview', 'production'];
const MARKET_MODES: readonly MarketMode[] = ['demo', 'remote'];

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveEnvironment(raw: string | undefined, issues: EnvIssue[]): JuvaEnvironment {
  const value = clean(raw);
  if (!value) return 'development';
  if ((ENVIRONMENTS as readonly string[]).includes(value)) return value as JuvaEnvironment;
  issues.push({
    key: 'EXPO_PUBLIC_JUVA_ENV',
    severity: 'warning',
    message: `Unknown environment "${value}". Expected one of ${ENVIRONMENTS.join(', ')}. Falling back to development.`,
  });
  return 'development';
}

function resolveRequestedMarketMode(
  raw: string | undefined,
  environment: JuvaEnvironment,
  issues: EnvIssue[],
): MarketMode {
  const value = clean(raw);
  if (environment === 'demo') return 'demo';
  if (!value) return 'demo';
  if ((MARKET_MODES as readonly string[]).includes(value)) return value as MarketMode;
  issues.push({
    key: 'EXPO_PUBLIC_MARKET_MODE',
    severity: 'warning',
    message: `Unknown market mode "${value}". Expected one of ${MARKET_MODES.join(', ')}. Falling back to demo.`,
  });
  return 'demo';
}

function resolveApiBaseUrl(
  raw: string | undefined,
  environment: JuvaEnvironment,
  issues: EnvIssue[],
): string | undefined {
  const value = clean(raw);
  if (!value) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    issues.push({
      key: 'EXPO_PUBLIC_API_BASE_URL',
      severity: 'error',
      message: `"${value}" is not a valid absolute URL. Juva will ignore it.`,
    });
    return undefined;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    issues.push({
      key: 'EXPO_PUBLIC_API_BASE_URL',
      severity: 'error',
      message: `Unsupported protocol "${parsed.protocol}". Use http or https.`,
    });
    return undefined;
  }

  if (parsed.protocol === 'http:' && (environment === 'preview' || environment === 'production')) {
    issues.push({
      key: 'EXPO_PUBLIC_API_BASE_URL',
      severity: 'error',
      message: `${environment} builds must use https. Juva will ignore this plaintext endpoint.`,
    });
    return undefined;
  }

  return value.replace(/\/+$/, '');
}

interface RevenueCatKeys {
  readonly testStore: string | undefined;
  readonly ios: string | undefined;
  readonly android: string | undefined;
}

function resolveRevenueCat(
  keys: RevenueCatKeys,
  environment: JuvaEnvironment,
  platform: 'ios' | 'android' | 'other',
  issues: EnvIssue[],
): { apiKey: string | undefined; usesTestStore: boolean } {
  const storeKey =
    platform === 'ios' ? keys.ios : platform === 'android' ? keys.android : undefined;

  if (environment === 'production' || environment === 'preview') {
    if (!storeKey) {
      issues.push({
        key:
          platform === 'ios'
            ? 'EXPO_PUBLIC_REVENUECAT_IOS_API_KEY'
            : 'EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY',
        severity: environment === 'production' ? 'error' : 'warning',
        message: `No store SDK key for ${platform}. Juva Plus purchases are disabled in this build.`,
      });
      return { apiKey: undefined, usesTestStore: false };
    }
    if (keys.testStore && storeKey === keys.testStore) {
      issues.push({
        key: 'EXPO_PUBLIC_REVENUECAT_IOS_API_KEY',
        severity: 'error',
        message: `${environment} builds cannot use the RevenueCat Test Store key. Purchases are disabled.`,
      });
      return { apiKey: undefined, usesTestStore: false };
    }
    return { apiKey: storeKey, usesTestStore: false };
  }

  // demo + development: prefer the Test Store, fall back to a real store key.
  if (keys.testStore) return { apiKey: keys.testStore, usesTestStore: true };
  if (storeKey) return { apiKey: storeKey, usesTestStore: false };
  issues.push({
    key: 'EXPO_PUBLIC_REVENUECAT_TEST_API_KEY',
    severity: 'warning',
    message: 'RevenueCat is not configured. Juva runs with purchases disabled.',
  });
  return { apiKey: undefined, usesTestStore: false };
}

export interface RawEnvInput {
  readonly juvaEnv: string | undefined;
  readonly marketMode: string | undefined;
  readonly apiBaseUrl: string | undefined;
  readonly revenueCatTestKey: string | undefined;
  readonly revenueCatIosKey: string | undefined;
  readonly revenueCatAndroidKey: string | undefined;
  readonly sentryDsn: string | undefined;
  readonly oneSignalAppId: string | undefined;
  readonly platform: 'ios' | 'android' | 'other';
}

/** Pure resolver, exported so environment rules are directly testable. */
export function resolveEnv(input: RawEnvInput): JuvaEnv {
  const issues: EnvIssue[] = [];
  const environment = resolveEnvironment(input.juvaEnv, issues);
  const requestedMarketMode = resolveRequestedMarketMode(input.marketMode, environment, issues);
  const apiBaseUrl = resolveApiBaseUrl(input.apiBaseUrl, environment, issues);

  let marketMode = requestedMarketMode;
  if (requestedMarketMode === 'remote' && !apiBaseUrl) {
    issues.push({
      key: 'EXPO_PUBLIC_API_BASE_URL',
      severity: 'error',
      message:
        'Remote market mode needs EXPO_PUBLIC_API_BASE_URL. Juva is showing its demo market, clearly labelled as demo.',
    });
    marketMode = 'demo';
  }

  const revenueCat = resolveRevenueCat(
    {
      testStore: clean(input.revenueCatTestKey),
      ios: clean(input.revenueCatIosKey),
      android: clean(input.revenueCatAndroidKey),
    },
    environment,
    input.platform,
    issues,
  );

  const sentryDsn = clean(input.sentryDsn);
  const oneSignalAppId = clean(input.oneSignalAppId);

  /**
   * Monitoring and push are optional everywhere, but their absence in a store build
   * is worth saying out loud: a production release with no crash reporting is a
   * release whose failures nobody will hear about.
   */
  if (!sentryDsn && (environment === 'production' || environment === 'preview')) {
    issues.push({
      key: 'EXPO_PUBLIC_SENTRY_DSN',
      severity: 'warning',
      message: 'No Sentry DSN: this build reports no crashes or performance data.',
    });
  }

  return Object.freeze({
    environment,
    requestedMarketMode,
    marketMode,
    apiBaseUrl,
    revenueCatApiKey: revenueCat.apiKey,
    revenueCatUsesTestStore: revenueCat.usesTestStore,
    sentryDsn,
    oneSignalAppId,
    issues: Object.freeze(issues),
  });
}

export function blockingIssues(env: JuvaEnv): readonly EnvIssue[] {
  return env.issues.filter((issue) => issue.severity === 'error');
}
