import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

/**
 * Whether the device currently has a network connection.
 *
 * Juva is usable offline by design — a started trip, its checklist and its prices
 * are all on the device — so this exists to *explain* rather than to block. It
 * tells the shopper why a new search cannot run, and it never disables Shop Mode.
 *
 * Implemented against the platform primitives already present rather than pulling
 * in a connectivity library: web has `navigator.onLine` plus online/offline
 * events, and on native an absent signal is treated as online, because guessing
 * "offline" would wrongly hide the search action.
 */
function initialOnline(): boolean {
  if (Platform.OS !== 'web') return true;
  const online = (globalThis.navigator as { onLine?: boolean } | undefined)?.onLine;
  return online === undefined ? true : online;
}

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(initialOnline);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const goOnline = (): void => setOnline(true);
    const goOffline = (): void => setOnline(false);
    globalThis.addEventListener?.('online', goOnline);
    globalThis.addEventListener?.('offline', goOffline);
    return () => {
      globalThis.removeEventListener?.('online', goOnline);
      globalThis.removeEventListener?.('offline', goOffline);
    };
  }, []);

  return online;
}
