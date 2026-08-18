import { Platform } from 'react-native';

import { resolveEnv, type JuvaEnv } from './env';

/**
 * The single place where Juva touches `process.env`.
 *
 * Every read below is a literal static member expression because the Expo babel
 * plugin inlines `EXPO_PUBLIC_*` values at build time. A dynamic lookup would
 * resolve to `undefined` in a release bundle.
 */
export const env: JuvaEnv = resolveEnv({
  juvaEnv: process.env.EXPO_PUBLIC_JUVA_ENV,
  marketMode: process.env.EXPO_PUBLIC_MARKET_MODE,
  apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL,
  revenueCatTestKey: process.env.EXPO_PUBLIC_REVENUECAT_TEST_API_KEY,
  revenueCatIosKey: process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY,
  revenueCatAndroidKey: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY,
  sentryDsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
  oneSignalAppId: process.env.EXPO_PUBLIC_ONESIGNAL_APP_ID,
  platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'other',
});

export const isDemoMarket = env.marketMode === 'demo';
