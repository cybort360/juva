import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * Haptics, mapped to what the shopper just did rather than to a generic "tap".
 *
 * Every call is fire-and-forget and swallows its own failure: haptics are not
 * available on web, are absent on some Android hardware, and a device that cannot
 * buzz must never break a shopping flow. Nothing here is awaited.
 */

const supported = Platform.OS === 'ios' || Platform.OS === 'android';

function fire(run: () => Promise<void>): void {
  if (!supported) return;
  void run().catch(() => undefined);
}

/** A control was pressed. The lightest possible acknowledgement. */
export function hapticTap(): void {
  fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

/** A choice changed: a segment, a plan card, a preference. */
export function hapticSelect(): void {
  fire(() => Haptics.selectionAsync());
}

/** An item was collected in Shop Mode. Firmer than a tap: it changed the trip. */
export function hapticCollect(): void {
  fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
}

/** A trip completed, or savings were verified. The one celebratory cue. */
export function hapticSuccess(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}

/** Something could not be done: a failed search, an invalid price. */
export function hapticWarn(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
}
