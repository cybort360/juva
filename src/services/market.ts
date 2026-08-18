import { env } from '@/config/runtimeEnv';
import { buildDemoSnapshot } from '@/domain/demoMarket';
import { isRemoteSnapshot, snapshotFromWire } from '@/domain/marketWire';
import type { GroceryList, MarketSnapshot, UserPreferences } from '@/domain/types';

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Loads the local market for a basket.
 *
 * In demo mode this is fully offline. In remote mode a failure is surfaced as an
 * error rather than being papered over with demo prices: substituting demo data
 * for a failed live lookup would present fabricated prices as real ones.
 */
export async function loadMarketSnapshot(
  list: GroceryList,
  preferences: UserPreferences,
): Promise<MarketSnapshot> {
  const apiBaseUrl = env.apiBaseUrl;
  if (env.marketMode !== 'remote' || !apiBaseUrl) return buildDemoSnapshot();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiBaseUrl}/v1/market/search`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        concepts: list.items.map((item) => item.concept),
        location: {
          label: preferences.location.label,
          postalCode: preferences.location.postalCode,
          latitude: preferences.location.latitude,
          longitude: preferences.location.longitude,
          countryCode: preferences.location.countryCode,
        },
        radiusMiles: preferences.radiusMiles,
        currency: list.currency,
        maxStores: Math.max(preferences.maxStores + 2, 4),
      }),
    });

    const payload = (await response.json()) as { data?: unknown; error?: string };
    if (!response.ok || !payload.data) {
      throw new Error(payload.error ?? 'Could not load local grocery prices.');
    }
    if (!isRemoteSnapshot(payload.data)) {
      throw new Error('Market API response is missing stores, products or fetchedAt.');
    }

    return snapshotFromWire(payload.data);
  } catch (caught) {
    if (caught instanceof Error && caught.name === 'AbortError') {
      throw new Error('The market lookup timed out. Check your connection and try again.');
    }
    throw caught;
  } finally {
    clearTimeout(timeout);
  }
}
