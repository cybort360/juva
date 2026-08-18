import Purchases, { LOG_LEVEL } from 'react-native-purchases';

import { env } from '@/config/runtimeEnv';

import { getOrCreateAppUserId } from './identity';

export const JUVA_PLUS_ENTITLEMENT = 'juva_plus';

export type RevenueCatSetup = 'configured' | 'disabled';

let configured = false;

/**
 * Configures RevenueCat when, and only when, a usable public SDK key exists.
 *
 * Unsafe combinations (a Test Store key in a preview or production build, a
 * missing store key) are rejected during environment validation, which reports
 * them as issues and leaves the key undefined. This function therefore treats
 * "no key" as a normal, launchable state rather than an error.
 */
export async function configureRevenueCat(): Promise<RevenueCatSetup> {
  if (configured) return 'configured';
  if (!env.revenueCatApiKey) return 'disabled';

  const appUserID = await getOrCreateAppUserId();
  if (__DEV__) Purchases.setLogLevel(LOG_LEVEL.DEBUG);
  Purchases.configure({ apiKey: env.revenueCatApiKey, appUserID });
  configured = true;
  return 'configured';
}
