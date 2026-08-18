import { Linking, Platform } from 'react-native';

import type { Store } from '@/domain/types';

/**
 * Hands a store off to the device's maps app.
 *
 * Coordinates are used when the store has them, because a name search can land
 * on a different branch of the same chain — the one thing Juva must never do,
 * since the whole plan is priced at one specific store. The address is only a
 * fallback, and the store name is passed as a label so the pin is recognisable.
 */
export async function openStoreInMaps(store: Store): Promise<boolean> {
  const label = encodeURIComponent(store.displayName || store.retailerName);
  const hasCoordinates = typeof store.latitude === 'number' && typeof store.longitude === 'number';

  const url = hasCoordinates
    ? Platform.select({
        // `q=label` with `ll` pins the exact coordinate rather than searching.
        ios: `maps://?daddr=${store.latitude},${store.longitude}&q=${label}`,
        android: `geo:${store.latitude},${store.longitude}?q=${store.latitude},${store.longitude}(${label})`,
        default: `https://www.google.com/maps/dir/?api=1&destination=${store.latitude},${store.longitude}`,
      })
    : Platform.select({
        ios: `maps://?daddr=${encodeURIComponent(store.address)}`,
        android: `geo:0,0?q=${encodeURIComponent(store.address)}`,
        default: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(store.address)}`,
      });

  if (!url) return false;

  try {
    const supported = await Linking.canOpenURL(url);
    if (supported) {
      await Linking.openURL(url);
      return true;
    }
    // A device without a native maps handler still gets the web fallback.
    const fallback = hasCoordinates
      ? `https://www.google.com/maps/dir/?api=1&destination=${store.latitude},${store.longitude}`
      : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(store.address)}`;
    await Linking.openURL(fallback);
    return true;
  } catch {
    return false;
  }
}

/** True when this store can be navigated to precisely rather than by name. */
export function hasPreciseLocation(store: Store): boolean {
  return typeof store.latitude === 'number' && typeof store.longitude === 'number';
}
